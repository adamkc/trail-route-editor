/**
 * dem-preprocessor.js — Two-phase DEM processing pipeline.
 *
 * Preprocess Mode:
 *   1. Parse GeoTIFF header (zero raster memory)
 *   2. User loads trails → defines ROI (bounding box + buffer)
 *   3. Windowed read of ROI from GeoTIFF (~5-20 MB vs 200+ MB)
 *   4. Generate contour tiles (raster + vector) serially via Web Worker
 *   5. Build aspect grid from ROI
 *   6. Generate terrain tiles from ROI
 *   7. Cache everything to IndexedDB
 *   8. Release GeoTIFF → GC reclaims ~250 MB
 *
 * App Mode:
 *   All consumers (contours, terrain, optimizer) read from cache.
 */
const DemPreprocessor = (() => {
  let demId = null;
  let geoTransform = null; // from DemSampler.initHeaderOnly
  let roiRaster = null;    // the clipped raster (temporary during preprocessing)

  // Size threshold: DEMs above this trigger preprocessing mode
  const LARGE_DEM_BYTES = 80 * 1024 * 1024; // 80 MB

  /**
   * Check if a DEM file should use the preprocessing pipeline.
   */
  function shouldPreprocess(fileSize) {
    return fileSize >= LARGE_DEM_BYTES;
  }

  /**
   * Step 1: Load GeoTIFF header only. Returns extent info.
   */
  async function loadHeader(source, fileName, fileSize) {
    demId = CacheStore.makeDemId(fileName, fileSize || 0);
    geoTransform = await DemSampler.initHeaderOnly(source, fileName);
    return {
      demId,
      ...geoTransform,
      extent: getExtentWgs84()
    };
  }

  /**
   * Get DEM extent in WGS84 as a GeoJSON polygon.
   */
  function getExtentGeoJSON() {
    const b = getExtentWgs84();
    if (!b) return null;
    return {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [b.west, b.south], [b.east, b.south],
          [b.east, b.north], [b.west, b.north],
          [b.west, b.south]
        ]]
      },
      properties: { class: 'dem-extent' }
    };
  }

  function getExtentWgs84() {
    if (!geoTransform) return null;
    const { originX, originY, pixelSizeX, pixelSizeY, width, height } = geoTransform;
    const sw = Projection.utmToWgs84(originX, originY + height * pixelSizeY);
    const ne = Projection.utmToWgs84(originX + width * pixelSizeX, originY);
    return { west: sw[0], south: sw[1], east: ne[0], north: ne[1] };
  }

  /**
   * Compute ROI from trail bounding box + buffer (in meters).
   * Returns pixel window [x0, y0, x1, y1].
   */
  function computeROI(trailsGeoJson, bufferMeters) {
    bufferMeters = bufferMeters || 500;
    let minLng = Infinity, maxLng = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    // Recursively extract [lng, lat] pairs from any GeoJSON coordinate structure
    function visitCoords(arr) {
      if (!Array.isArray(arr) || arr.length === 0) return;
      // If first element is a number, this is a coordinate [lng, lat]
      if (typeof arr[0] === 'number') {
        const lng = arr[0], lat = arr[1];
        if (isFinite(lng) && isFinite(lat)) {
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
        return;
      }
      // Otherwise it's nested — recurse
      for (const child of arr) visitCoords(child);
    }

    for (const f of trailsGeoJson.features) {
      if (!f.geometry || !f.geometry.coordinates) continue;
      visitCoords(f.geometry.coordinates);
    }
    if (!isFinite(minLng)) return null;

    // Convert to UTM and add buffer
    const [wE, sN] = Projection.wgs84ToUtm(minLng, minLat);
    const [eE, nN] = Projection.wgs84ToUtm(maxLng, maxLat);
    const utmBbox = {
      west: wE - bufferMeters,
      south: sN - bufferMeters,
      east: eE + bufferMeters,
      north: nN + bufferMeters
    };

    return DemSampler.utmBboxToPixelWindow(utmBbox);
  }

  /**
   * Step 2a: Extract ROI from the loaded GeoTIFF using a windowed read.
   */
  async function extractROI(trailsGeoJson, bufferMeters) {
    const window = computeROI(trailsGeoJson, bufferMeters);
    if (!window) throw new Error('Could not compute ROI from trails');
    roiRaster = await DemSampler.readWindow(window[0], window[1], window[2], window[3]);
    return roiRaster;
  }

  /**
   * Step 2b: Use the full DEM extent as the ROI (for small DEMs or when no trails loaded).
   */
  async function extractFullExtent() {
    const gt = DemSampler.getGeoTransform();
    if (!gt) throw new Error('DEM not loaded');
    roiRaster = await DemSampler.readWindow(0, 0, gt.width, gt.height);
    return roiRaster;
  }

  /**
   * Step 3: Run the full preprocessing pipeline.
   * Processes serially to minimize peak RAM.
   */
  async function runPreprocessing(callbacks) {
    const { onStep, onTileProgress, onComplete } = callbacks || {};
    if (!roiRaster) throw new Error('No ROI extracted — call extractROI first');
    if (!demId) throw new Error('No demId — call loadHeader first');

    const roi = roiRaster;

    // Clear any old cached data for this DEM before writing new data
    const hadOldCache = await CacheStore.hasCachedDem(demId);
    if (hadOldCache) {
      if (onStep) onStep('clear', 'Clearing old cache...');
      await CacheStore.clearDem(demId);
    }

    // ── 3a. Save ROI raster to cache ──
    if (onStep) onStep('roi', 'Saving ROI raster to cache...');
    await CacheStore.putGrid('roi-raster', demId, roi);

    // ── 3b. Build aspect grid from ROI ──
    if (onStep) onStep('aspect', 'Building aspect grid...');
    const aspect = buildAspectGridFromRaster(roi);
    await CacheStore.putGrid('aspect-grid', demId, aspect);
    // Free aspect data immediately
    aspect.data = null;

    // ── 3c. Generate contour tiles via Web Worker (serial) ──
    if (onStep) onStep('contours', 'Generating contour tiles...');
    await generateContourTiles(roi, demId, onTileProgress);

    // ── 3d. Generate terrain tiles ──
    if (onStep) onStep('terrain', 'Generating terrain tiles...');
    await generateTerrainTiles(roi, demId, onTileProgress);

    // ── 3e. Save metadata ──
    const bounds = RoiSampler.isLoaded() ? RoiSampler.getBounds() : getExtentWgs84();
    await CacheStore.putMetadata(demId, {
      roiWidth: roi.width,
      roiHeight: roi.height,
      originX: roi.originX,
      originY: roi.originY,
      pixelSizeX: roi.pixelSizeX,
      pixelSizeY: roi.pixelSizeY,
      demExtent: getExtentWgs84(),
      roiBounds: bounds
    });

    if (onComplete) onComplete();
    console.log('[Preprocessor] Pipeline complete for DEM:', demId);
  }

  /**
   * Build aspect grid from a raster (same math as spring-mass.js but on ROI).
   */
  function buildAspectGridFromRaster(raster) {
    const { data, width, height, pixelSizeX, pixelSizeY } = raster;
    const aspect = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        if (row === 0 || row === height - 1 || col === 0 || col === width - 1) {
          aspect[idx] = NaN;
          continue;
        }
        const left  = data[row * width + (col - 1)];
        const right = data[row * width + (col + 1)];
        const up    = data[(row - 1) * width + col];
        const down  = data[(row + 1) * width + col];
        if (isNaN(left) || isNaN(right) || isNaN(up) || isNaN(down) ||
            left === -9999 || right === -9999 || up === -9999 || down === -9999) {
          aspect[idx] = NaN;
          continue;
        }
        const dzdx = (right - left) / (2 * Math.abs(pixelSizeX));
        const dzdy = (down - up) / (2 * Math.abs(pixelSizeY));
        aspect[idx] = Math.atan2(-dzdx, dzdy);
      }
    }
    return {
      data: aspect,
      width, height,
      originX: raster.originX,
      originY: raster.originY,
      pixelSizeX: raster.pixelSizeX,
      pixelSizeY: raster.pixelSizeY,
      pxX: raster.pixelSizeX,
      pxY: raster.pixelSizeY
    };
  }

  // ── Contour tile generation ──

  /**
   * Compute which web-mercator tiles overlap the ROI at a given zoom level.
   */
  function getTilesForBounds(bounds, zoom) {
    const { west, south, east, north } = bounds;
    const n = Math.pow(2, zoom);

    const xMin = Math.floor((west + 180) / 360 * n);
    const xMax = Math.floor((east + 180) / 360 * n);
    const yMin = Math.floor((1 - Math.log(Math.tan(north * Math.PI / 180) + 1 / Math.cos(north * Math.PI / 180)) / Math.PI) / 2 * n);
    const yMax = Math.floor((1 - Math.log(Math.tan(south * Math.PI / 180) + 1 / Math.cos(south * Math.PI / 180)) / Math.PI) / 2 * n);

    const tiles = [];
    for (let x = Math.max(0, xMin); x <= Math.min(n - 1, xMax); x++) {
      for (let y = Math.max(0, yMin); y <= Math.min(n - 1, yMax); y++) {
        tiles.push({ z: zoom, x, y });
      }
    }
    return tiles;
  }

  /**
   * Get the WGS84 bounds of a web-mercator tile.
   */
  function tileBoundsWgs84(z, x, y) {
    const n = Math.pow(2, z);
    const lng0 = x / n * 360 - 180;
    const lng1 = (x + 1) / n * 360 - 180;
    const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    const lat0 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
    return { west: lng0, south: lat0, east: lng1, north: lat1 };
  }

  /**
   * Extract a sub-region of the ROI raster for a given tile's geographic extent.
   * Returns { data, width, height, originX, originY, pixelSizeX, pixelSizeY } or null.
   */
  function extractTileRaster(roi, tileBounds) {
    // Convert tile bounds (WGS84) to UTM
    const [wE, sN] = Projection.wgs84ToUtm(tileBounds.west, tileBounds.south);
    const [eE, nN] = Projection.wgs84ToUtm(tileBounds.east, tileBounds.north);

    // Convert to pixel coords within the ROI
    const col0 = Math.floor((wE - roi.originX) / roi.pixelSizeX);
    const col1 = Math.ceil((eE - roi.originX) / roi.pixelSizeX);
    // Note: pixelSizeY is negative
    const row0 = Math.floor((nN - roi.originY) / roi.pixelSizeY);
    const row1 = Math.ceil((sN - roi.originY) / roi.pixelSizeY);

    const rMin = Math.max(0, Math.min(row0, row1));
    const rMax = Math.min(roi.height, Math.max(row0, row1));
    const cMin = Math.max(0, Math.min(col0, col1));
    const cMax = Math.min(roi.width, Math.max(col0, col1));

    const w = cMax - cMin;
    const h = rMax - rMin;
    if (w <= 1 || h <= 1) return null;

    // Copy sub-region
    const sub = new Float32Array(w * h);
    for (let r = 0; r < h; r++) {
      const srcOffset = (rMin + r) * roi.width + cMin;
      sub.set(roi.data.subarray(srcOffset, srcOffset + w), r * w);
    }

    return {
      data: sub,
      width: w,
      height: h,
      originX: roi.originX + cMin * roi.pixelSizeX,
      originY: roi.originY + rMin * roi.pixelSizeY,
      pixelSizeX: roi.pixelSizeX,
      pixelSizeY: roi.pixelSizeY
    };
  }

  /**
   * Generate raster contour tiles (zoom 10-13) and vector contour tiles (zoom 15)
   * using the Web Worker. Processes tiles serially.
   */
  async function generateContourTiles(roi, demId, onProgress) {
    // Compute ROI bounds in WGS84
    const sw = Projection.utmToWgs84(roi.originX, roi.originY + roi.height * roi.pixelSizeY);
    const ne = Projection.utmToWgs84(roi.originX + roi.width * roi.pixelSizeX, roi.originY);
    const bounds = { west: sw[0], south: sw[1], east: ne[0], north: ne[1] };

    // Vector contour tiles only (shown when zoomed in)
    const vectorZooms = [13];
    const jobs = [];

    for (const z of vectorZooms) {
      for (const tile of getTilesForBounds(bounds, z)) {
        jobs.push({ ...tile, format: 'vector' });
      }
    }

    if (jobs.length === 0) return;

    // Create worker
    const worker = new Worker('js/contour-worker.js');
    let completed = 0;

    for (const job of jobs) {
      const tb = tileBoundsWgs84(job.z, job.x, job.y);
      const tileRaster = extractTileRaster(roi, tb);
      if (!tileRaster) {
        completed++;
        continue;
      }

      const tileKey = `${demId}/${job.z}/${job.x}/${job.y}`;

      // Send to worker and wait for result (serial)
      await new Promise((resolve, reject) => {
        worker.onmessage = async (e) => {
          const msg = e.data;
          if (msg.type === 'error') {
            console.warn('[Contours] Tile error:', msg.tileKey, msg.message);
            resolve();
            return;
          }

          if (msg.format === 'raster') {
            // Convert RGBA pixel data to PNG blob via OffscreenCanvas or fallback
            const ts = msg.result.tileSize;
            const pixels = new Uint8ClampedArray(msg.result.pixels);
            const pngBuf = await pixelsToPng(pixels, ts);
            if (pngBuf) {
              await CacheStore.putTile('raster-tiles', tileKey, pngBuf);
            }
          } else if (msg.format === 'vector') {
            // Convert UTM coords to WGS84 and store as GeoJSON
            const geojson = convertVectorResultToGeoJSON(msg.result);
            await CacheStore.putTile('vector-tiles', tileKey, JSON.stringify(geojson));
          }

          completed++;
          if (onProgress) onProgress(completed, jobs.length, 'contours');
          resolve();
        };
        worker.onerror = (err) => {
          console.warn('[Contours] Worker error:', err);
          completed++;
          resolve();
        };

        // Transfer the ArrayBuffer to avoid copying
        const dataBuffer = tileRaster.data.buffer.slice(0);
        worker.postMessage({
          type: 'generateTile',
          tileKey,
          data: dataBuffer,
          width: tileRaster.width,
          height: tileRaster.height,
          originX: tileRaster.originX,
          originY: tileRaster.originY,
          pixelSizeX: tileRaster.pixelSizeX,
          pixelSizeY: tileRaster.pixelSizeY,
          interval: job.format === 'raster' ? 10 : 2,
          format: job.format,
          tileSize: 256,
          simplifyTolerance: 1.0 // 1 meter in UTM space
        }, [dataBuffer]);
      });

      // Null the tile raster to free it before next iteration
      tileRaster.data = null;
    }

    worker.terminate();
    console.log(`[Contours] Generated ${completed} tiles`);
  }

  /**
   * Convert RGBA pixels to a PNG ArrayBuffer using Canvas.
   */
  async function pixelsToPng(pixels, size) {
    try {
      // Try OffscreenCanvas first (no DOM dependency)
      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        const imgData = new ImageData(pixels, size, size);
        ctx.putImageData(imgData, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return await blob.arrayBuffer();
      }
    } catch (e) {}

    // Fallback: regular canvas
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imgData = new ImageData(pixels, size, size);
    ctx.putImageData(imgData, 0, 0);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (blob) blob.arrayBuffer().then(resolve);
        else resolve(null);
      }, 'image/png');
    });
  }

  /**
   * Convert vector contour result (UTM coords) to GeoJSON with WGS84 coords.
   */
  function convertVectorResultToGeoJSON(result) {
    const features = [];
    const processLines = (lines, cls) => {
      const allCoords = [];
      for (const line of lines) {
        const coords = line.coords.map(([e, n]) => {
          const [lng, lat] = Projection.utmToWgs84(e, n);
          return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
        });
        if (coords.length >= 2) allCoords.push(coords);
      }
      if (allCoords.length > 0) {
        features.push({
          type: 'Feature',
          geometry: { type: 'MultiLineString', coordinates: allCoords },
          properties: { class: cls }
        });
      }
    };
    processLines(result.minorCoords, 'minor');
    processLines(result.majorCoords, 'major');
    return { type: 'FeatureCollection', features };
  }

  // ── Terrain tile generation ──

  async function generateTerrainTiles(roi, demId, onProgress) {
    const sw = Projection.utmToWgs84(roi.originX, roi.originY + roi.height * roi.pixelSizeY);
    const ne = Projection.utmToWgs84(roi.originX + roi.width * roi.pixelSizeX, roi.originY);
    const bounds = { west: sw[0], south: sw[1], east: ne[0], north: ne[1] };

    const zooms = [10, 12, 14];
    const allTiles = [];
    for (const z of zooms) {
      for (const tile of getTilesForBounds(bounds, z)) {
        allTiles.push(tile);
      }
    }

    // Reusable canvas for Terrarium encoding
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    let completed = 0;

    for (const tile of allTiles) {
      const tileKey = `${demId}/${tile.z}/${tile.x}/${tile.y}`;
      const tb = tileBoundsWgs84(tile.z, tile.x, tile.y);

      const imgData = ctx.createImageData(256, 256);
      const px = imgData.data;

      for (let ty = 0; ty < 256; ty++) {
        const lat = tb.north + (ty + 0.5) / 256 * (tb.south - tb.north);
        for (let tx = 0; tx < 256; tx++) {
          const lng = tb.west + (tx + 0.5) / 256 * (tb.east - tb.west);
          const [easting, northing] = Projection.wgs84ToUtm(lng, lat);

          // Sample from ROI raster
          const col = Math.floor((easting - roi.originX) / roi.pixelSizeX);
          const row = Math.floor((northing - roi.originY) / roi.pixelSizeY);
          let elev = 0;
          if (col >= 0 && col < roi.width && row >= 0 && row < roi.height) {
            const v = roi.data[row * roi.width + col];
            if (v !== -9999 && !isNaN(v)) elev = v;
          }

          // Terrarium encoding
          const encoded = elev + 32768;
          const idx = (ty * 256 + tx) * 4;
          px[idx]     = Math.floor(encoded / 256);
          px[idx + 1] = Math.floor(encoded) % 256;
          px[idx + 2] = Math.floor((encoded - Math.floor(encoded)) * 256);
          px[idx + 3] = 255;
        }
      }

      ctx.putImageData(imgData, 0, 0);
      const pngBuf = await new Promise(resolve => {
        canvas.toBlob(blob => blob.arrayBuffer().then(resolve), 'image/png');
      });
      await CacheStore.putTile('terrain-tiles', tileKey, pngBuf);

      completed++;
      if (onProgress) onProgress(completed, allTiles.length, 'terrain');
    }

    console.log(`[Terrain] Generated ${completed} tiles`);
  }

  /**
   * Release all preprocessing memory. Called after pipeline completes.
   */
  function releaseMemory() {
    roiRaster = null;
    geoTransform = null;
    DemSampler.release();
    console.log('[Preprocessor] Memory released');
  }

  function getDemId() { return demId; }
  function setDemId(id) { demId = id; }

  return {
    shouldPreprocess, loadHeader, getExtentGeoJSON, getExtentWgs84,
    computeROI, extractROI, extractFullExtent, runPreprocessing,
    releaseMemory, getDemId, setDemId,
    tileBoundsWgs84, getTilesForBounds
  };
})();
