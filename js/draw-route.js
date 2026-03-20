/**
 * draw-route.js — Draw new routes by clicking on the map
 *
 * Enter draw mode → click to add vertices → double-click or Enter to finish.
 * Escape cancels. Shows a live preview line + vertex dots while drawing.
 */
const DrawRoute = (() => {
  let active = false;
  let coords = [];        // [lng, lat] pairs
  let routeName = '';
  let onFinish = null;     // callback(name, coords) when route is completed
  let onCancelCb = null;   // callback() when drawing is cancelled
  let mapInstance = null;

  const SOURCE_ID = 'draw-preview';
  const LINE_LAYER = 'draw-preview-line';
  const POINT_LAYER = 'draw-preview-points';

  function init(map) {
    mapInstance = map;

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

  function start(name, callback, cancelCallback) {
    if (active) return;
    if (!mapInstance) { console.error('[Draw] Map not initialized'); return; }

    active = true;
    coords = [];
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
    coords.push([e.lngLat.lng, e.lngLat.lat]);
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
      }
    }
    finish();
  }

  // Rubberband: show a line from last vertex to cursor
  let rubberCoord = null;
  function handleMouseMove(e) {
    if (!active || coords.length === 0) return;
    rubberCoord = [e.lngLat.lng, e.lngLat.lat];
    updatePreview();
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
    rubberCoord = null;

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
