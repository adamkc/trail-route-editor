/**
 * vertex-editor.js — Vertex drag interaction for trail editing
 */
const VertexEditor = (() => {
  let map = null;
  let trailData = null;      // The full trails GeoJSON FeatureCollection
  let vertexData = null;      // GeoJSON points for all vertices
  let trailElevations = {};   // { trailName: [elev, elev, ...] }
  let trailMetrics = {};      // { trailName: { segments, summary } }
  let undoStack = [];
  let dragState = null;
  let selectedTrail = null;
  let onTrailUpdate = null;   // Callback when a trail is updated
  let frozenSets = {};        // { trailName: Set<vertexIndex> }
  let freezeRangeStart = null; // { trailName, vertexIndex } for shift+click range freeze

  function init(mapInstance, trails, callback) {
    map = mapInstance;
    trailData = trails;
    onTrailUpdate = callback;

    // Add vertex point source and layer
    vertexData = extractVertices(trailData);

    map.addSource('vertices', {
      type: 'geojson',
      data: vertexData
    });

    // Vertex circles: small dots along trails
    map.addLayer({
      id: 'vertex-circles',
      type: 'circle',
      source: 'vertices',
      paint: {
        'circle-radius': [
          'case',
          ['boolean', ['get', 'selected'], false], 7,
          ['boolean', ['get', 'frozen'], false], 5,
          4
        ],
        'circle-color': [
          'case',
          ['boolean', ['get', 'selected'], false], '#e94560',
          ['boolean', ['get', 'frozen'], false], '#2196F3',
          '#ffffff'
        ],
        'circle-stroke-color': [
          'case',
          ['boolean', ['get', 'frozen'], false], '#0D47A1',
          '#333'
        ],
        'circle-stroke-width': [
          'case',
          ['boolean', ['get', 'frozen'], false], 2,
          1.5
        ],
        'circle-opacity': [
          'case',
          ['boolean', ['get', 'visible'], true], 1,
          0
        ],
        'circle-stroke-opacity': [
          'case',
          ['boolean', ['get', 'visible'], true], 1,
          0
        ]
      }
    });

    // Keep hover-point layers on top of everything (including vertex circles)
    if (map.getLayer('hover-point-outer')) map.moveLayer('hover-point-outer');
    if (map.getLayer('hover-point-inner')) map.moveLayer('hover-point-inner');

    // Interaction handlers
    map.on('mouseenter', 'vertex-circles', (e) => {
      const hasVisible = e.features && e.features.some(f => f.properties.visible);
      if (hasVisible) map.getCanvas().style.cursor = 'grab';
    });
    map.on('mouseleave', 'vertex-circles', () => {
      if (!dragState) map.getCanvas().style.cursor = '';
    });

    map.on('mousedown', 'vertex-circles', onMouseDown);

    // Right-click: delete vertex or add vertex on segment
    map.on('contextmenu', onRightClick);
  }

  function extractVertices(trailsGeoJson) {
    const features = [];
    for (const feature of trailsGeoJson.features) {
      const coords = feature.geometry.coordinates;
      const name = feature.properties.Name || feature.properties.name || 'unknown';
      const frozenSet = frozenSets[name] || new Set();
      coords.forEach((coord, i) => {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [coord[0], coord[1]] },
          properties: {
            trailName: name,
            vertexIndex: i,
            selected: false,
            frozen: frozenSet.has(i),
            visible: selectedTrail === null || selectedTrail === '__all__' || selectedTrail === name
          }
        });
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function onMouseDown(e) {
    if (e.originalEvent.button !== 0) return; // left click only

    // Only grab visible vertices (skip hidden vertices from non-selected trails)
    const feature = e.features.find(f => f.properties.visible);
    if (!feature) return;

    const trailName = feature.properties.trailName;
    const vertexIndex = feature.properties.vertexIndex;

    // Shift+click: toggle freeze / range-freeze
    if (e.originalEvent.shiftKey) {
      e.preventDefault();
      handleFreezeClick(trailName, vertexIndex);
      return;
    }

    e.preventDefault();

    // Don't allow dragging frozen vertices
    if (frozenSets[trailName] && frozenSets[trailName].has(vertexIndex)) {
      setStatus(`Vertex ${vertexIndex} is frozen — shift+click to unfreeze`);
      return;
    }

    // Save undo state
    const trail = findTrail(trailName);
    if (trail) {
      undoStack.push({
        action: 'move',
        trailName,
        vertexIndex,
        oldCoord: [...trail.geometry.coordinates[vertexIndex]],
        oldElev: trailElevations[trailName] ? trailElevations[trailName][vertexIndex] : null
      });
    }

    dragState = { trailName, vertexIndex };
    map.getCanvas().style.cursor = 'grabbing';

    // Disable map panning during drag
    map.dragPan.disable();

    map.on('mousemove', onDrag);
    map.once('mouseup', onDragEnd);
  }

  /**
   * Handle shift+click freeze toggling.
   * First shift+click: toggle one vertex and set it as range start.
   * Second shift+click on same trail: freeze/unfreeze the entire range between them.
   */
  function handleFreezeClick(trailName, vertexIndex) {
    if (!frozenSets[trailName]) frozenSets[trailName] = new Set();
    const frozenSet = frozenSets[trailName];

    // If we have a pending range start on the same trail, freeze the range
    if (freezeRangeStart && freezeRangeStart.trailName === trailName &&
        freezeRangeStart.vertexIndex !== vertexIndex) {
      const lo = Math.min(freezeRangeStart.vertexIndex, vertexIndex);
      const hi = Math.max(freezeRangeStart.vertexIndex, vertexIndex);

      // Determine whether to freeze or unfreeze the range
      // If the start vertex was frozen (we just froze it), freeze the range; otherwise unfreeze
      const shouldFreeze = frozenSet.has(freezeRangeStart.vertexIndex);

      for (let i = lo; i <= hi; i++) {
        if (shouldFreeze) frozenSet.add(i);
        else frozenSet.delete(i);
      }

      const action = shouldFreeze ? 'Froze' : 'Unfroze';
      setStatus(`${action} vertices ${lo}–${hi} on ${trailName} (${hi - lo + 1} vertices)`);
      freezeRangeStart = null;
    } else {
      // First click: toggle this vertex and set as range start
      if (frozenSet.has(vertexIndex)) {
        frozenSet.delete(vertexIndex);
        setStatus(`Unfroze vertex ${vertexIndex} — shift+click another to unfreeze range`);
      } else {
        frozenSet.add(vertexIndex);
        setStatus(`Froze vertex ${vertexIndex} — shift+click another to freeze range`);
      }
      freezeRangeStart = { trailName, vertexIndex };
    }

    // Refresh vertex display
    vertexData = extractVertices(trailData);
    const vertSrc = map.getSource('vertices');
    if (vertSrc) vertSrc.setData(vertexData);
  }

  function onDrag(e) {
    if (!dragState) return;

    const { trailName, vertexIndex } = dragState;
    const lngLat = [e.lngLat.lng, e.lngLat.lat];

    // Update trail coordinate
    const trail = findTrail(trailName);
    if (!trail) return;
    trail.geometry.coordinates[vertexIndex] = lngLat;

    // Update vertex point
    updateVertexPosition(trailName, vertexIndex, lngLat);

    // Update map sources (fast, no await)
    refreshMapSources();
  }

  async function onDragEnd(e) {
    map.off('mousemove', onDrag);
    map.dragPan.enable();
    map.getCanvas().style.cursor = '';

    if (!dragState) return;

    const { trailName, vertexIndex } = dragState;
    dragState = null;

    // Sample elevation at new position
    const trail = findTrail(trailName);
    if (!trail) return;

    const coord = trail.geometry.coordinates[vertexIndex];
    const elev = await DemSampler.sampleAtLngLat(coord[0], coord[1]);

    if (trailElevations[trailName]) {
      trailElevations[trailName][vertexIndex] = elev;
    }

    // Recompute metrics
    recomputeTrail(trailName);

    setStatus(`Moved vertex ${vertexIndex} — elev: ${elev != null ? elev.toFixed(1) + 'm' : 'N/A'}`);
  }

  // ── Right-click handler: delete vertex or add vertex on segment ──

  function onRightClick(e) {
    e.preventDefault();

    const point = e.point;
    // First check: did we right-click on an existing vertex?
    const vertexHits = map.queryRenderedFeatures(point, { layers: ['vertex-circles'] });
    if (vertexHits.length > 0) {
      const f = vertexHits[0];
      if (f.properties.visible) {
        deleteVertex(f.properties.trailName, f.properties.vertexIndex);
      }
      return;
    }

    // Second check: did we right-click on a trail line?
    const lineHits = map.queryRenderedFeatures(point, { layers: ['trail-lines'] });
    if (lineHits.length > 0) {
      const clickLngLat = [e.lngLat.lng, e.lngLat.lat];
      const trailFeature = lineHits[0];
      const trailName = trailFeature.properties.Name || trailFeature.properties.name;
      if (!trailName) return;

      // Find the nearest segment to insert after
      const trail = findTrail(trailName);
      if (!trail) return;
      const coords = trail.geometry.coordinates;
      const afterIndex = findNearestSegment(coords, clickLngLat);
      addVertex(trailName, afterIndex, clickLngLat);
    }
  }

  /**
   * Find the index of the segment start closest to a click point.
   * Returns i such that the click is nearest to segment [i, i+1].
   */
  function findNearestSegment(coords, lngLat) {
    let bestDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const d = pointToSegmentDist(lngLat, coords[i], coords[i + 1]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /** Squared distance from point p to segment a-b (in lng/lat, fine for short segments) */
  function pointToSegmentDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = a[0] + t * dx, projY = a[1] + t * dy;
    return Math.hypot(p[0] - projX, p[1] - projY);
  }

  // ── Add / Delete vertex ──

  async function addVertex(trailName, afterIndex, lngLat) {
    const trail = findTrail(trailName);
    if (!trail) return;

    const insertIndex = afterIndex + 1;

    // Insert coordinate
    trail.geometry.coordinates.splice(insertIndex, 0, [lngLat[0], lngLat[1]]);

    // Sample elevation
    const elev = await DemSampler.sampleAtLngLat(lngLat[0], lngLat[1]);
    if (trailElevations[trailName]) {
      trailElevations[trailName].splice(insertIndex, 0, elev);
    }

    // Push undo entry
    undoStack.push({ action: 'add', trailName, vertexIndex: insertIndex });

    // Rebuild vertex features and refresh
    vertexData = extractVertices(trailData);
    refreshMapSources();
    recomputeTrail(trailName);
    setStatus(`Added vertex at index ${insertIndex} — elev: ${elev != null ? elev.toFixed(1) + 'm' : 'N/A'}`);
  }

  function deleteVertex(trailName, vertexIndex) {
    const trail = findTrail(trailName);
    if (!trail) return;

    // Guard: need at least 2 coords for a line
    if (trail.geometry.coordinates.length <= 2) {
      setStatus('Cannot delete — trail must have at least 2 vertices');
      return;
    }

    // Save for undo
    const oldCoord = [...trail.geometry.coordinates[vertexIndex]];
    const oldElev = trailElevations[trailName] ? trailElevations[trailName][vertexIndex] : null;

    // Remove coordinate
    trail.geometry.coordinates.splice(vertexIndex, 1);

    // Remove elevation
    if (trailElevations[trailName]) {
      trailElevations[trailName].splice(vertexIndex, 1);
    }

    // Push undo entry
    undoStack.push({ action: 'delete', trailName, vertexIndex, oldCoord, oldElev });

    // Rebuild vertex features and refresh
    vertexData = extractVertices(trailData);
    refreshMapSources();
    recomputeTrail(trailName);
    setStatus(`Deleted vertex ${vertexIndex} from ${trailName}`);
  }

  function findTrail(name) {
    return trailData.features.find(f =>
      (f.properties.Name || f.properties.name) === name
    );
  }

  function updateVertexPosition(trailName, vertexIndex, lngLat) {
    const vf = vertexData.features.find(f =>
      f.properties.trailName === trailName && f.properties.vertexIndex === vertexIndex
    );
    if (vf) {
      vf.geometry.coordinates = [lngLat[0], lngLat[1]];
    }
  }

  function refreshMapSources() {
    const trailSrc = map.getSource('trails');
    if (trailSrc) trailSrc.setData(trailData);

    const vertSrc = map.getSource('vertices');
    if (vertSrc) vertSrc.setData(vertexData);
  }

  function recomputeTrail(trailName) {
    const trail = findTrail(trailName);
    if (!trail || !trailElevations[trailName]) return;

    const coords = trail.geometry.coordinates;
    const elevs = trailElevations[trailName];
    const result = TrailMetrics.compute(coords, elevs);

    trailMetrics[trailName] = result;

    if (onTrailUpdate) {
      onTrailUpdate(trailName, result);
    }
  }

  /**
   * Initialize elevations for all trails by sampling DEM
   */
  async function loadElevations() {
    setStatus('Sampling elevations from DEM...');
    let totalVerts = 0;

    for (const feature of trailData.features) {
      const name = feature.properties.Name || feature.properties.name || 'unknown';
      const coords = feature.geometry.coordinates;
      const elevs = await DemSampler.sampleBatch(coords);
      trailElevations[name] = elevs;
      totalVerts += coords.length;

      // Compute initial metrics
      const result = TrailMetrics.compute(coords, elevs);
      trailMetrics[name] = result;
    }

    setStatus(`Loaded elevations for ${totalVerts} vertices`);
    return trailMetrics;
  }

  function selectTrail(trailName) {
    selectedTrail = trailName;
    // Update vertex visibility
    vertexData = extractVertices(trailData);
    const vertSrc = map.getSource('vertices');
    if (vertSrc) vertSrc.setData(vertexData);
  }

  function undo() {
    if (undoStack.length === 0) return;
    const entry = undoStack.pop();

    const trail = findTrail(entry.trailName);
    if (!trail) return;

    if (entry.action === 'move' || !entry.action) {
      // Restore coordinate
      trail.geometry.coordinates[entry.vertexIndex] = entry.oldCoord;
      updateVertexPosition(entry.trailName, entry.vertexIndex, entry.oldCoord);
      // Restore elevation
      if (trailElevations[entry.trailName] && entry.oldElev != null) {
        trailElevations[entry.trailName][entry.vertexIndex] = entry.oldElev;
      }
      setStatus(`Undone move of vertex ${entry.vertexIndex} on ${entry.trailName}`);

    } else if (entry.action === 'add') {
      // Undo add → remove the inserted vertex
      trail.geometry.coordinates.splice(entry.vertexIndex, 1);
      if (trailElevations[entry.trailName]) {
        trailElevations[entry.trailName].splice(entry.vertexIndex, 1);
      }
      vertexData = extractVertices(trailData);
      setStatus(`Undone add of vertex ${entry.vertexIndex} on ${entry.trailName}`);

    } else if (entry.action === 'delete') {
      // Undo delete → re-insert the removed vertex
      trail.geometry.coordinates.splice(entry.vertexIndex, 0, entry.oldCoord);
      if (trailElevations[entry.trailName] && entry.oldElev != null) {
        trailElevations[entry.trailName].splice(entry.vertexIndex, 0, entry.oldElev);
      }
      vertexData = extractVertices(trailData);
      setStatus(`Undone delete of vertex ${entry.vertexIndex} on ${entry.trailName}`);

    } else if (entry.action === 'optimize') {
      // Undo optimize → restore entire coord + elev arrays
      trail.geometry.coordinates = entry.oldCoords;
      trailElevations[entry.trailName] = entry.oldElevs;
      vertexData = extractVertices(trailData);
      setStatus(`Undone optimization of ${entry.trailName}`);
    }

    refreshMapSources();
    recomputeTrail(entry.trailName);
  }

  /**
   * Replace trail coords + elevations (used by optimizer).
   * If pushUndo is true, saves old state for Ctrl+Z.
   */
  function setTrailCoords(trailName, newCoords, newElevs, pushUndo, oldCoords, oldElevs) {
    const trail = findTrail(trailName);
    if (!trail) return;

    if (pushUndo && oldCoords && oldElevs) {
      undoStack.push({
        action: 'optimize',
        trailName,
        oldCoords: oldCoords.map(c => [...c]),
        oldElevs: [...oldElevs]
      });
    }

    trail.geometry.coordinates = newCoords.map(c => [...c]);
    trailElevations[trailName] = [...newElevs];

    vertexData = extractVertices(trailData);
    refreshMapSources();
    recomputeTrail(trailName);
  }

  /**
   * Live-update trail geometry during optimization (no undo, no metrics recompute).
   * Just updates the map for visual feedback.
   */
  function setTrailCoordsLive(trailName, newCoords) {
    const trail = findTrail(trailName);
    if (!trail) return;
    trail.geometry.coordinates = newCoords.map(c => [...c]);
    const trailSrc = map.getSource('trails');
    if (trailSrc) trailSrc.setData(trailData);
  }

  /**
   * Add a new trail feature to the dataset (used by optimizer to create "- Optimized" trail).
   */
  function addTrailFeature(name, coords) {
    const feature = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords.map(c => [...c]) },
      properties: { Name: name }
    };
    trailData.features.push(feature);
    // Initialize empty elevations (will be set later)
    trailElevations[name] = coords.map(() => null);
    vertexData = extractVertices(trailData);
    refreshMapSources();
  }

  /**
   * Remove a trail feature by name (used to clean up aborted optimization).
   */
  function removeTrailFeature(name) {
    trailData.features = trailData.features.filter(f =>
      (f.properties.Name || f.properties.name) !== name
    );
    delete trailElevations[name];
    delete trailMetrics[name];
    vertexData = extractVertices(trailData);
    refreshMapSources();
  }

  function getTrailData() { return trailData; }
  function getMetrics(name) { return trailMetrics[name]; }
  function getAllMetrics() { return trailMetrics; }
  function getElevations(name) { return trailElevations[name]; }

  // ── Freeze API ──

  /**
   * Get the frozen vertex indices for a trail as an array of booleans.
   * Returns array of length = coords.length, true if frozen.
   */
  function getFrozenArray(trailName) {
    const trail = findTrail(trailName);
    if (!trail) return [];
    const frozenSet = frozenSets[trailName] || new Set();
    return trail.geometry.coordinates.map((_, i) => frozenSet.has(i));
  }

  /**
   * Freeze vertices by grade threshold: freeze all vertices where
   * the absolute grade of both adjacent segments is below the threshold.
   */
  function freezeByGrade(trailName, maxGradePct) {
    const metrics = trailMetrics[trailName];
    if (!metrics || !metrics.segments) return 0;
    const trail = findTrail(trailName);
    if (!trail) return 0;

    if (!frozenSets[trailName]) frozenSets[trailName] = new Set();
    const frozenSet = frozenSets[trailName];
    const segs = metrics.segments;
    let count = 0;

    // First and last are always frozen (endpoints)
    frozenSet.add(0);
    frozenSet.add(trail.geometry.coordinates.length - 1);

    for (let i = 1; i < trail.geometry.coordinates.length - 1; i++) {
      // Check segments on both sides of vertex i (seg[i-1] is before, seg[i] is after)
      const segBefore = segs[i - 1];
      const segAfter = segs[i];
      if (!segBefore || !segAfter) continue;

      if (segBefore.absGradePct <= maxGradePct && segAfter.absGradePct <= maxGradePct) {
        if (!frozenSet.has(i)) {
          frozenSet.add(i);
          count++;
        }
      }
    }

    // Refresh vertex display
    vertexData = extractVertices(trailData);
    const vertSrc = map.getSource('vertices');
    if (vertSrc) vertSrc.setData(vertexData);

    return count;
  }

  /**
   * Clear all frozen vertices for a trail.
   */
  function clearFrozen(trailName) {
    if (frozenSets[trailName]) {
      frozenSets[trailName].clear();
    }
    vertexData = extractVertices(trailData);
    const vertSrc = map.getSource('vertices');
    if (vertSrc) vertSrc.setData(vertexData);
  }

  function getFrozenCount(trailName) {
    return frozenSets[trailName] ? frozenSets[trailName].size : 0;
  }

  function setStatus(msg) {
    const el = document.getElementById('status-bar');
    if (el) el.textContent = msg;
  }

  return {
    init, loadElevations, selectTrail, undo,
    getTrailData, getMetrics, getAllMetrics, getElevations,
    recomputeTrail, refreshMapSources,
    setTrailCoords, setTrailCoordsLive,
    addTrailFeature, removeTrailFeature,
    getFrozenArray, freezeByGrade, clearFrozen, getFrozenCount
  };
})();
