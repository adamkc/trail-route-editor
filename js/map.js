/**
 * map.js — MapLibre GL JS setup, trail layers, basemap toggle
 */
const TrailMap = (() => {
  let map = null;
  let hillshadeBounds = null;

  // Trail colors from SimplifyTrail.R
  const TRAIL_COLORS = {
    '33N19':                       '#49E8BB',
    '33N19 Spur':                  '#9B75E2',
    'Bradford Rd':                 '#8EEF9F',
    'Lower 33N19 to Bradford Rd':  '#C30FDB',
    'Mid JC to 33N19 Spur':        '#DBE846',
    'Mid JC Trail':                '#2CA8D2',
    'Mid JC Trail Connection (1)': '#ED70B7',
    'Mid JC Trail Connection (2)': '#A1E877',
    'Underwood Connection':        '#7488DC',
    'Upper JC Trail':              '#D55D5F',
    'The Mitten':                  '#FF8C00'
  };

  // Fallback colors for unknown trail names
  const FALLBACK = ['#E41A1C','#377EB8','#4DAF4A','#984EA3','#FF7F00',
                    '#FFFF33','#A65628','#F781BF','#66C2A5','#FC8D62'];
  let fallbackIdx = 0;

  function getTrailColor(name) {
    if (TRAIL_COLORS[name]) return TRAIL_COLORS[name];
    const c = FALLBACK[fallbackIdx % FALLBACK.length];
    TRAIL_COLORS[name] = c;
    fallbackIdx++;
    return c;
  }

  async function init() {
    // Load hillshade bounds
    try {
      const resp = await fetch('data/hillshade_bounds.json');
      hillshadeBounds = await resp.json();
    } catch (e) {
      console.warn('No hillshade bounds found:', e);
    }

    // Compute center from hillshade bounds or default
    let center = [-123.1, 40.7]; // approximate default
    let zoom = 14;
    if (hillshadeBounds) {
      center = [
        (hillshadeBounds.west + hillshadeBounds.east) / 2,
        (hillshadeBounds.south + hillshadeBounds.north) / 2
      ];
    }

    map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {},
        layers: [{
          id: 'background',
          type: 'background',
          paint: { 'background-color': '#1a1a2e' }
        }]
      },
      center: center,
      zoom: zoom,
      minZoom: 8,
      maxZoom: 20,
      maxPitch: 75
    });

    await new Promise(resolve => map.on('load', resolve));

    // Scale bar
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 150, unit: 'metric' }), 'bottom-left');

    // Auto-recover from NaN/matrix errors (3D terrain + extreme zoom can corrupt the transform)
    let recovering = false;
    function recoverTransform() {
      if (recovering) return;
      recovering = true;
      console.warn('[map] Transform corrupted — auto-recovering');
      try {
        // Disable terrain temporarily to break the corruption cycle
        map.setTerrain(null);
        map.setPitch(0);
        map.setBearing(0);
        // Reset zoom/center if they're NaN
        const z = map.getZoom();
        const c = map.getCenter();
        if (isNaN(z) || z < 1) map.setZoom(13);
        if (isNaN(c.lng) || isNaN(c.lat)) {
          map.setCenter([-121.5, 45.7]); // fallback center
        }
        // Re-enable terrain after a tick
        setTimeout(() => {
          try {
            if (map.getSource('dem-terrain')) {
              map.setTerrain({ source: 'dem-terrain', exaggeration: 1.5 });
            }
          } catch (e) { /* terrain may not be set up yet */ }
          recovering = false;
        }, 200);
      } catch (e) {
        recovering = false;
      }
    }

    map.on('error', (e) => {
      const msg = e.error ? e.error.message : '';
      if (msg.includes('Invalid LngLat') || msg.includes('invert matrix')) {
        recoverTransform();
      }
    });

    // Also catch uncaught errors from scroll/zoom handlers
    window.addEventListener('error', (e) => {
      const msg = e.message || '';
      if (msg.includes('Invalid LngLat') || msg.includes('invert matrix')) {
        e.preventDefault();
        recoverTransform();
      }
    });

    // Add satellite basemap (hidden by default)
    map.addSource('satellite', {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
      ],
      tileSize: 256,
      attribution: 'ESRI World Imagery'
    });
    map.addLayer({
      id: 'satellite-layer',
      type: 'raster',
      source: 'satellite',
      layout: { visibility: 'none' }
    });

    // Add hillshade
    if (hillshadeBounds) {
      map.addSource('hillshade', {
        type: 'image',
        url: 'data/hillshade.png',
        coordinates: [
          [hillshadeBounds.west, hillshadeBounds.north],
          [hillshadeBounds.east, hillshadeBounds.north],
          [hillshadeBounds.east, hillshadeBounds.south],
          [hillshadeBounds.west, hillshadeBounds.south]
        ]
      });
      map.addLayer({
        id: 'hillshade-layer',
        type: 'raster',
        source: 'hillshade',
        paint: { 'raster-opacity': 0.90, 'raster-contrast': 0.20 }
      });
    }

    // Contour lines (populated later by ContourGenerator)
    map.addSource('contours-minor', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'contours-minor-line',
      type: 'line',
      source: 'contours-minor',
      paint: {
        'line-color': '#000000',
        'line-width': 0.4,
        'line-opacity': 0.18
      }
    });

    map.addSource('contours-major', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'contours-major-line',
      type: 'line',
      source: 'contours-major',
      paint: {
        'line-color': '#000000',
        'line-width': 0.8,
        'line-opacity': 0.40
      }
    });

    // Grade-colored segment overlay (shown when a trail is selected)
    map.addSource('grade-segments', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'grade-segments-outline',
      type: 'line',
      source: 'grade-segments',
      paint: {
        'line-color': '#000',
        'line-width': 6,
        'line-opacity': 0.5
      }
    });
    map.addLayer({
      id: 'grade-segments-line',
      type: 'line',
      source: 'grade-segments',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 4,
        'line-opacity': 1.0
      }
    });

    // Drainage risk zones overlay
    map.addSource('drainage-zones', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'drainage-zones-line',
      type: 'line',
      source: 'drainage-zones',
      paint: {
        'line-color': '#001f5c',
        'line-width': 8,
        'line-opacity': 0.85
      },
      layout: {
        'line-cap': 'round',
        'line-join': 'round'
      }
    });

    // Highlight marker for chart hover — bright and bold so it pops
    map.addSource('hover-point', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'hover-point-outer',
      type: 'circle',
      source: 'hover-point',
      paint: {
        'circle-radius': 12,
        'circle-color': '#ff2d55',
        'circle-opacity': 0.35,
        'circle-stroke-width': 0
      }
    });
    map.addLayer({
      id: 'hover-point-inner',
      type: 'circle',
      source: 'hover-point',
      paint: {
        'circle-radius': 6,
        'circle-color': '#ff2d55',
        'circle-opacity': 1,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2
      }
    });

    // Initialize draw-route preview layers
    if (typeof DrawRoute !== 'undefined') DrawRoute.init(map);

    return map;
  }

  /**
   * Enable 3D terrain using the already-loaded DEM raster.
   * Creates a custom protocol that serves Terrarium-encoded tiles from memory.
   */
  async function enable3DTerrain(exaggeration = 1.0) {
    // Remove existing terrain source if re-loading a DEM
    if (map.getSource('dem-terrain')) {
      map.setTerrain(null);
      map.removeSource('dem-terrain');
    }
    try { maplibregl.removeProtocol('dem'); } catch (e) { /* first time */ }

    // Use ROI raster if available (smaller), fall back to full DEM
    let raster = (typeof RoiSampler !== 'undefined' && RoiSampler.isLoaded())
      ? RoiSampler.getFullRaster()
      : await DemSampler.getFullRaster();
    if (!raster) { console.warn('[3D] No DEM loaded'); return; }

    const { data, width, height, originX, originY, pixelSizeX, pixelSizeY } = raster;

    // DEM bounds in WGS84
    const sw = Projection.utmToWgs84(originX, originY + height * pixelSizeY);
    const ne = Projection.utmToWgs84(originX + width * pixelSizeX, originY);
    const demBounds = { west: sw[0], south: sw[1], east: ne[0], north: ne[1] };

    // In-memory tile cache (avoids re-encoding on repeated pan/zoom)
    const tileCache = new Map();

    // Reusable canvas for tile encoding
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 256;
    tileCanvas.height = 256;
    const tileCtx = tileCanvas.getContext('2d');

    // Register custom protocol (MapLibre v4+ Promise-based API)
    maplibregl.addProtocol('dem', (params) => {
      const key = params.url;
      if (tileCache.has(key)) {
        return Promise.resolve({ data: tileCache.get(key) });
      }

      const parts = key.replace('dem://', '').split('/');
      const z = parseInt(parts[0]);
      const x = parseInt(parts[1]);
      const y = parseInt(parts[2]);

      // Tile bounds in WGS84
      const n = Math.pow(2, z);
      const tileLng0 = x / n * 360 - 180;
      const tileLng1 = (x + 1) / n * 360 - 180;
      const tileLat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
      const tileLat0 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;

      // Generate 256x256 Terrarium-encoded tile
      const tileSize = 256;
      const imgData = tileCtx.createImageData(tileSize, tileSize);
      const px = imgData.data;

      for (let ty = 0; ty < tileSize; ty++) {
        const lat = tileLat1 + (ty + 0.5) / tileSize * (tileLat0 - tileLat1);
        for (let tx = 0; tx < tileSize; tx++) {
          const lng = tileLng0 + (tx + 0.5) / tileSize * (tileLng1 - tileLng0);

          const [easting, northing] = Projection.wgs84ToUtm(lng, lat);
          const col = Math.floor((easting - originX) / pixelSizeX);
          const row = Math.floor((northing - originY) / pixelSizeY);

          let elev = 0;
          if (col >= 0 && col < width && row >= 0 && row < height) {
            const v = data[row * width + col];
            if (v !== -9999 && !isNaN(v)) elev = v;
          }

          // Terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768
          const encoded = elev + 32768;
          const idx = (ty * tileSize + tx) * 4;
          px[idx]     = Math.floor(encoded / 256);
          px[idx + 1] = Math.floor(encoded) % 256;
          px[idx + 2] = Math.floor((encoded - Math.floor(encoded)) * 256);
          px[idx + 3] = 255;
        }
      }

      tileCtx.putImageData(imgData, 0, 0);

      return new Promise(resolve => {
        tileCanvas.toBlob(blob => {
          blob.arrayBuffer().then(buf => {
            tileCache.set(key, buf);  // cache for next time
            resolve({ data: buf });
          });
        }, 'image/png');
      });
    });

    // Add raster-dem source
    map.addSource('dem-terrain', {
      type: 'raster-dem',
      tiles: ['dem://{z}/{x}/{y}'],
      tileSize: 256,
      encoding: 'terrarium',
      bounds: [demBounds.west, demBounds.south, demBounds.east, demBounds.north],
      minzoom: 10,
      maxzoom: 16
    });

    // Replace static hillshade PNG with native MapLibre hillshade from DEM
    // (the image source doesn't work properly with 3D terrain)
    if (map.getLayer('hillshade-layer')) {
      map.removeLayer('hillshade-layer');
    }
    if (map.getSource('hillshade')) {
      map.removeSource('hillshade');
    }
    // Remove old layers if re-enabling
    if (map.getLayer('native-hillshade')) map.removeLayer('native-hillshade');
    if (map.getLayer('hillshade-base')) map.removeLayer('hillshade-base');
    if (map.getSource('hillshade-base-src')) map.removeSource('hillshade-base-src');
    if (map.getSource('dem-hillshade')) map.removeSource('dem-hillshade');

    // Separate raster-dem source for hillshade (MapLibre recommends not sharing
    // a single source between terrain and hillshade for better rendering quality)
    map.addSource('dem-hillshade', {
      type: 'raster-dem',
      tiles: ['dem://{z}/{x}/{y}'],
      tileSize: 256,
      encoding: 'terrarium',
      bounds: [demBounds.west, demBounds.south, demBounds.east, demBounds.north],
      minzoom: 10,
      maxzoom: 16
    });

    // Add a white base polygon covering the DEM extent so the hillshade
    // has a light background to paint shadows/highlights onto
    map.addSource('hillshade-base-src', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [demBounds.west, demBounds.south],
            [demBounds.east, demBounds.south],
            [demBounds.east, demBounds.north],
            [demBounds.west, demBounds.north],
            [demBounds.west, demBounds.south]
          ]]
        }
      }
    });

    // Insert base + hillshade above satellite but below contours/trails
    const insertBefore = map.getLayer('contours-minor-line') ? 'contours-minor-line'
                       : map.getLayer('trail-outline') ? 'trail-outline'
                       : undefined;

    map.addLayer({
      id: 'hillshade-base',
      type: 'fill',
      source: 'hillshade-base-src',
      paint: { 'fill-color': '#f0f0f0' }
    }, insertBefore);

    map.addLayer({
      id: 'native-hillshade',
      type: 'hillshade',
      source: 'dem-hillshade',
      paint: {
        'hillshade-exaggeration': 0.5,
        'hillshade-shadow-color': '#2a2a2a',
        'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#505050',
        'hillshade-illumination-direction': 315,
        'hillshade-illumination-anchor': 'viewport'
      }
    }, insertBefore);

    // Enable terrain (no auto-pitch — user controls tilt via right-click drag)
    map.setTerrain({ source: 'dem-terrain', exaggeration });

    console.log('[3D] Terrain enabled with exaggeration:', exaggeration);
  }

  /**
   * Show or hide the hover highlight point on the map.
   * lngLat: [lng, lat] or null to hide.
   */
  function setHoverPoint(lngLat) {
    const src = map.getSource('hover-point');
    if (!src) return;
    if (lngLat) {
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: lngLat },
          properties: {}
        }]
      });
    } else {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
  }

  function removeLayers() {
    // Remove trail + vertex layers and sources for clean reload
    // (grade-segments are kept — managed separately via show/clearGradeSegments)
    ['vertex-circles', 'trail-lines', 'trail-outline'].forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    ['vertices', 'trails'].forEach(id => {
      if (map.getSource(id)) map.removeSource(id);
    });
    // Clear grade segment data but keep layers intact
    clearGradeSegments();
  }

  /**
   * Show grade-colored segments on the map for a selected trail.
   * segments: array from TrailMetrics.compute()
   * coords: the trail's coordinate array [lng, lat]
   */
  function showGradeSegments(segments, coords) {
    const src = map.getSource('grade-segments');
    if (!src) return;

    const features = [];
    for (const seg of segments) {
      const i = seg.index;
      if (i + 1 >= coords.length) continue;
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [coords[i], coords[i + 1]]
        },
        properties: { color: seg.gradeClass.color }
      });
    }

    src.setData({ type: 'FeatureCollection', features });

    // Ensure grade segments render above trail lines but below hover/vertex layers
    const anchor = map.getLayer('vertex-circles') ? 'vertex-circles'
                 : map.getLayer('hover-point-outer') ? 'hover-point-outer'
                 : undefined;
    if (map.getLayer('grade-segments-outline')) map.moveLayer('grade-segments-outline', anchor);
    if (map.getLayer('grade-segments-line'))    map.moveLayer('grade-segments-line', anchor);
  }

  function clearGradeSegments() {
    const src = map.getSource('grade-segments');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }

  function showDrainageZones(zones, coords) {
    const src = map.getSource('drainage-zones');
    if (!src || !coords || coords.length < 2) return;

    const features = [];
    for (const zone of zones) {
      const lineCoords = [];
      for (let i = zone.startIdx; i <= zone.endIdx + 1 && i < coords.length; i++) {
        lineCoords.push(coords[i]);
      }
      if (lineCoords.length >= 2) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: lineCoords },
          properties: {
            length: zone.length,
            avgAngle: zone.avgAngle
          }
        });
      }
    }
    src.setData({ type: 'FeatureCollection', features });

    // Ensure drainage layer renders on top of trails and grade segments
    const anchor = map.getLayer('vertex-circles') ? 'vertex-circles'
                 : map.getLayer('hover-point-outer') ? 'hover-point-outer'
                 : undefined;
    if (map.getLayer('drainage-zones-line')) map.moveLayer('drainage-zones-line', anchor);
  }

  function clearDrainageZones() {
    const src = map.getSource('drainage-zones');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }

  function addTrails(trailsGeoJson) {
    // Remove existing trail layers first
    removeLayers();

    // Build color match expression
    const colorExpr = buildColorExpression(trailsGeoJson);

    map.addSource('trails', {
      type: 'geojson',
      data: trailsGeoJson
    });

    // Trail outline (wider, darker for contrast)
    map.addLayer({
      id: 'trail-outline',
      type: 'line',
      source: 'trails',
      paint: {
        'line-color': '#000',
        'line-width': 5,
        'line-opacity': 0.5
      }
    });

    // Trail line (colored by name, vivid)
    map.addLayer({
      id: 'trail-lines',
      type: 'line',
      source: 'trails',
      paint: {
        'line-color': colorExpr,
        'line-width': 3,
        'line-opacity': 1.0
      }
    });

    // Ensure hover-point layers stay on top of trail layers
    if (map.getLayer('hover-point-outer')) map.moveLayer('hover-point-outer');
    if (map.getLayer('hover-point-inner')) map.moveLayer('hover-point-inner');
  }

  function buildColorExpression(trailsGeoJson) {
    const names = new Set();
    for (const f of trailsGeoJson.features) {
      const n = f.properties.Name || f.properties.name;
      if (n) names.add(n);
    }

    const expr = ['match', ['coalesce', ['get', 'Name'], ['get', 'name'], '']];
    for (const name of names) {
      expr.push(name, getTrailColor(name));
    }
    expr.push('#888'); // default
    return expr;
  }

  /**
   * Rebuild the trail color expression without removing/re-adding layers.
   * Use when trails are added/removed dynamically (e.g. optimizer).
   */
  function updateTrailColors(trailsGeoJson) {
    const colorExpr = buildColorExpression(trailsGeoJson);
    if (map.getLayer('trail-lines')) {
      map.setPaintProperty('trail-lines', 'line-color', colorExpr);
    }
  }

  function showBasemap(type) {
    if (type === 'satellite') {
      map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
      if (map.getLayer('hillshade-layer')) map.setLayoutProperty('hillshade-layer', 'visibility', 'none');
      if (map.getLayer('native-hillshade')) map.setLayoutProperty('native-hillshade', 'visibility', 'none');
      if (map.getLayer('hillshade-base')) map.setLayoutProperty('hillshade-base', 'visibility', 'none');
    } else {
      map.setLayoutProperty('satellite-layer', 'visibility', 'none');
      if (map.getLayer('hillshade-layer')) map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
      if (map.getLayer('native-hillshade')) map.setLayoutProperty('native-hillshade', 'visibility', 'visible');
      if (map.getLayer('hillshade-base')) map.setLayoutProperty('hillshade-base', 'visibility', 'visible');
    }
  }

  function fitToTrails(trailsGeoJson) {
    // Compute bounds from all trail coordinates
    let minLng = Infinity, maxLng = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    for (const f of trailsGeoJson.features) {
      for (const coord of f.geometry.coordinates) {
        const lng = coord[0], lat = coord[1];
        if (isNaN(lng) || isNaN(lat) || !isFinite(lng) || !isFinite(lat)) continue;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }

    if (minLng < Infinity && isFinite(minLng) && isFinite(maxLng) &&
        isFinite(minLat) && isFinite(maxLat)) {
      try {
        map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 40 });
      } catch (e) {
        console.warn('[map] fitBounds failed:', e.message);
      }
    }
  }

  /**
   * Reset the map view: pitch to 0, bearing to 0, fit to trail bounds.
   * Recovers from "falling through the map" or disoriented 3D views.
   */
  function recenter(trailsGeoJson) {
    map.setPitch(0);
    map.setBearing(0);
    if (trailsGeoJson && trailsGeoJson.features && trailsGeoJson.features.length > 0) {
      fitToTrails(trailsGeoJson);
    }
  }

  /**
   * Set contour GeoJSON (output of ContourGenerator.generate()).
   */
  function showContours(contourGeoJson) {
    const minor = contourGeoJson.features.find(f => f.properties.class === 'minor');
    const major = contourGeoJson.features.find(f => f.properties.class === 'major');

    const srcMinor = map.getSource('contours-minor');
    const srcMajor = map.getSource('contours-major');
    if (srcMinor && minor) srcMinor.setData({ type: 'FeatureCollection', features: [minor] });
    if (srcMajor && major) srcMajor.setData({ type: 'FeatureCollection', features: [major] });
  }

  // ── Tiled contour system (for preprocessed DEMs) ──

  let _tiledContourDemId = null;
  let _vectorContourDebounce = null;

  /**
   * Set up tiled contour layers from cached vector tiles.
   * Zoomed out: just hillshade, no contours.
   * Zoomed in (14+): vector contours fade in from cached tiles.
   */
  async function enableTiledContours(demId) {
    _tiledContourDemId = demId;

    // Vector contours only appear when zoomed in — hillshade handles overview
    if (map.getLayer('contours-minor-line')) {
      map.setPaintProperty('contours-minor-line', 'line-opacity', [
        'interpolate', ['linear'], ['zoom'], 14.5, 0, 15, 0.18
      ]);
    }
    if (map.getLayer('contours-major-line')) {
      map.setPaintProperty('contours-major-line', 'line-opacity', [
        'interpolate', ['linear'], ['zoom'], 14.5, 0, 15, 0.40
      ]);
    }

    // Load vector tiles for current viewport
    map.on('moveend', () => loadVectorContoursForViewport());
    map.on('zoomend', () => loadVectorContoursForViewport());
    loadVectorContoursForViewport();
  }

  async function loadVectorContoursForViewport() {
    if (!_tiledContourDemId) return;
    if (map.getZoom() < 14.5) return; // only load vector tiles when zoomed well in

    // Debounce to avoid rapid-fire loads during panning
    clearTimeout(_vectorContourDebounce);
    _vectorContourDebounce = setTimeout(async () => {
      const bounds = map.getBounds();
      const z = 13; // vector tiles stored at zoom 13
      const tiles = DemPreprocessor.getTilesForBounds({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth()
      }, z);

      const allMinor = [];
      const allMajor = [];
      for (const tile of tiles) {
        const key = `${_tiledContourDemId}/${tile.z}/${tile.x}/${tile.y}`;
        const stored = await CacheStore.getTile('vector-tiles', key);
        if (!stored) continue;
        try {
          const geojson = JSON.parse(stored);
          for (const f of geojson.features) {
            if (f.properties.class === 'minor') allMinor.push(f);
            else if (f.properties.class === 'major') allMajor.push(f);
          }
        } catch (e) {}
      }

      const srcMinor = map.getSource('contours-minor');
      const srcMajor = map.getSource('contours-major');
      if (srcMinor) srcMinor.setData({ type: 'FeatureCollection', features: allMinor });
      if (srcMajor) srcMajor.setData({ type: 'FeatureCollection', features: allMajor });
    }, 200);
  }

  /**
   * Enable 3D terrain from cached tiles instead of in-memory raster.
   */
  async function enable3DTerrainFromCache(demId, exaggeration) {
    exaggeration = exaggeration || 1.5;

    if (map.getSource('dem-terrain')) {
      map.setTerrain(null);
      map.removeSource('dem-terrain');
    }
    try { maplibregl.removeProtocol('dem'); } catch (e) {}

    const terrainTileCache = new Map();

    maplibregl.addProtocol('dem', async (params) => {
      const key = params.url.replace('dem://', '');
      const cacheKey = demId + '/' + key;
      if (terrainTileCache.has(cacheKey)) {
        return { data: terrainTileCache.get(cacheKey) };
      }
      const data = await CacheStore.getTile('terrain-tiles', cacheKey);
      if (data) {
        terrainTileCache.set(cacheKey, data);
        return { data };
      }
      return { data: FLAT_TERRAIN_PNG };
    });

    // Get bounds from cached metadata
    const meta = await CacheStore.getMetadata(demId);
    const demBounds = meta ? (meta.demExtent || meta.roiBounds) : null;

    const sourceOpts = {
      type: 'raster-dem',
      tiles: ['dem://{z}/{x}/{y}'],
      tileSize: 256,
      encoding: 'terrarium',
      minzoom: 10,
      maxzoom: 14
    };
    if (demBounds) {
      sourceOpts.bounds = [demBounds.west, demBounds.south, demBounds.east, demBounds.north];
    }

    map.addSource('dem-terrain', sourceOpts);

    // Hillshade setup (same as enable3DTerrain)
    if (map.getLayer('hillshade-layer')) map.removeLayer('hillshade-layer');
    if (map.getSource('hillshade')) map.removeSource('hillshade');
    if (map.getLayer('native-hillshade')) map.removeLayer('native-hillshade');
    if (map.getLayer('hillshade-base')) map.removeLayer('hillshade-base');
    if (map.getSource('hillshade-base-src')) map.removeSource('hillshade-base-src');
    if (map.getSource('dem-hillshade')) map.removeSource('dem-hillshade');

    map.addSource('dem-hillshade', { ...sourceOpts });

    if (demBounds) {
      map.addSource('hillshade-base-src', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [demBounds.west, demBounds.south], [demBounds.east, demBounds.south],
              [demBounds.east, demBounds.north], [demBounds.west, demBounds.north],
              [demBounds.west, demBounds.south]
            ]]
          }
        }
      });

      const insertBefore = map.getLayer('contours-minor-line') ? 'contours-minor-line'
                         : map.getLayer('contours-raster-layer') ? 'contours-raster-layer'
                         : map.getLayer('trail-outline') ? 'trail-outline'
                         : undefined;

      map.addLayer({
        id: 'hillshade-base',
        type: 'fill',
        source: 'hillshade-base-src',
        paint: { 'fill-color': '#f0f0f0' }
      }, insertBefore);

      map.addLayer({
        id: 'native-hillshade',
        type: 'hillshade',
        source: 'dem-hillshade',
        paint: {
          'hillshade-exaggeration': 0.5,
          'hillshade-shadow-color': '#2a2a2a',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#505050',
          'hillshade-illumination-direction': 315,
          'hillshade-illumination-anchor': 'viewport'
        }
      }, insertBefore);
    }

    map.setTerrain({ source: 'dem-terrain', exaggeration });
    console.log('[3D] Terrain enabled from cache with exaggeration:', exaggeration);
  }

  /**
   * Show the DEM extent as a dashed rectangle during preprocessing.
   */
  function showDemExtent(geojson) {
    if (map.getSource('dem-extent')) {
      map.getSource('dem-extent').setData(geojson);
      return;
    }
    map.addSource('dem-extent', { type: 'geojson', data: geojson });
    map.addLayer({
      id: 'dem-extent-line',
      type: 'line',
      source: 'dem-extent',
      paint: {
        'line-color': '#4488ff',
        'line-width': 2,
        'line-dasharray': [4, 4],
        'line-opacity': 0.7
      }
    });
  }

  function clearDemExtent() {
    if (map.getLayer('dem-extent-line')) map.removeLayer('dem-extent-line');
    if (map.getSource('dem-extent')) map.removeSource('dem-extent');
  }

  // Minimal transparent 1x1 PNG for missing tiles
  const TRANSPARENT_PNG = (() => {
    const arr = new Uint8Array([
      0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A, // PNG header
      0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
      0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
      0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,
      0x89,0x00,0x00,0x00,0x0A,0x49,0x44,0x41,
      0x54,0x78,0x9C,0x62,0x00,0x00,0x00,0x02,
      0x00,0x01,0xE5,0x27,0xDE,0xFC,0x00,0x00,
      0x00,0x00,0x49,0x45,0x4E,0x44,0xAE,0x42,
      0x60,0x82
    ]);
    return arr.buffer;
  })();

  // Flat terrain PNG (elevation 0 in Terrarium encoding)
  const FLAT_TERRAIN_PNG = TRANSPARENT_PNG; // will be treated as 0 elev by MapLibre

  function getMap() { return map; }
  function getTrailColors() { return TRAIL_COLORS; }

  /**
   * Dim non-selected trail lines when a specific trail is selected.
   * When trailName is null or '__all__', restore full opacity on all trails.
   */
  function highlightTrail(trailName) {
    if (!map.getLayer('trail-lines')) return;
    if (!trailName || trailName === '__all__') {
      // Show all trails at full opacity
      map.setPaintProperty('trail-lines', 'line-opacity', 1.0);
      map.setPaintProperty('trail-outline', 'line-opacity', 0.5);
    } else {
      // Selected trail full opacity, others dimmed
      map.setPaintProperty('trail-lines', 'line-opacity', [
        'case',
        ['any',
          ['==', ['get', 'Name'], trailName],
          ['==', ['get', 'name'], trailName]
        ],
        1.0,
        0.2  // dim non-selected trails
      ]);
      map.setPaintProperty('trail-outline', 'line-opacity', [
        'case',
        ['any',
          ['==', ['get', 'Name'], trailName],
          ['==', ['get', 'name'], trailName]
        ],
        0.5,
        0.1
      ]);
    }
  }

  return { init, addTrails, removeLayers, updateTrailColors, showBasemap, fitToTrails, recenter, setHoverPoint, showGradeSegments, clearGradeSegments, showDrainageZones, clearDrainageZones, showContours, enable3DTerrain, enable3DTerrainFromCache, enableTiledContours, showDemExtent, clearDemExtent, getMap, getTrailColor, getTrailColors, highlightTrail };
})();
