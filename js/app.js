/**
 * app.js — Main entry point, wires everything together
 *
 * DEM loading: header → DEM setup panel (CRS, units, processing area) →
 * extract (reprojecting to UTM if needed) → contour/terrain tiles → cache →
 * app mode. Previously processed DEMs load straight from cache.
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
  let cachedDemId = null;      // non-null when running from cache
  let demLabel = null;         // file name of the active DEM
  let lastDemSource = null;    // { url, fileOrBuffer, fileName, fileSize } for "Reprocess"
  let projectName = null;
  let isDemo = false;          // showing the untouched demo trails
  let lastSavedKey = null, demoKey = null, autosaveFailed = false;

  const hasTerrain = () => RoiSampler.isLoaded();

  DemPanel.init();

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

  // ---- 3. Restore the last session, or show the demo ----
  let restored = false;
  try {
    const saved = await SessionStore.load();
    const n = saved && saved.trails && saved.trails.features ? saved.trails.features.length : 0;
    if (saved && (n > 0 || saved.dem)) {
      await restoreProject(saved);
      restored = true;
      const what = n > 0 ? `${n} trail${n === 1 ? '' : 's'}` : `terrain from ${saved.dem.label}, no trails yet`;
      Notice.show('restored',
        `Restored your last session${saved.name ? ` ("${saved.name}")` : ''}: ${what}, saved ${timeAgo(saved.savedAt)}.`,
        { level: 'info', timeout: 15000, actions: [{ label: 'Start new project', onClick: () => newProject() }] });
    }
  } catch (err) {
    console.warn('Session restore failed:', err);
  }
  if (!restored) await loadDemo();
  startAutosave();

  // ==== Project / session ====

  async function loadDemo() {
    try {
      status('Loading demo trails...');
      const trailResp = await fetch('data/trails.geojson');
      if (!trailResp.ok) throw new Error('HTTP ' + trailResp.status);
      trailData = (await TrailImport.normalize(await trailResp.json())).data;
      loadTrailsIntoApp(trailData);
      isDemo = true;
    } catch (err) {
      status('Default trails not found — use Load Trails to pick a file');
      console.warn('Default trail load:', err);
    }

    try {
      status('Loading DEM...');
      await loadDemFromSource('data/dem_cropped.tif', null, 'dem_cropped.tif', 0, { auto: true });
    } catch (err) {
      console.warn('Default DEM load:', err);
    }

    // enterAppModeFromCache initializes the editor when a DEM loaded
    if (trailData && !demLoaded) initEditor(trailData);
    if (!demLoaded) status('Ready (no DEM) — use Load DEM to enable elevation');

    if (isDemo) {
      Notice.show('demo',
        'This is a demo: the JC Trail network near Hayfork, California. Load your own DEM and trails to start, ' +
        'or start an empty project.',
        { level: 'info', actions: [{ label: 'Start new project', onClick: () => newProject() }] });
    }
  }

  function timeAgo(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!isFinite(s)) return 'earlier';
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' minutes ago';
    if (s < 129600) return Math.round(s / 3600) + ' hours ago';
    return Math.round(s / 86400) + ' days ago';
  }

  function slug(s) {
    return String(s).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'trails';
  }

  /** Everything needed to restore the current work. */
  function snapshot() {
    const td = VertexEditor.getTrailData() || trailData;
    const m = TrailMap.getMap();
    return {
      format: 'trail-route-editor-project',
      version: 1,
      name: projectName,
      savedAt: new Date().toISOString(),
      isDemo,
      trails: {
        type: 'FeatureCollection',
        features: (td ? td.features : []).map(f => ({ type: 'Feature', properties: f.properties, geometry: f.geometry }))
      },
      waypoints: Waypoints.getWaypointsGeoJSON(),
      frozen: VertexEditor.getFrozenState(),
      selected: selector.value,
      dem: cachedDemId ? { demId: cachedDemId, label: demLabel || cachedDemId } : null,
      view: { center: m.getCenter().toArray(), zoom: m.getZoom() }
    };
  }

  function contentKey(s) {
    return JSON.stringify([s.name, s.trails, s.waypoints, s.frozen, s.dem && s.dem.demId]);
  }

  async function restoreProject(p) {
    projectName = p.name || null;
    isDemo = !!p.isDemo;
    Waypoints.clear();
    TrailMap.removeLayers();
    for (const id of ['coverage', 'demo', 'restore-dem']) Notice.clear(id);

    const lines = (p.trails && p.trails.features) || [];
    const points = (p.waypoints && p.waypoints.features) || [];
    loadTrailsIntoApp({ type: 'FeatureCollection', features: [...lines, ...points] });
    VertexEditor.setFrozenState(p.frozen);
    if (p.selected && trailNames.includes(p.selected)) selector.value = p.selected;

    const demId = p.dem && p.dem.demId;
    let terrain = false;
    if (demId && await CacheStore.hasCachedDem(demId)) {
      try {
        demLabel = p.dem.label;
        await enterAppModeFromCache(demId);
        demLoaded = terrain = true;
      } catch (e) {
        console.warn('[app] Could not restore terrain:', e);
      }
    }
    if (!terrain) {
      initEditor(trailData);
      if (p.dem && !(cachedDemId && cachedDemId === demId)) {
        Notice.show('restore-dem',
          `This project's terrain ("${p.dem.label}") is not stored in this browser. Load that DEM again with Load DEM to get elevations.`,
          { level: 'warn' });
      }
      if (!hasTerrain()) status('Ready (no DEM) — use Load DEM to enable elevation');
    }
    if (p.view && p.view.center) {
      try { TrailMap.getMap().jumpTo({ center: p.view.center, zoom: p.view.zoom }); } catch (e) {}
    }
  }

  async function newProject() {
    const td = VertexEditor.getTrailData() || trailData;
    const n = td ? td.features.length : 0;
    if (n && !isDemo && !confirm(`Start a new project? The ${n} trail${n === 1 ? '' : 's'} currently loaded will be cleared ` +
                                 '(use Save Project first to keep them).')) return;
    clearTrails();
    projectName = null;
    isDemo = false;
    for (const id of ['demo', 'coverage', 'restored', 'restore-dem', 'import']) Notice.clear(id);
    await SessionStore.clear();
    lastSavedKey = contentKey(snapshot());
    status('New project — load or draw trails' + (hasTerrain() ? '' : ', and load a DEM'));
  }

  function clearTrails() {
    Waypoints.clear();
    TrailMap.removeLayers();
    VertexEditor.setFrozenState({});
    loadTrailsIntoApp({ type: 'FeatureCollection', features: [] });
    initEditor(trailData);
    ProfileCharts.clear();
    StatsPanel.clear();
    TrailMap.clearGradeSegments();
  }

  function startAutosave() {
    lastSavedKey = contentKey(snapshot());
    demoKey = isDemo ? lastSavedKey : null;
    setInterval(autosaveNow, 4000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') autosaveNow();
    });
    window.addEventListener('beforeunload', (e) => {
      if (autosaveFailed && contentKey(snapshot()) !== lastSavedKey) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  async function autosaveNow() {
    if (!selector) return;
    const s = snapshot();
    const key = contentKey(s);
    if (key === lastSavedKey) return;
    if (isDemo && key !== demoKey) {
      isDemo = false;
      s.isDemo = false;
      Notice.clear('demo');
    }
    if (isDemo) return;
    try {
      await SessionStore.save(s);
      lastSavedKey = key;
      if (autosaveFailed) Notice.clear('autosave');
      autosaveFailed = false;
    } catch (e) {
      if (!autosaveFailed) {
        Notice.show('autosave',
          'This browser is not letting the page store data, so your work is not being saved automatically. ' +
          'Use Save Project to keep it.', { level: 'warn' });
      }
      autosaveFailed = true;
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

    // Work with line features only for trails (TrailImport.normalize has
    // already turned multi-part lines into LineStrings)
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

    if (DemPanel.isOpen()) {
      DemPanel.updateTrails(trailCountsForDem());
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
      checkTrailCoverage();
      // Populate stats for all trails
      console.log('[app] Elevation sampling done, updating stats for:', trailNames);
      for (const tn of trailNames) {
        const m = VertexEditor.getMetrics(tn);
        if (m) StatsPanel.updateStats(m.summary, tn);
      }
      // Show the currently selected trail, or the first trail that has terrain under it
      const hasElev = (n) => (VertexEditor.getElevations(n) || []).some(v => v != null);
      const current = selector.value;
      if (current && current !== '__all__' && trailNames.includes(current) &&
          (hasElev(current) || !trailNames.some(hasElev))) {
        showTrailData(current);
        VertexEditor.selectTrail(current);
      } else if (trailNames.length > 0) {
        const first = trailNames.find(hasElev) || trailNames[0];
        selector.value = first;
        showTrailData(first);
        VertexEditor.selectTrail(first);
      }
      status('Ready — click and drag vertices to edit trails');
    } catch (err) {
      status('Elevation sampling error: ' + err.message);
      console.error('[app] Elevation sampling error:', err);
    }
  }

  /**
   * Load trails from server paths OR directly from parsed GeoJSON data.
   * opts.append adds them to the current trails instead of replacing them.
   */
  async function loadTrailsFromSource(gpkgPath, geojsonPath, layerName, directData, opts = {}) {
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

      const normalized = await TrailImport.normalize(data);
      data = normalized.data;
      const notes = normalized.notes;

      const current = trailData ? trailData.features.length : 0;
      if (!opts.append && current && !isDemo &&
          !confirm(`Replace the ${current} trail${current === 1 ? '' : 's'} currently loaded? ` +
                   '(Save Project first to keep them, or tick "Add to the trails already loaded".)')) {
        status('Load cancelled');
        return;
      }
      if (isDemo && !opts.append) {
        isDemo = false;
        Notice.clear('demo');
      }

      if (opts.append && trailData && trailData.features.length) {
        const renamed = TrailImport.dedupeAgainst(trailNames, data);
        if (renamed) notes.push(`Renamed ${renamed} incoming trail${renamed > 1 ? 's' : ''} whose names were already in use.`);
        data = { type: 'FeatureCollection', features: [...trailData.features, ...data.features] };
      } else {
        Waypoints.clear();
      }

      // Remove old map layers before adding new ones
      TrailMap.removeLayers();
      Notice.clear('coverage');

      loadTrailsIntoApp(data);
      if (notes.length) {
        Notice.show('import', `${opts.fileName || 'Trail file'}:\n` + notes.join('\n'), { level: 'info', timeout: 20000 });
      } else {
        Notice.clear('import');
      }

      // While a new DEM is being set up, the editor initializes after processing.
      // trailData (lines only) — `data` still includes the waypoint Points.
      if (!DemPanel.isOpen()) {
        initEditor(trailData);
      }

    } catch (err) {
      status('Load failed: ' + err.message);
      console.error('Trail load error:', err);
      Notice.show('import', 'Could not load trails: ' + err.message, { level: 'error' });
    }
  }

  /**
   * Load a DEM from a URL, File/Blob, or ArrayBuffer.
   * opts.auto: process the full extent with detected settings, no panel
   * (used for the bundled demo DEM).
   */
  async function loadDemFromSource(url, fileOrBuffer, fileName, fileSize, opts = {}) {
    try {
      console.log('[app] loadDemFromSource:', url || '(file)', fileName, fileSize);
      const label = fileName || (url ? decodeURIComponent(url.split('path=')[1] || url) : 'DEM');
      let size = fileSize || (fileOrBuffer ? (fileOrBuffer.size || fileOrBuffer.byteLength || 0) : 0);
      lastDemSource = { url, fileOrBuffer, fileName, fileSize };
      if (DemPanel.isOpen()) cancelDemPanel();

      // If we have a URL but no size info, probe the server for content-length
      if (size === 0 && url && !fileOrBuffer) {
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
          demLabel = label;
          if (!opts.auto) {
            Notice.show('dem-cached',
              `Using terrain for ${label} that was processed earlier and kept in browser storage.`, {
                level: 'info', timeout: 15000,
                actions: [{ label: 'Reprocess', onClick: () => reprocessLastDem(testId) }]
              });
          }
          return;
        } catch (cacheErr) {
          if (cacheErr.message === 'CACHE_INCOMPLETE') {
            console.warn('[app] Cache was incomplete — falling through to fresh processing');
          } else {
            throw cacheErr;
          }
        }
      }

      status('Reading DEM header...');
      const info = await DemPreprocessor.loadHeader(fileOrBuffer || url, label, size);

      if (opts.auto) {
        if (info.error) throw new Error(info.error);
        await processDem(info, { units: info.units.units, area: 'full' }, label);
        return;
      }
      openDemPanel(label, info);

    } catch (err) {
      status('DEM load failed: ' + err.message);
      console.error('DEM load error:', err);
      if (!opts.auto) Notice.show('dem-error', 'Could not load the DEM: ' + err.message, { level: 'error' });
    }
  }

  async function reprocessLastDem(demId) {
    if (!lastDemSource) return;
    await CacheStore.clearDem(demId);
    const s = lastDemSource;
    loadDemFromSource(s.url, s.fileOrBuffer, s.fileName, s.fileSize);
  }

  function trailCountsForDem() {
    const { inside } = DemPreprocessor.trailsInside(trailData);
    return { inside: inside.length, total: trailData ? trailData.features.length : 0 };
  }

  function openDemPanel(label, info) {
    const ext = DemPreprocessor.getExtentGeoJSON();
    if (ext) TrailMap.showDemExtent(ext);
    const counts = trailCountsForDem();
    if (info.extent && counts.inside === 0) {
      const b = info.extent;
      try { TrailMap.getMap().fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 40 }); } catch (e) {}
    }
    DemPanel.show({ fileName: label, info, trailCounts: counts }, {
      onProcess: (settings) => processDem(info, settings, label),
      onCancel: () => {
        cancelDemPanel();
        status('DEM load cancelled');
      }
    });
    status(info.error ? 'This DEM needs converting before it can be used'
                      : 'Check the DEM settings, then click Process DEM');
  }

  function cancelDemPanel() {
    DemPanel.hide();
    TrailMap.clearDemExtent();
    DemPreprocessor.releaseMemory();
    // releaseMemory forgets the active DEM id; restore it
    if (cachedDemId) DemPreprocessor.setDemId(cachedDemId);
  }

  /**
   * Run the pipeline for a DEM whose header is loaded.
   * settings: { units: 'm'|'ft'|'usft', area: 'trails'|'full' }
   */
  async function processDem(info, settings, label) {
    const prevCrs = Projection.getCrs();
    const prevDemId = cachedDemId;
    const demId = info.demId;
    const panel = DemPanel.isOpen();
    const step = (msg) => { status(msg); if (panel) DemPanel.setMessage(msg); };

    // Demo trails that this DEM does not cover are cleared once it is processed
    const dropDemoTrails = isDemo && panel && trailCountsForDem().inside === 0;

    try {
      if (panel) DemPanel.setBusy(true, 'Reading elevation data...');
      else status('Processing DEM (' + label + ')...');
      DemPreprocessor.setVerticalUnits(settings.units);

      const roi = settings.area === 'trails'
        ? await DemPreprocessor.extractROI(trailData, 500)
        : await DemPreprocessor.extractFullExtent();
      const range = DemPreprocessor.elevationRange(roi);
      if (!range) throw new Error('The processed area has no elevation values (all nodata).');

      RoiSampler.loadFromRaster(roi, demId);
      await DemPreprocessor.runPreprocessing({
        onStep: (s, detail) => step(detail),
        onTileProgress: (current, total, type) => {
          const name = type === 'contours' ? 'Contour tiles' : 'Terrain tiles';
          status(`${name}: ${current}/${total} (${Math.round(current / total * 100)}%)`);
          if (panel) DemPanel.progress(current, total, name);
        },
        onComplete: () => status('Preprocessing complete')
      });

      DemPreprocessor.releaseMemory();
      if (panel) DemPanel.hide();
      TrailMap.clearDemExtent();
      Notice.clear('dem-error');
      demLoaded = true;
      demLabel = label;
      if (dropDemoTrails) {
        clearTrails();
        isDemo = false;
        Notice.clear('demo');
        Notice.show('demo-cleared', 'Cleared the demo trails, which are outside your DEM. Load your trails or draw a new route.',
                    { level: 'info', timeout: 15000 });
      }
      await enterAppModeFromCache(demId);
      if (dropDemoTrails) {
        const b = RoiSampler.getBounds();
        try { TrailMap.getMap().fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 40 }); } catch (e) {}
      }
      checkElevationUnits(range, settings.units, demId);
    } catch (err) {
      console.error('DEM processing error:', err);
      Projection.setUtm(prevCrs.zone, prevCrs.south, prevCrs.datum);
      if (prevDemId) {
        if (!RoiSampler.isLoadedFor(prevDemId)) await RoiSampler.loadFromCache(prevDemId);
      } else {
        RoiSampler.release();
        demLoaded = false;
      }
      status('DEM processing failed: ' + err.message);
      if (panel && DemPanel.isOpen()) {
        DemPanel.setBusy(false);
        DemPanel.setMessage(err.message, 'error');
      } else {
        Notice.show('dem-error', 'DEM processing failed: ' + err.message, { level: 'error' });
      }
    }
  }

  /** Warn when the elevation range suggests the units choice was wrong. */
  function checkElevationUnits(range, units, demId) {
    const fmt = (m) => Math.round(m).toLocaleString();
    if (range.max > 6200) {
      Notice.show('dem-units',
        `The highest point in this DEM came out at ${fmt(range.max)} m, above any summit in North America. ` +
        (units === 'm' ? 'If the file stores feet, reprocess it with feet selected.' : 'Check the elevation units.'),
        { level: 'warn', actions: [{ label: 'Reprocess', onClick: () => reprocessLastDem(demId) }] });
    } else {
      Notice.clear('dem-units');
    }
  }

  /**
   * Warn (on the map, not just the console) when trails fall outside the
   * processed terrain, and outline the area that was processed.
   */
  function checkTrailCoverage() {
    if (!trailData || !hasTerrain()) return;
    const missing = [], partial = [];
    for (const name of trailNames) {
      const e = VertexEditor.getElevations(name);
      if (!e || e.length === 0) continue;
      const nulls = e.filter(v => v == null).length;
      if (nulls === e.length) missing.push(name);
      else if (nulls > 0) partial.push(name);
    }
    if (missing.length === 0 && partial.length === 0) {
      Notice.clear('coverage');
      return;
    }

    const b = RoiSampler.getBounds();
    TrailMap.showDemExtent({
      type: 'Feature', properties: { class: 'dem-extent' },
      geometry: { type: 'Polygon', coordinates: [[
        [b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]
      ]] }
    });

    const list = (names) => names.slice(0, 4).join(', ') + (names.length > 4 ? `, and ${names.length - 4} more` : '');
    const lines = [];
    let level = 'warn';
    if (missing.length === trailNames.length) {
      level = 'error';
      lines.push('None of the loaded trails are inside the processed terrain (dashed outline), so they have no elevations.');
      lines.push('Load a DEM that covers them, or check that the trails and DEM are for the same area.');
    } else {
      if (missing.length) lines.push(`${missing.length} trail${missing.length > 1 ? 's are' : ' is'} outside the processed terrain (dashed outline): ${list(missing)}.`);
      if (partial.length) lines.push(`${partial.length} trail${partial.length > 1 ? 's run' : ' runs'} partly outside it: ${list(partial)}.`);
    }
    Notice.show('coverage', lines.join('\n'), {
      level,
      actions: [{ label: 'Show terrain area', onClick: () => {
        try { TrailMap.getMap().fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 40 }); } catch (e) {}
      } }]
    });
  }

  /**
   * Enter app mode from cached preprocessed data.
   */
  async function enterAppModeFromCache(demId) {
    status('Loading cached terrain data...');

    // Switch to the DEM's working UTM zone. Caches from before per-DEM zones
    // were all built in NAD83 / UTM 10N. A just-processed DEM whose metadata
    // could not be stored keeps the zone it was processed in.
    const meta = await CacheStore.getMetadata(demId);
    if (meta && meta.crs) {
      Projection.setUtm(meta.crs.zone, meta.crs.south, meta.crs.datum);
    } else if (!RoiSampler.isLoadedFor(demId)) {
      Projection.setUtm(10, false, 'NAD83');
    }
    cachedDemId = demId;
    DemPreprocessor.setDemId(demId);
    Notice.clear('coverage');

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
    FilePicker.showTrailPicker((gpkgPath, geojsonPath, layerName, directData, opts) => {
      loadTrailsFromSource(gpkgPath, geojsonPath, layerName, directData, opts);
    }, { hasTrails: !!(trailData && trailData.features.length) });
  });

  // Load DEM button — passes fileSize for preprocessing decision
  document.getElementById('btn-load-dem').addEventListener('click', () => {
    FilePicker.showDemPicker((url, file, fileName, fileSize) => {
      loadDemFromSource(url, file, fileName, fileSize);
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

  function exportBaseName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${projectName ? slug(projectName) : 'trails'}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ── Project: new / open / save ──
  document.getElementById('btn-new-project').addEventListener('click', () => newProject());

  document.getElementById('btn-save-project').addEventListener('click', async () => {
    if (!projectName) {
      const first = trailNames[0];
      const name = prompt('Project name:', first ? first.replace(/\s*\(.*\)$/, '') + ' project' : 'Trail project');
      if (!name || !name.trim()) return;
      projectName = name.trim();
    }
    const s = snapshot();
    s.isDemo = false;
    isDemo = false;
    Notice.clear('demo');
    Export.download(JSON.stringify(s), slug(projectName) + '.trailproject.json', 'application/json');
    await autosaveNow();
    status(`Saved project "${projectName}"`);
  });

  const projectInput = document.getElementById('project-file-input');
  document.getElementById('btn-open-project').addEventListener('click', () => {
    projectInput.value = '';
    projectInput.click();
  });
  projectInput.addEventListener('change', async () => {
    const file = projectInput.files[0];
    if (!file) return;
    try {
      const p = JSON.parse(await file.text());
      if (p.format !== 'trail-route-editor-project') {
        throw new Error('Not a Trail Route Editor project file (for trail data, use Load Trails)');
      }
      const n = trailData ? trailData.features.length : 0;
      if (n && !isDemo && !confirm(`Open "${p.name || file.name}"? The ${n} trail${n === 1 ? '' : 's'} currently loaded will be replaced.`)) return;
      await restoreProject({ ...p, isDemo: false });
      isDemo = false;
      await autosaveNow();
      Notice.show('project', `Opened project "${p.name || file.name}" (${(p.trails.features || []).length} trails).`,
                  { level: 'info', timeout: 10000 });
    } catch (err) {
      Notice.show('project', 'Could not open project: ' + err.message, { level: 'error' });
    }
  });

  for (const [id, fn, ext] of [['btn-export', 'downloadGeoJSON', 'geojson'],
                               ['btn-export-kml', 'downloadKML', 'kml'],
                               ['btn-export-gpx', 'downloadGPX', 'gpx']]) {
    document.getElementById(id).addEventListener('click', () => {
      const data = VertexEditor.getTrailData();
      if (!data || !data.features.length) { status('No trails to export'); return; }
      const base = exportBaseName();
      Export[fn](data, base);
      status(`Exported ${base}.${ext}`);
    });
  }

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
    const hasDem = hasTerrain();
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
    const hasDem = hasTerrain();
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

      const hasDem = hasTerrain();
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
