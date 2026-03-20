/**
 * app.js — Main entry point, wires everything together
 */
(async function() {
  const status = (msg) => {
    const el = document.getElementById('status-bar');
    if (el) el.textContent = msg;
    console.log('[app]', msg);
  };

  let map, trailData, selector;
  let trailNames = [];
  let demLoaded = false;

  // ---- Splash screen ----
  const splashOverlay = document.getElementById('splash-overlay');
  const splashClose = document.getElementById('splash-close');
  const splashDontShow = document.getElementById('splash-dont-show');
  const btnGuide = document.getElementById('btn-guide');

  function showSplash() {
    if (splashOverlay) splashOverlay.classList.remove('hidden');
  }
  function hideSplash() {
    if (splashOverlay) splashOverlay.classList.add('hidden');
    if (splashDontShow && splashDontShow.checked) {
      try { localStorage.setItem('trail-editor-hide-splash', '1'); } catch (e) {}
    }
  }

  // Show on load unless previously dismissed
  if (splashOverlay) {
    try {
      if (localStorage.getItem('trail-editor-hide-splash') === '1') {
        splashOverlay.classList.add('hidden');
      }
    } catch (e) { /* localStorage unavailable */ }
  }
  if (splashClose) splashClose.addEventListener('click', hideSplash);
  if (btnGuide) btnGuide.addEventListener('click', showSplash);

  // ---- 1. Initialize map ----
  try {
    status('Initializing map...');
    map = await TrailMap.init();
    status('Map ready');
  } catch (err) {
    status('Map init failed: ' + err.message);
    console.error('Map init error:', err);
    return;
  }

  // ---- 2. Initialize charts, tabs, comparison, waypoints ----
  const hoverCb = (lngLat) => { TrailMap.setHoverPoint(lngLat); };
  const clickCb = (lngLat) => { TrailMap.getMap().flyTo({ center: lngLat, zoom: 17, duration: 600 }); };
  ProfileCharts.init(hoverCb, clickCb);
  ComparisonChart.init(hoverCb, clickCb);
  TabController.init();
  TabController.registerResize('elevation', () => ProfileCharts.resize());
  TabController.registerResize('slope', () => ProfileCharts.resize());
  TabController.registerResize('comparison', () => ComparisonChart.resize());
  TabController.setTabEnabled('comparison', false);

  // Initialize waypoints (after map is ready)
  Waypoints.init(TrailMap.getMap());

  selector = document.getElementById('trail-selector');

  // ---- 3. Load default trail data ----
  try {
    status('Loading trail data...');
    const trailResp = await fetch('data/trails.geojson');
    if (!trailResp.ok) throw new Error('HTTP ' + trailResp.status);
    trailData = await trailResp.json();
    loadTrailsIntoApp(trailData);
  } catch (err) {
    status('Default trails not found — use Load Trails to pick a file');
    console.warn('Default trail load:', err);
  }

  // ---- 4. Initialize DEM sampler ----
  try {
    status('Loading DEM...');
    await DemSampler.init('data/dem_cropped.tif');
    demLoaded = true;
    status('DEM loaded — generating contours…');
    await generateContours();
    // Enable 3D terrain from the loaded DEM
    TrailMap.enable3DTerrain(1.5);
  } catch (err) {
    status('Default DEM not found — use Load DEM to pick a file');
    console.warn('Default DEM load:', err);
  }

  // ---- 5. Initialize vertex editor + load elevations ----
  if (trailData) {
    initEditor(trailData);
  }

  status(demLoaded
    ? 'Ready — click and drag vertices to edit trails'
    : 'Ready (no DEM) — use Load DEM to enable elevation');

  // ── Contour cache helpers (server-side or IndexedDB fallback) ──

  async function cacheRead(key) {
    // Try server cache first
    try {
      const resp = await fetch('/api/cache?key=' + encodeURIComponent(key),
                               { signal: AbortSignal.timeout(1500) });
      if (resp.ok) return await resp.json();
    } catch (e) { /* server unavailable */ }

    // Fallback: IndexedDB
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('trail-editor-cache', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('contours');
        req.onsuccess = () => {
          const tx = req.result.transaction('contours', 'readonly');
          const get = tx.objectStore('contours').get(key);
          get.onsuccess = () => resolve(get.result || null);
          get.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  async function cacheWrite(key, data) {
    // Try server cache
    try {
      const json = JSON.stringify(data);
      console.log('[contours] Cache payload size:', (json.length / 1e6).toFixed(1), 'MB');
      await fetch('/api/cache?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json
      });
      console.log('[contours] Saved to server cache:', key);
      return;
    } catch (e) { /* server unavailable, use IndexedDB */ }

    // Fallback: IndexedDB
    try {
      const req = indexedDB.open('trail-editor-cache', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('contours');
      req.onsuccess = () => {
        const tx = req.result.transaction('contours', 'readwrite');
        tx.objectStore('contours').put(data, key);
        console.log('[contours] Saved to IndexedDB cache:', key);
      };
    } catch (e) { console.warn('Cache write failed:', e); }
  }

  async function generateContours() {
    try {
      const demUrl = DemSampler.getUrl() || 'default';
      const cacheKey = 'contours_' + demUrl.replace(/[^a-zA-Z0-9]/g, '_') + '.json';

      // Try cache first
      status('Loading contours…');
      const cached = await cacheRead(cacheKey);
      if (cached) {
        TrailMap.showContours(cached);
        status('Contours loaded from cache');
        console.log('[contours] Loaded from cache:', cacheKey);
        return;
      }

      // Generate fresh contours
      status('Generating contours (first time — will be cached)…');
      const raster = await DemSampler.getFullRaster();
      if (!raster) return;
      const contours = ContourGenerator.generate(raster);
      TrailMap.showContours(contours);
      status('Contours ready');

      // Save to cache
      cacheWrite(cacheKey, contours);
    } catch (err) {
      console.warn('Contour generation failed:', err);
    }
  }

  // ==== Dynamic loading functions ====

  function loadTrailsIntoApp(data) {
    // Separate Point features (waypoints) from line features (trails)
    const pointFeatures = data.features.filter(f =>
      f.geometry && f.geometry.type === 'Point');
    const lineFeatures = data.features.filter(f =>
      f.geometry && f.geometry.type !== 'Point');

    // Load waypoints from imported Points
    if (pointFeatures.length > 0 && typeof Waypoints !== 'undefined') {
      Waypoints.loadWaypoints(pointFeatures);
      console.log(`[app] Loaded ${pointFeatures.length} waypoints from import`);
    }

    // Work with line features only for trails
    data = { ...data, features: lineFeatures };
    trailData = data;
    trailNames = [];

    // Ensure every feature has a Name property (generate one if missing)
    let unnamedIdx = 0;
    for (const f of data.features) {
      if (!f.properties.Name && !f.properties.name) {
        unnamedIdx++;
        f.properties.Name = 'Trail ' + unnamedIdx;
      } else if (!f.properties.Name && f.properties.name) {
        // Normalize to capital-N Name so downstream code is consistent
        f.properties.Name = f.properties.name;
      }
    }

    // Clear and rebuild trail selector
    selector.innerHTML = '<option value="__all__">All Trails</option>';
    for (const f of data.features) {
      const name = f.properties.Name || f.properties.name;
      if (name && !trailNames.includes(name)) {
        trailNames.push(name);
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        selector.appendChild(opt);
      }
    }

    // Update map
    TrailMap.addTrails(data);
    TrailMap.fitToTrails(data);

    status('Loaded ' + data.features.length + ' trails');
  }

  function initEditor(data) {
    function onTrailUpdate(trailName, result) {
      const currentTrail = selector.value;
      if (currentTrail === '__all__' || currentTrail === trailName) {
        const trail = data.features.find(f =>
          (f.properties.Name || f.properties.name) === trailName);
        const coords = trail ? trail.geometry.coordinates : [];
        ProfileCharts.update(result.segments, [], coords);
        StatsPanel.updateStats(result.summary, trailName);
        TrailMap.showGradeSegments(result.segments, coords);
      }
    }

    VertexEditor.init(map, data, onTrailUpdate);

    if (demLoaded) {
      status('Sampling elevations...');
      VertexEditor.loadElevations().then(() => {
        // Populate stats for all trails
        for (const tn of trailNames) {
          const m = VertexEditor.getMetrics(tn);
          if (m) StatsPanel.updateStats(m.summary, tn);
        }
        // Show first trail
        if (trailNames.length > 0) {
          selector.value = trailNames[0];
          showTrailData(trailNames[0]);
          VertexEditor.selectTrail(trailNames[0]);
        }
        status('Ready — click and drag vertices to edit trails');
      }).catch(err => {
        status('Elevation sampling error: ' + err.message);
        console.error(err);
      });
    } else if (trailNames.length > 0) {
      selector.value = trailNames[0];
      VertexEditor.selectTrail(trailNames[0]);
    }
  }

  /**
   * Load trails from server paths OR directly from parsed GeoJSON data.
   * @param {string|null} gpkgPath - GPKG file path (server mode)
   * @param {string|null} geojsonPath - GeoJSON file path (server mode)
   * @param {string|null} layerName - GPKG layer name (server mode)
   * @param {Object|null} directData - Pre-parsed GeoJSON FeatureCollection (serverless mode)
   */
  async function loadTrailsFromSource(gpkgPath, geojsonPath, layerName, directData) {
    try {
      let data;

      if (directData) {
        // Serverless mode — data already parsed from browser file input
        data = directData;
        status('Loading trails from local file...');
      } else {
        let url;
        if (gpkgPath && layerName) {
          status('Converting ' + layerName + ' from ' + gpkgPath.split('/').pop() + '...');
          url = '/api/gpkg-geojson?path=' + encodeURIComponent(gpkgPath) +
                '&layer=' + encodeURIComponent(layerName);
        } else if (geojsonPath) {
          status('Loading ' + geojsonPath.split('/').pop() + '...');
          url = '/api/file?path=' + encodeURIComponent(geojsonPath);
        }

        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        data = await resp.json();
      }

      if (!data.features || data.features.length === 0) {
        status('No features found in file');
        return;
      }

      // Remove old map layers before adding new ones
      TrailMap.removeLayers();

      loadTrailsIntoApp(data);
      initEditor(data);

    } catch (err) {
      status('Load failed: ' + err.message);
      console.error('Trail load error:', err);
    }
  }

  /**
   * Load DEM from a URL string OR an ArrayBuffer (serverless mode).
   * @param {string|null} url - URL to fetch (server mode)
   * @param {ArrayBuffer|null} buffer - Raw GeoTIFF data (serverless mode)
   * @param {string} [fileName] - Display name for the file
   */
  async function loadDemFromSource(url, buffer, fileName) {
    try {
      const label = fileName || (url ? decodeURIComponent(url.split('path=')[1] || url) : 'DEM');
      status('Loading DEM (' + label + ')...');

      if (buffer) {
        await DemSampler.init(buffer, fileName);
      } else {
        await DemSampler.init(url);
      }

      demLoaded = true;
      status('DEM loaded — generating contours…');
      await generateContours();
      TrailMap.enable3DTerrain(1.5);
      status('Contours ready — re-sampling elevations…');

      // Re-sample elevations with new DEM
      if (trailData) {
        await VertexEditor.loadElevations();
        // Rebuild stats for all trails
        for (const tn of trailNames) {
          const m = VertexEditor.getMetrics(tn);
          if (m) StatsPanel.updateStats(m.summary, tn);
        }
        const current = selector.value;
        if (current && current !== '__all__') {
          showTrailData(current);
        }
      }
      status('Ready with new DEM');
    } catch (err) {
      status('DEM load failed: ' + err.message);
      console.error('DEM load error:', err);
    }
  }

  // ==== Event handlers ====

  selector.addEventListener('change', (e) => {
    const name = e.target.value;
    VertexEditor.selectTrail(name === '__all__' ? null : name);
    TrailMap.highlightTrail(name);
    // Clear drainage when switching trails
    if (drainageActive) {
      TrailMap.clearDrainageZones();
      drainageActive = false;
      document.getElementById('btn-drainage').classList.remove('active');
    }
    if (name === '__all__') {
      StatsPanel.clear();
      ProfileCharts.clear();
      ComparisonChart.clear();
      TrailMap.clearGradeSegments();
      TabController.setTabEnabled('comparison', false);
    } else {
      showTrailData(name);
    }
  });

  document.getElementById('btn-hillshade').addEventListener('click', () => {
    TrailMap.showBasemap('hillshade');
    document.getElementById('btn-hillshade').classList.add('active');
    document.getElementById('btn-satellite').classList.remove('active');
  });

  document.getElementById('btn-satellite').addEventListener('click', () => {
    TrailMap.showBasemap('satellite');
    document.getElementById('btn-satellite').classList.add('active');
    document.getElementById('btn-hillshade').classList.remove('active');
  });

  // Load Trails button — handles both server and serverless callbacks
  document.getElementById('btn-load-trails').addEventListener('click', () => {
    FilePicker.showTrailPicker((gpkgPath, geojsonPath, layerName, directData) => {
      loadTrailsFromSource(gpkgPath, geojsonPath, layerName, directData);
    });
  });

  // Load DEM button — handles both server (url) and serverless (arrayBuffer) callbacks
  document.getElementById('btn-load-dem').addEventListener('click', () => {
    FilePicker.showDemPicker((url, buffer, fileName) => {
      loadDemFromSource(url, buffer, fileName);
    });
  });

  document.getElementById('btn-undo').addEventListener('click', () => {
    VertexEditor.undo();
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    Export.downloadGeoJSON(VertexEditor.getTrailData());
    status('Exported edited_trails.geojson');
  });

  document.getElementById('btn-export-kml').addEventListener('click', () => {
    Export.downloadKML(VertexEditor.getTrailData());
    status('Exported edited_trails.kml');
  });

  document.getElementById('btn-recenter').addEventListener('click', () => {
    TrailMap.recenter(trailData);
    status('Map recentered');
  });

  // ── Densify ──
  document.getElementById('btn-densify').addEventListener('click', async () => {
    const name = selector.value;
    if (!name || name === '__all__') {
      status('Select a specific trail first');
      return;
    }
    const spacingStr = prompt('Vertex spacing (meters):', '10');
    if (!spacingStr) return;
    const spacing = parseFloat(spacingStr);
    if (isNaN(spacing) || spacing < 1) {
      status('Invalid spacing');
      return;
    }
    const trail = trailData.features.find(f =>
      (f.properties.Name || f.properties.name) === name);
    if (!trail) return;
    const oldCount = trail.geometry.coordinates.length;
    status(`Densifying ${name} to ${spacing}m spacing...`);
    const newCount = await VertexEditor.densifyTrail(name, spacing);
    if (newCount > 0) {
      showTrailData(name);
      status(`Densified: ${oldCount} → ${newCount} vertices (${spacing}m spacing)`);
    }
  });

  document.getElementById('btn-optimize').addEventListener('click', () => {
    const name = selector.value;
    if (!name || name === '__all__') {
      status('Select a single trail first');
      return;
    }
    if (!DemSampler.isLoaded()) {
      status('Load a DEM first');
      return;
    }
    const trail = trailData.features.find(f =>
      (f.properties.Name || f.properties.name) === name);
    if (!trail) return;
    const coords = trail.geometry.coordinates;
    const elevs = VertexEditor.getElevations(name);
    const metrics = VertexEditor.getMetrics(name);
    if (!elevs || !metrics) {
      status('Elevation data not loaded yet');
      return;
    }
    OptimizerUI.show(name, coords, elevs, metrics);
  });

  // ── Drainage Analysis ──
  let drainageActive = false;
  document.getElementById('btn-drainage').addEventListener('click', async () => {
    const btnDrainage = document.getElementById('btn-drainage');
    if (drainageActive) {
      TrailMap.clearDrainageZones();
      drainageActive = false;
      btnDrainage.classList.remove('active');
      status('Drainage analysis cleared');
      return;
    }
    const name = selector.value;
    if (!name || name === '__all__') {
      status('Select a specific trail first');
      return;
    }
    if (!DemSampler.isLoaded()) {
      status('Load a DEM first');
      return;
    }
    const trail = trailData.features.find(f =>
      (f.properties.Name || f.properties.name) === name);
    if (!trail) return;
    const coords = trail.geometry.coordinates;
    status('Analyzing drainage...');
    const zones = await DrainageAnalysis.analyze(coords);
    TrailMap.showDrainageZones(zones, coords);
    drainageActive = true;
    btnDrainage.classList.add('active');
    const totalLen = zones.reduce((s, z) => s + z.length, 0);
    status(`Found ${zones.length} drainage zone${zones.length !== 1 ? 's' : ''} (${totalLen.toFixed(0)}m total)`);
  });

  // ── Add Waypoint ──
  document.getElementById('btn-waypoint').addEventListener('click', () => {
    const btnWP = document.getElementById('btn-waypoint');
    if (Waypoints.isPlacing()) {
      Waypoints.stopPlacing();
      btnWP.textContent = 'Add Waypoint';
      btnWP.classList.remove('active');
      status('Waypoint placement stopped');
    } else {
      Waypoints.startPlacing();
      btnWP.textContent = 'Stop Placing';
      btnWP.classList.add('active');
      status('Click on map to place waypoints. Click button again to stop.');
    }
  });

  // ── New Route (draw mode) ──
  document.getElementById('btn-new-route').addEventListener('click', () => {
    if (DrawRoute.isActive()) {
      DrawRoute.cancel();
      status('Draw cancelled');
      return;
    }
    const name = prompt('Enter a name for the new route:');
    if (!name || !name.trim()) return;
    const trimName = name.trim();

    // Check for duplicate name
    if (trailNames.includes(trimName)) {
      status('A route with that name already exists');
      return;
    }

    status('Click on map to add vertices. Double-click or Enter to finish. Esc to cancel.');
    document.getElementById('btn-new-route').textContent = 'Cancel Draw';

    const resetBtn = () => { document.getElementById('btn-new-route').textContent = 'New Route'; };

    DrawRoute.start(trimName, async (routeName, coords) => {
      resetBtn();

      if (coords.length < 2) {
        status('Route cancelled — need at least 2 points');
        return;
      }

      // Add as a new trail feature
      VertexEditor.addTrailFeature(routeName, coords);

      // Update trailData reference
      trailData = VertexEditor.getTrailData();

      // Add to selector
      if (!trailNames.includes(routeName)) {
        trailNames.push(routeName);
        const opt = document.createElement('option');
        opt.value = routeName;
        opt.textContent = routeName;
        selector.appendChild(opt);
      }

      // Select the new trail
      selector.value = routeName;
      VertexEditor.selectTrail(routeName);
      TrailMap.updateTrailColors(trailData);

      // Load elevations if DEM available
      if (DemSampler.isLoaded()) {
        await VertexEditor.loadElevations(trailData);
        showTrailData(routeName);
      }

      status(`Route "${routeName}" created with ${coords.length} vertices`);
    }, () => {
      resetBtn();
      status('Draw cancelled');
    });
  });

  // ── Delete Route ──
  document.getElementById('btn-delete-route').addEventListener('click', () => {
    const name = selector.value;
    if (!name || name === '__all__') {
      status('Select a specific trail to delete');
      return;
    }
    if (!confirm(`Delete route "${name}"? This cannot be undone.`)) return;

    // Remove from vertex editor + map
    VertexEditor.removeTrailFeature(name);

    // Remove from selector
    const idx = trailNames.indexOf(name);
    if (idx >= 0) trailNames.splice(idx, 1);
    const optEl = Array.from(selector.options).find(o => o.value === name);
    if (optEl) selector.removeChild(optEl);

    // Update trailData reference
    trailData = VertexEditor.getTrailData();

    // Select "All Trails" or first remaining
    selector.value = '__all__';
    VertexEditor.selectTrail(null);
    TrailMap.updateTrailColors(trailData);

    // Clear charts
    ProfileCharts.clear();
    StatsPanel.clear();

    status(`Route "${name}" deleted`);
  });

  // Callback when optimizer finishes — add new trail to selector and select it
  window._onOptimizerDone = (newTrailName) => {
    if (!trailNames.includes(newTrailName)) {
      trailNames.push(newTrailName);
      const opt = document.createElement('option');
      opt.value = newTrailName;
      opt.textContent = newTrailName;
      selector.appendChild(opt);
    }
    selector.value = newTrailName;
    VertexEditor.selectTrail(newTrailName);
    TrailMap.highlightTrail(newTrailName);
    showTrailData(newTrailName);
    // Update trail colors without tearing down layers (preserves vertex layer)
    TrailMap.updateTrailColors(VertexEditor.getTrailData());
  };

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      if (DrawRoute.isActive()) return; // draw mode handles its own undo
      e.preventDefault();
      VertexEditor.undo();
    }
  });

  function showTrailData(name) {
    const metrics = VertexEditor.getMetrics(name);
    if (metrics) {
      const trailFeature = trailData
        ? trailData.features.find(f =>
            (f.properties.Name || f.properties.name) === name)
        : null;
      const coords = trailFeature ? trailFeature.geometry.coordinates : [];
      ProfileCharts.update(metrics.segments, [], coords);
      StatsPanel.updateStats(metrics.summary, name);
      TrailMap.showGradeSegments(metrics.segments, coords);

      // Update comparison chart if optimized version exists
      updateComparisonTab(name);
    }
  }

  function updateComparisonTab(name) {
    // Check for optimized trail (either direction)
    let origName, optName;
    if (name.endsWith(' - Optimized')) {
      optName = name;
      origName = name.replace(' - Optimized', '');
    } else {
      origName = name;
      optName = name + ' - Optimized';
    }

    const origFeature = trailData ? trailData.features.find(f =>
      (f.properties.Name || f.properties.name) === origName) : null;
    const optFeature = trailData ? trailData.features.find(f =>
      (f.properties.Name || f.properties.name) === optName) : null;

    if (origFeature && optFeature) {
      const origMetrics = VertexEditor.getMetrics(origName);
      const optMetrics = VertexEditor.getMetrics(optName);
      if (origMetrics && optMetrics) {
        ComparisonChart.update(
          origMetrics.segments, origFeature.geometry.coordinates,
          optMetrics.segments, optFeature.geometry.coordinates
        );
        TabController.setTabEnabled('comparison', true);
        return;
      }
    }
    ComparisonChart.clear();
    TabController.setTabEnabled('comparison', false);
  }

  // ==== Resize handle for bottom panel ====
  (() => {
    const handle = document.getElementById('resize-handle');
    const panel = document.getElementById('bottom-panel');
    if (!handle || !panel) return;

    let startY, startH;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = panel.offsetHeight;
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', onRelease);
    });

    function onDrag(e) {
      const dy = startY - e.clientY;  // dragging up = positive = taller
      const newH = Math.max(100, Math.min(window.innerHeight * 0.8, startH + dy));
      panel.style.height = newH + 'px';
      // Notify map that its container changed size
      if (map) map.resize();
    }

    function onRelease() {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', onRelease);
    }
  })();

})();
