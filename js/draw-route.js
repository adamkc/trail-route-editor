/**
 * draw-route.js — Draw new routes by clicking on the map
 *
 * Enter draw mode → click to add vertices → double-click or Enter to finish.
 * Escape cancels. Shows a live preview line + vertex dots while drawing.
 * Hover tooltip shows segment length, elevation change, and slope %.
 */
const DrawRoute = (() => {
  let active = false;
  let coords = [];        // [lng, lat] pairs
  let elevs = [];         // elevation at each placed vertex
  let routeName = '';
  let onFinish = null;     // callback(name, coords) when route is completed
  let onCancelCb = null;   // callback() when drawing is cancelled
  let mapInstance = null;
  let tooltipEl = null;
  let totalDist = 0;       // cumulative distance of placed vertices

  const SOURCE_ID = 'draw-preview';
  const LINE_LAYER = 'draw-preview-line';
  const POINT_LAYER = 'draw-preview-points';

  function init(map) {
    mapInstance = map;
    tooltipEl = document.getElementById('elev-tooltip');

    // Add empty source + layers for live preview
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: emptyFC()
    });

    map.addLayer({
      id: LINE_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', '$type', 'LineString'],
      paint: {
        'line-color': '#00ff88',
        'line-width': 3,
        'line-dasharray': [3, 2]
      }
    });

    map.addLayer({
      id: POINT_LAYER,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', '$type', 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#00ff88',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5
      }
    });

    // Hide by default
    map.setLayoutProperty(LINE_LAYER, 'visibility', 'none');
    map.setLayoutProperty(POINT_LAYER, 'visibility', 'none');
  }

  function emptyFC() {
    return { type: 'FeatureCollection', features: [] };
  }

  /**
   * Sample elevation at a [lng, lat] coordinate.
   */
  function sampleElev(lngLat) {
    if (typeof RoiSampler !== 'undefined' && RoiSampler.isLoaded()) {
      return RoiSampler.sampleAtLngLat(lngLat[0], lngLat[1]);
    }
    return null;
  }

  function start(name, callback, cancelCallback) {
    if (active) return;
    if (!mapInstance) { console.error('[Draw] Map not initialized'); return; }

    active = true;
    coords = [];
    elevs = [];
    totalDist = 0;
    routeName = name;
    onFinish = callback;
    onCancelCb = cancelCallback || null;

    // Show preview layers
    mapInstance.setLayoutProperty(LINE_LAYER, 'visibility', 'visible');
    mapInstance.setLayoutProperty(POINT_LAYER, 'visibility', 'visible');
    updatePreview();

    // Change cursor
    mapInstance.getCanvas().style.cursor = 'crosshair';

    // Bind handlers
    mapInstance.on('click', handleClick);
    mapInstance.on('dblclick', handleDblClick);
    mapInstance.on('mousemove', handleMouseMove);
    document.addEventListener('keydown', handleKey);

    // Prevent map dblclick zoom
    mapInstance.doubleClickZoom.disable();
  }

  function handleClick(e) {
    if (!active) return;
    const pt = [e.lngLat.lng, e.lngLat.lat];

    // Track cumulative distance
    if (coords.length > 0) {
      totalDist += Projection.distanceM(coords[coords.length - 1], pt);
    }

    coords.push(pt);
    elevs.push(sampleElev(pt));
    updatePreview();
  }

  function handleDblClick(e) {
    if (!active) return;
    e.preventDefault();
    // The dblclick also fires two click events; the last vertex was just added.
    // Remove the duplicate last point if coords has 2+ identical at the end
    if (coords.length >= 2) {
      const last = coords[coords.length - 1];
      const prev = coords[coords.length - 2];
      if (Math.abs(last[0] - prev[0]) < 1e-8 && Math.abs(last[1] - prev[1]) < 1e-8) {
        coords.pop();
        elevs.pop();
        // Recompute totalDist
        totalDist = 0;
        for (let i = 1; i < coords.length; i++) {
          totalDist += Projection.distanceM(coords[i - 1], coords[i]);
        }
      }
    }
    finish();
  }

  // Rubberband: show a line from last vertex to cursor + tooltip
  let rubberCoord = null;
  function handleMouseMove(e) {
    if (!active) return;
    rubberCoord = [e.lngLat.lng, e.lngLat.lat];

    if (coords.length > 0) {
      updatePreview();
      updateTooltip(e.point);
    } else {
      // No vertices yet — show elevation at cursor
      updateTooltipBare(e.point);
    }
  }

  /**
   * Show tooltip with segment info relative to last placed vertex.
   */
  function updateTooltip(screenPoint) {
    if (!tooltipEl) return;

    const lastCoord = coords[coords.length - 1];
    const lastElev = elevs[elevs.length - 1];
    const cursorElev = sampleElev(rubberCoord);

    // Segment distance from last vertex to cursor
    const segDist = Projection.distanceM(lastCoord, rubberCoord);
    // Cumulative distance including this rubber segment
    const cumDist = totalDist + segDist;

    // Build tooltip lines
    const lines = [];

    // Elevation at cursor
    if (cursorElev != null) {
      lines.push(`Elev: ${Math.round(cursorElev)}m`);
    }

    // Segment info (from last vertex)
    if (segDist > 0) {
      let segLine = `Seg: ${formatDist(segDist)}`;
      if (lastElev != null && cursorElev != null) {
        const de = cursorElev - lastElev;
        const slope = (de / segDist) * 100;
        segLine += ` | ${de >= 0 ? '+' : ''}${de.toFixed(1)}m | ${slope.toFixed(1)}%`;
      }
      lines.push(segLine);
    }

    // Cumulative distance
    if (coords.length >= 1) {
      lines.push(`Total: ${formatDist(cumDist)} (${coords.length} pts)`);
    }

    tooltipEl.innerHTML = lines.join('<br>');
    tooltipEl.classList.remove('hidden');
    positionTooltip(screenPoint);
  }

  /**
   * Show just elevation at cursor when no vertices placed yet.
   */
  function updateTooltipBare(screenPoint) {
    if (!tooltipEl) return;
    const elev = sampleElev(rubberCoord);
    if (elev != null) {
      tooltipEl.textContent = `Elev: ${Math.round(elev)}m`;
      tooltipEl.classList.remove('hidden');
      positionTooltip(screenPoint);
    } else {
      tooltipEl.classList.add('hidden');
    }
  }

  function positionTooltip(screenPoint) {
    if (!tooltipEl) return;
    tooltipEl.style.left = (screenPoint.x + 15) + 'px';
    tooltipEl.style.top = (screenPoint.y - 15) + 'px';
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.classList.add('hidden');
  }

  function formatDist(meters) {
    if (meters >= 1000) return (meters / 1000).toFixed(2) + 'km';
    return Math.round(meters) + 'm';
  }

  function handleKey(e) {
    if (!active) return;
    if (e.key === 'Enter') {
      finish();
    } else if (e.key === 'Escape') {
      cancel();
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
      // Undo last point
      if (coords.length > 0) {
        coords.pop();
        elevs.pop();
        // Recompute totalDist
        totalDist = 0;
        for (let i = 1; i < coords.length; i++) {
          totalDist += Projection.distanceM(coords[i - 1], coords[i]);
        }
        updatePreview();
      }
    }
  }

  function updatePreview() {
    const features = [];

    // Line (with rubberband to cursor)
    const lineCoords = [...coords];
    if (rubberCoord && coords.length > 0) {
      lineCoords.push(rubberCoord);
    }
    if (lineCoords.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: lineCoords }
      });
    }

    // Points for each placed vertex
    for (let i = 0; i < coords.length; i++) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords[i] },
        properties: { index: i }
      });
    }

    mapInstance.getSource(SOURCE_ID).setData({
      type: 'FeatureCollection',
      features
    });
  }

  function finish() {
    if (coords.length < 2) {
      cancel();
      return;
    }

    const finalCoords = coords.map(c => [...c]);
    const name = routeName;
    const cb = onFinish;
    cleanup();

    if (cb) {
      cb(name, finalCoords);
    }
  }

  function cancel() {
    const cb = onCancelCb;
    cleanup();
    if (cb) cb();
  }

  function cleanup() {
    active = false;
    coords = [];
    elevs = [];
    totalDist = 0;
    rubberCoord = null;

    hideTooltip();

    if (mapInstance) {
      mapInstance.off('click', handleClick);
      mapInstance.off('dblclick', handleDblClick);
      mapInstance.off('mousemove', handleMouseMove);
      mapInstance.getCanvas().style.cursor = '';
      mapInstance.doubleClickZoom.enable();

      // Hide and clear preview
      mapInstance.setLayoutProperty(LINE_LAYER, 'visibility', 'none');
      mapInstance.setLayoutProperty(POINT_LAYER, 'visibility', 'none');
      mapInstance.getSource(SOURCE_ID).setData(emptyFC());
    }

    document.removeEventListener('keydown', handleKey);
    onFinish = null;
    onCancelCb = null;
  }

  function isActive() { return active; }

  return { init, start, cancel, isActive };
})();
