/**
 * app.js — Main entry point, wires everything together
 *
 * All DEMs go through the same preprocessing pipeline:
 *   - Small DEMs: header → full extent extract → contour/terrain tiles → cache → app mode (automatic)
 *   - Large DEMs: header → user loads trails → ROI extract → tiles → cache → app mode (interactive)
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
  let preprocessMode = false;  // true during preprocessing
  let cachedDemId = null;      // non-null when running from cache

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

  // ---- 4. Load default DEM through unified preprocessing pipeline ----
  try {
    status('Loading DEM...');
    await loadDemFromSource('data/dem_cropped.tif', null, 'dem_cropped.tif', 0);
  } catch (err) {
    status('Default DEM not found — use Load DEM to pick a file');
    console.warn('Default DEM load:', err);
  }

  // ---- 5. Initialize vertex editor + load elevations ----
  // (If DEM loaded via unified pipeline, initEditor was already called inside enterAppModeFromCache.
  //  Only need this for the case where no DEM loaded but trails exist.)
  if (trailData && !demLoaded) {
    initEditor(trailData);
  }

  if (!demLoaded) {
    status('Ready (no DEM) — use Load DEM to enable elevation');
  }

  // (Legacy contour cache helpers removed — all DEMs now use unified preprocessing pipeline)

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

    // Normalize geometries: flatten MultiLineString → LineString
    // (GeoPackage exports often use MultiLineString even for single-part lines)
    for (const f of lineFeatures) {
      if (f.geometry && f.geometry.type === 'MultiLineString') {
        // Concatenate all parts into a single LineString
        const parts = f.geometry.coordinates;
        if (parts.length === 1) {
          f.geometry.type = 'LineString';
          f.geometry.coordinates = parts[0];
        } else {
          // Multi-part: concatenate all segments into one continuous line
          f.geometry.type = 'LineString';
          f.geometry.coordinates = parts.reduce((acc, part) => acc.concat(part), []);
        }
        console.log(`[app] Converted MultiLineString "${f.properties.Name || f.properties.name || '?'}" → LineString (${f.geometry.coordinates.length} vertices)`);
      }
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

    // If in preprocess mode, now that trails are loaded we can enable the Process button
    if (preprocessMode) {
      updatePreprocessUI('trails-loaded');
    }
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

    // Always try to sample elevations if any DEM source is available
    const roiLoaded = typeof RoiSampler !== 'undefined' && RoiSampler.isLoaded();
    const hasDem = roiLoaded || demLoaded;
    console.log('[app] initEditor: trails=' + (data ? data.features.length : 0) +
                ', trailNames=[' + trailNames.join(', ') + ']' +
                ', RoiSampler=' + roiLoaded + ', demLoaded=' + demLoaded);

    if (hasDem) {
      sampleAndShowElevations();
    } else {
      console.log('[app] initEditor: no DEM available, skipping elevation sampling');
      if (trailNames.length > 0) {
        selector.value = trailNames[0];
        VertexEditor.selectTrail(trailNames[0]);
      }
    }
  }

  /**
   * Sample elevations for all loaded trails, update charts/stats, show first trail.
   * Separated from initEditor so it can also be called independently.
   */
  async function sampleAndShowElevations() {
    status('Sampling elevations...');
    try {
      await VertexEditor.loadElevations();
      // Populate stats for all trails
      console.log('[app] Elevation sampling done, updating stats for:', trailNames);
      for (const tn of trailNames) {
        const m = VertexEditor.getMetrics(tn);
        if (m) StatsPanel.updateStats(m.summary, tn);
      }
      // Show the currently selected trail, or first trail
      const current = selector.value;
      if (current && current !== '__all__' && trailNames.includes(current)) {
        showTrailData(current);
        VertexEditor.selectTrail(current);
      } else if (trailNames.length > 0) {
        selector.value = trailNames[0];
        showTrailData(trailNames[0]);
        VertexEditor.selectTrail(trailNames[0]);
      }
      status('Ready — click and drag vertices to edit trails');
    } catch (err) {
      status('Elevation sampling error: ' + err.message);
      console.error('[app] Elevation sampling error:', err);
    }
  }

  /**
   * Load trails from server paths OR directly from parsed GeoJSON data.
   */
  async function loadTrailsFromSource(gpkgPath, geojsonPath, layerName, directData) {
    try {
      let data;

      if (directData) {
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

      // Only init editor if not in preprocess mode (will init after preprocessing)
      if (!preprocessMode) {
        initEditor(data);
      }

    } catch (err) {
      status('Load failed: ' + err.message);
      console.error('Trail load error:', err);
    }
  }

  /**
   * Load DEM from a URL string OR an ArrayBuffer (serverless mode).
   * ALL DEMs go through the same preprocessing pipeline:
   *   - Small DEMs: auto-process immediately using full extent (no panel)
   *   - Large DEMs: show interactive panel, wait for trails to define ROI
   */
  async function loadDemFromSource(url, buffer, fileName, fileSize) {
    try {
      console.log('[app] loadDemFromSource:', url || '(buffer)', fileName, fileSize);
      const label = fileName || (url ? decodeURIComponent(url.split('path=')[1] || url) : 'DEM');
      let size = fileSize || (buffer ? buffer.byteLength : 0);

      // If we have a URL but no size info, probe the server for content-length
      if (size === 0 && url && !buffer) {
        try {
          console.log('[app] Probing file size via HEAD...');
          const ac = new AbortController();
          const tid = setTimeout(() => ac.abort(), 3000);
          const headResp = await fetch(url, { method: 'HEAD', signal: ac.signal });
          clearTimeout(tid);
          const cl = headResp.headers.get('content-length');
          if (cl) size = parseInt(cl, 10) || 0;
          console.log('[app] HEAD returned size:', size);
        } catch (e) {
          console.log('[app] HEAD failed (proceeding with size=0):', e.message);
        }
      }

      // Check if this DEM was previously preprocessed and cached
      const testId = CacheStore.makeDemId(fileName || label, size);
      console.log('[app] DEM id:', testId, 'size:', size);
      const hasCached = await CacheStore.hasCachedDem(testId);
      console.log('[app] Cache check result:', hasCached);
      if (hasCached) {
        status('Found cached preprocessed data — loading...');
        try {
          await enterAppModeFromCache(testId);
          return;
        } catch (cacheErr) {
          if (cacheErr.message === 'CACHE_INCOMPLETE') {
            console.warn('[app] Cache was incomplete — falling through to fresh processing');
            // Continue to fresh processing below
          } else {
            throw cacheErr;
          }
        }
      }

      // Large DEMs: interactive preprocessing (user loads trails to define ROI)
      if (DemPreprocessor.shouldPreprocess(size)) {
        status('Large DEM detected (' + (size / 1e6).toFixed(0) + ' MB) — entering preprocessing mode...');
        await enterPreprocessMode(buffer || url, fileName || label, size);
        return;
      }

      // Small DEMs: auto-preprocess using full extent (no panel needed)
      status('Processing DEM (' + label + ')...');
      await autoPreprocessSmallDem(buffer || url, fileName || label, size);

    } catch (err) {
      status('DEM load failed: ' + err.message);
      console.error('DEM load error:', err);
    }
  }

  /**
   * Auto-preprocess a small DEM using full extent (no interactive panel).
   * Same pipeline as large DEMs but uses extractFullExtent() instead of extractROI().
   */
  async function autoPreprocessSmallDem(source, fileName, fileSize) {
    // Step 1: Parse header
    status('Parsing DEM header...');
    const info = await DemPreprocessor.loadHeader(source, fileName, fileSize);

    // Step 2: Extract full extent as ROI (small DEM, so this is fine for memory)
    status('Reading raster data...');
    const roi = await DemPreprocessor.extractFullExtent();

    // Load into RoiSampler immediately (with DEM id so it knows which DEM it holds)
    const demId = DemPreprocessor.getDemId();
    RoiSampler.loadFromRaster(roi, demId);

    // Step 3: Run preprocessing pipeline (contours, aspect, terrain tiles)
    status('Generating terrain tiles and contours...');
    await DemPreprocessor.runPreprocessing({
      onStep: (step, detail) => {
        status(detail);
      },
      onTileProgress: (current, total, type) => {
        const pct = Math.round(current / total * 100);
        status(`${type === 'contours' ? 'Contour' : 'Terrain'} tiles: ${current}/${total} (${pct}%)`);
      },
      onComplete: () => {
        status('Preprocessing complete');
      }
    });

    // Step 4: Release full DEM, enter app mode from cache
    DemPreprocessor.releaseMemory();
    cachedDemId = DemPreprocessor.getDemId();
    demLoaded = true;

    await enterAppModeFromCache(cachedDemId);
  }

  // ═══════════════════════════════════════════════
  //  PREPROCESSING PIPELINE
  // ═══════════════════════════════════════════════

  async function enterPreprocessMode(source, fileName, fileSize) {
    preprocessMode = true;
    showPreprocessPanel(true);

    try {
      // Step 1: Parse header only (near-zero memory)
      updatePreprocessUI('loading-header');
      const info = await DemPreprocessor.loadHeader(source, fileName, fileSize);
      const extent = DemPreprocessor.getExtentGeoJSON();
      if (extent) {
        TrailMap.showDemExtent(extent);
        // Fit map to DEM extent
        const b = info.extent;
        if (b) {
          try {
            TrailMap.getMap().fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 40 });
          } catch (e) {}
        }
      }

      updatePreprocessUI('header-loaded', {
        width: info.width, height: info.height,
        sizeMB: (info.width * info.height * 4 / 1e6).toFixed(0)
      });

      // Step 2: Wait for trails to be loaded (if not already)
      if (!trailData || trailData.features.length === 0) {
        updatePreprocessUI('waiting-trails');
        // The Process button won't be enabled until trails are loaded
        // (loadTrailsIntoApp calls updatePreprocessUI when preprocessMode=true)
        return;
      }

      // Trails already loaded — enable process button
      updatePreprocessUI('trails-loaded');

    } catch (err) {
      status('Preprocessing failed: ' + err.message);
      console.error('Preprocess error:', err);
      preprocessMode = false;
      showPreprocessPanel(false);
    }
  }

  async function runPreprocessPipeline() {
    if (!trailData) return;

    try {
      // Step 3: Extract ROI
      updatePreprocessUI('extracting-roi');
      status('Extracting region of interest from DEM...');
      const roi = await DemPreprocessor.extractROI(trailData, 500);
      const roiSizeMB = (roi.width * roi.height * 4 / 1e6).toFixed(1);
      status(`ROI extracted: ${roi.width}x${roi.height} pixels (${roiSizeMB} MB)`);

      // Load ROI into RoiSampler immediately (for elevation sampling during app mode)
      const ppDemId = DemPreprocessor.getDemId();
      RoiSampler.loadFromRaster(roi, ppDemId);

      // Step 4: Run preprocessing pipeline (contours, aspect, terrain)
      updatePreprocessUI('processing');
      await DemPreprocessor.runPreprocessing({
        onStep: (step, detail) => {
          status(detail);
          updatePreprocessUI('step', { step });
        },
        onTileProgress: (current, total, type) => {
          const pct = Math.round(current / total * 100);
          status(`${type === 'contours' ? 'Contour' : 'Terrain'} tiles: ${current}/${total} (${pct}%)`);
          updatePreprocessProgress(current, total);
        },
        onComplete: () => {
          status('Preprocessing complete');
        }
      });

      // Step 5: Release the full DEM and enter app mode
      DemPreprocessor.releaseMemory();
      cachedDemId = ppDemId;
      demLoaded = true;
      preprocessMode = false;
      showPreprocessPanel(false);
      TrailMap.clearDemExtent();

      await enterAppModeFromCache(cachedDemId);

    } catch (err) {
      status('Preprocessing failed: ' + err.message);
      console.error('Preprocess error:', err);
      preprocessMode = false;
      showPreprocessPanel(false);
    }
  }

  /**
   * Enter app mode from cached preprocessed data.
   */
  async function enterAppModeFromCache(demId) {
    cachedDemId = demId;

    status('Loading cached terrain data...');

    // Load ROI raster into RoiSampler (for point elevation sampling)
    // Always load the correct DEM's ROI — don't skip just because some other DEM is loaded
    if (!RoiSampler.isLoadedFor(demId)) {
      console.log(`[app] Loading ROI for ${demId} (currently loaded: ${RoiSampler.getDemId() || 'none'})`);
      const loaded = await RoiSampler.loadFromCache(demId);
      if (!loaded) {
        console.warn('[app] ROI raster missing from cache — clearing bad entry');
        await CacheStore.clearDem(demId);
        throw new Error('CACHE_INCOMPLETE');
      }
    }
    demLoaded = true;

    // Load aspect grid for optimizer
    await SpringMass.loadAspectGridFromCache(demId);

    // Enable tiled contours (raster zoom 10-13, vector zoom 14+)
    await TrailMap.enableTiledContours(demId);

    // Enable 3D terrain from cached tiles
    await TrailMap.enable3DTerrainFromCache(demId, 1.5);

    status('Terrain ready — re-sampling elevations…');

    // Re-sample elevations with ROI data
    if (trailData) {
      initEditor(trailData);
    }

    const roiBounds = RoiSampler.getBounds();
    const roiRaster = RoiSampler.getFullRaster();
    const memMB = roiRaster ? (roiRaster.data.byteLength / 1e6).toFixed(1) : '?';
    status(`Ready — working from cached terrain data (~${memMB} MB in memory)`);
  }

  // ── Preprocess UI helpers ──

  function showPreprocessPanel(show) {
    const panel = document.getElementById('preprocess-panel');
    if (panel) panel.classList.toggle('hidden', !show);
  }

  function updatePreprocessUI(state, info) {
    const ppStatus = document.getElementById('pp-status');
    const ppDem = document.getElementById('pp-dem-status');
    const ppTrails = document.getElementById('pp-trails-status');
    const ppProcess = document.getElementById('pp-process-status');
    const btnStart = document.getElementById('btn-pp-start');
    const progressWrap = document.getElementById('pp-progress');

    switch (state) {
      case 'loading-header':
        if (ppDem) ppDem.textContent = 'Parsing...';
        break;
      case 'header-loaded':
        if (ppDem) ppDem.textContent = `${info.width}x${info.height} (${info.sizeMB} MB uncompressed)`;
        if (ppTrails) ppTrails.textContent = trailData ? `${trailData.features.length} trails loaded` : 'Waiting...';
        break;
      case 'waiting-trails':
        if (ppTrails) ppTrails.textContent = 'Load trails to define processing region';
        if (ppStatus) ppStatus.textContent = 'Load trails to define the processing region';
        break;
      case 'trails-loaded':
        if (ppTrails) ppTrails.textContent = `${trailData.features.length} trails loaded`;
        if (btnStart) btnStart.disabled = false;
        if (ppStatus) ppStatus.textContent = 'Ready to process. Click Process to begin.';
        break;
      case 'extracting-roi':
        if (btnStart) btnStart.disabled = true;
        if (ppProcess) ppProcess.textContent = 'Extracting ROI...';
        break;
      case 'processing':
        if (ppProcess) ppProcess.textContent = 'Processing...';
        if (progressWrap) progressWrap.classList.remove('hidden');
        break;
      case 'step':
        if (ppProcess) ppProcess.textContent = info.step;
        break;
    }
  }

  function updatePreprocessProgress(current, total) {
    const fill = document.getElementById('pp-progress-fill');
    const text = document.getElementById('pp-progress-text');
    if (fill) fill.style.width = Math.round(current / total * 100) + '%';
    if (text) text.textContent = `${current} / ${total}`;
  }

  // ==== Event handlers ====

  selector.addEventListener('change', (e) => {
    const name = e.target.value;
    VertexEditor.selectTrail(name === '__all__' ? null : name);
    TrailMap.highlightTrail(name);
    // Clear drainage when switching trails
    if (drainageActive) {
      TrailMap.clearDrainageZones();
      ProfileCharts.clearDrainageZones();
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

  // Load Trails button
  document.getElementById('btn-load-trails').addEventListener('click', () => {
    FilePicker.showTrailPicker((gpkgPath, geojsonPath, layerName, directData) => {
      loadTrailsFromSource(gpkgPath, geojsonPath, layerName, directData);
    });
  });

  // Load DEM button — passes fileSize for preprocessing decision
  document.getElementById('btn-load-dem').addEventListener('click', () => {
    FilePicker.showDemPicker((url, buffer, fileName, fileSize) => {
      loadDemFromSource(url, buffer, fileName, fileSize);
    });
  });

  document.getElementById('btn-undo').addEventListener('click', () => {
    VertexEditor.undo();
  });

  document.getElementById('btn-clear-cache').addEventListener('click', async () => {
    if (!confirm('Clear all cached terrain data? You will need to re-process any large DEMs.')) return;
    try {
      // Close the active DB connection first so deleteDatabase doesn't block
      CacheStore.reset();
      // Wait for close to complete
      await new Promise(r => setTimeout(r, 200));

      // Properly await each deleteDatabase call
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('trail-editor-v2');
        req.onsuccess = () => { console.log('[app] Deleted trail-editor-v2'); resolve(); };
        req.onerror = () => { console.warn('[app] Failed to delete trail-editor-v2'); resolve(); };
        req.onblocked = () => { console.warn('[app] Delete blocked — will complete on reload'); resolve(); };
      });
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('trail-editor-cache');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      cachedDemId = null;
      RoiSampler.release();
      demLoaded = false;
      status('Cache cleared — reload the page to continue');
    } catch (e) {
      status('Failed to clear cache: ' + e.message);
    }
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
    // Check for any DEM source (ROI or full)
    const hasDem = (typeof RoiSampler !== 'undefined' && RoiSampler.isLoaded()) || DemSampler.isLoaded();
    if (!hasDem) {
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
      ProfileCharts.clearDrainageZones();
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
    const hasDem = (typeof RoiSampler !== 'undefined' && RoiSampler.isLoaded()) || DemSampler.isLoaded();
    if (!hasDem) {
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
    ProfileCharts.setDrainageZones(zones);
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

      VertexEditor.addTrailFeature(routeName, coords);
      trailData = VertexEditor.getTrailData();

      if (!trailNames.includes(routeName)) {
        trailNames.push(routeName);
        const opt = document.createElement('option');
        opt.value = routeName;
        opt.textContent = routeName;
        selector.appendChild(opt);
      }

      selector.value = routeName;
      VertexEditor.selectTrail(routeName);
      TrailMap.updateTrailColors(trailData);

      const hasDem = (typeof RoiSampler !== 'undefined' && RoiSampler.isLoaded()) || DemSampler.isLoaded();
      if (hasDem) {
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

    VertexEditor.removeTrailFeature(name);
    const idx = trailNames.indexOf(name);
    if (idx >= 0) trailNames.splice(idx, 1);
    const optEl = Array.from(selector.options).find(o => o.value === name);
    if (optEl) selector.removeChild(optEl);

    trailData = VertexEditor.getTrailData();
    selector.value = '__all__';
    VertexEditor.selectTrail(null);
    TrailMap.updateTrailColors(trailData);
    ProfileCharts.clear();
    StatsPanel.clear();
    status(`Route "${name}" deleted`);
  });

  // ── Preprocess panel buttons ──
  const btnPPStart = document.getElementById('btn-pp-start');
  if (btnPPStart) {
    btnPPStart.addEventListener('click', () => runPreprocessPipeline());
  }
  const btnPPSkip = document.getElementById('btn-pp-skip');
  if (btnPPSkip) {
    btnPPSkip.addEventListener('click', async () => {
      preprocessMode = false;
      showPreprocessPanel(false);
      TrailMap.clearDemExtent();
      status('Skipping ROI — processing full DEM extent...');
      // Use full extent through the same pipeline (warning: may be slow/large for big DEMs)
      try {
        const roi = await DemPreprocessor.extractFullExtent();
        const skipDemId = DemPreprocessor.getDemId();
        RoiSampler.loadFromRaster(roi, skipDemId);

        await DemPreprocessor.runPreprocessing({
          onStep: (step, detail) => status(detail),
          onTileProgress: (current, total, type) => {
            const pct = Math.round(current / total * 100);
            status(`${type === 'contours' ? 'Contour' : 'Terrain'} tiles: ${current}/${total} (${pct}%)`);
          },
          onComplete: () => status('Preprocessing complete')
        });

        DemPreprocessor.releaseMemory();
        cachedDemId = skipDemId;
        demLoaded = true;
        await enterAppModeFromCache(cachedDemId);
      } catch (err) {
        status('Failed to process full DEM: ' + err.message);
        console.error(err);
      }
    });
  }

  // Callback when optimizer finishes
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
    TrailMap.updateTrailColors(VertexEditor.getTrailData());
  };

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      if (DrawRoute.isActive()) return;
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
      updateComparisonTab(name);
    }
  }

  function updateComparisonTab(name) {
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
      const dy = startY - e.clientY;
      const newH = Math.max(100, Math.min(window.innerHeight * 0.8, startH + dy));
      panel.style.height = newH + 'px';
      if (map) map.resize();
    }

    function onRelease() {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', onRelease);
    }
  })();

})();
