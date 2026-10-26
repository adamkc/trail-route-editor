/**
 * dem-preprocessor.js — DEM processing pipeline.
 *
 *   1. Parse GeoTIFF header (zero raster memory), identify CRS and units
 *   2. Choose the processing area: around loaded trails, or the full DEM
 *   3. Windowed read of that area; DEMs not already in UTM are reprojected
 *      into the working UTM zone
 *   4. Build aspect grid, contour tiles (Web Worker), and terrain tiles
 *   5. Cache everything to IndexedDB, then release the GeoTIFF
 *
 * App Mode:
 *   All consumers (contours, terrain, optimizer) read from cache.
 */
const DemPreprocessor = (() => {
  let demId = null;
  let header = null;       // from DemSampler.initHeaderOnly
  let crsInfo = null;      // from DemCrs.describe
  let transformer = null;  // DEM CRS <-> WGS84
  let verticalUnits = 'm';
  let roiRaster = null;    // processed raster in working UTM (temporary during preprocessing)

  // Uncompressed raster size above which "around trails" is the default area
  const LARGE_DEM_BYTES = 80 * 1024 * 1024;
  // Largest processed raster the browser is asked to hold (~240 MB as Float32)
  const MAX_ROI_PIXELS = 60e6;
  // Grid step (pixels) for the approximate reprojection transform
  const WARP_STEP = 16;

  /**
   * Step 1: Load GeoTIFF header only and identify its CRS.
   * Returns header info plus { crs, units, extent, error }.
   */
  async function loadHeader(source, fileName, fileSize) {
    demId = CacheStore.makeDemId(fileName, fileSize || 0);
    header = await DemSampler.initHeaderOnly(source, fileName);
    crsInfo = DemCrs.describe(header.geoKeys);
    transformer = null;
    roiRaster = null;

    let error = null;
    if (crsInfo.kind === 'unsupported') {
      error = crsInfo.reason;
    } else {
      try {
        transformer = await DemCrs.makeTransformer(crsInfo);
        DemSampler.setTransformer(transformer);
      } catch (e) {
        error = e.message;
      }
    }

    const units = DemCrs.guessVerticalUnits(crsInfo);
    setVerticalUnits(units.units);
    const bytes = header.width * header.height * 4;

    return {
      demId,
      ...header,
      crs: crsInfo,
      units,
      error,
      extent: transformer ? getExtentWgs84() : null,
      pixelSizeM: transformer ? pixelSizeMeters() : null,
      uncompressedBytes: bytes,
      isLarge: bytes >= LARGE_DEM_BYTES,
      needsReprojection: crsInfo.kind !== 'utm'
    };
  }

  function setVerticalUnits(units) {
    verticalUnits = DemCrs.UNIT_TO_M[units] ? units : 'm';
    DemSampler.setZFactor(DemCrs.UNIT_TO_M[verticalUnits]);
  }

  /**
   * Raster footprint as a ring of WGS84 points (densified so projected
   * edges stay accurate).
   */
  function footprintWgs84(stepsPerEdge = 8) {
    if (!header || !transformer) return null;
    const { originX, originY, pixelSizeX, pixelSizeY, width, height } = header;
    const x0 = originX, x1 = originX + width * pixelSizeX;
    const y0 = originY, y1 = originY + height * pixelSizeY;
    const ring = [];
    const edge = (ax, ay, bx, by) => {
      for (let i = 0; i < stepsPerEdge; i++) {
        const t = i / stepsPerEdge;
        ring.push(transformer.toWgs84([ax + t * (bx - ax), ay + t * (by - ay)]));
      }
    };
    edge(x0, y1, x1, y1);
    edge(x1, y1, x1, y0);
    edge(x1, y0, x0, y0);
    edge(x0, y0, x0, y1);
    ring.push(ring[0]);
    return ring;
  }

  /**
   * Get DEM footprint in WGS84 as a GeoJSON polygon.
   */
  function getExtentGeoJSON() {
    const ring = footprintWgs84();
    if (!ring) return null;
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { class: 'dem-extent' }
    };
  }

  function getExtentWgs84() {
    const ring = footprintWgs84();
    if (!ring) return null;
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const [lng, lat] of ring) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    return { west, south, east, north };
  }

  /** Approximate DEM pixel size in meters. */
  function pixelSizeMeters() {
    const px = Math.abs(header.pixelSizeX), py = Math.abs(header.pixelSizeY);
    if (crsInfo.kind === 'geographic') {
      const ext = getExtentWgs84();
      const lat = ext ? (ext.south + ext.north) / 2 : 0;
      return Math.min(px * 111320 * Math.cos(lat * Math.PI / 180), py * 110574);
    }
    const f = DemCrs.UNIT_TO_M[crsInfo.horizUnits] || 1;
    return Math.min(px, py) * f;
  }

  /**
   * Set the working UTM zone for this DEM: the DEM's own zone if it is UTM,
   * otherwise the zone containing the DEM's center.
   */
  function setupWorkingCrs() {
    if (crsInfo.kind === 'utm') {
      return Projection.setUtm(crsInfo.zone, crsInfo.south, crsInfo.datum);
    }
    const ext = getExtentWgs84();
    const { zone, south } = Projection.zoneForLngLat((ext.west + ext.east) / 2, (ext.south + ext.north) / 2);
    const datum = /NAD\s?83|1983|GRS\s?80|GRS 1980/i.test(crsInfo.citation || '') ||
                  [4269, 6318, 4152, 4617, 4759].includes(crsInfo.epsg) ? 'NAD83' : 'WGS84';
    return Projection.setUtm(zone, south, datum);
  }

  /**
   * Split trails into those with at least one vertex inside the DEM
   * footprint and those entirely outside.
   */
  function trailsInside(trailsGeoJson) {
    const inside = [], outside = [];
    if (!trailsGeoJson || !transformer) return { inside, outside };
    for (const f of trailsGeoJson.features) {
      if (!f.geometry || f.geometry.type !== 'LineString') continue;
      const hit = f.geometry.coordinates.some(c => DemSampler.containsLngLat(c[0], c[1]));
      (hit ? inside : outside).push(f);
    }
    return { inside, outside };
  }

  /** Bounding box in working UTM of a set of WGS84 points, plus buffer. */
  function utmBboxOfPoints(points, buffer) {
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const p of points) {
      const [e, n] = Projection.wgs84ToUtm(p[0], p[1]);
      if (!isFinite(e) || !isFinite(n)) continue;
      if (e < west) west = e;
      if (e > east) east = e;
      if (n < south) south = n;
      if (n > north) north = n;
    }
    if (!isFinite(west)) return null;
    return { west: west - buffer, south: south - buffer, east: east + buffer, north: north + buffer };
  }

  /**
   * Step 2a: Process the area around the trails that fall inside the DEM
   * (bounding box + buffer in meters).
   */
  async function extractROI(trailsGeoJson, bufferMeters) {
    setupWorkingCrs();
    const { inside } = trailsInside(trailsGeoJson);
    if (inside.length === 0) throw new Error('None of the loaded trails fall inside this DEM');
    const pts = [];
    for (const f of inside) for (const c of f.geometry.coordinates) pts.push(c);
    const bbox = utmBboxOfPoints(pts, bufferMeters || 500);
    roiRaster = await extractUtmBbox(bbox);
    return roiRaster;
  }

  /**
   * Step 2b: Process the full DEM extent.
   */
  async function extractFullExtent() {
    setupWorkingCrs();
    if (crsInfo.kind === 'utm') {
      checkPixelBudget(header.width, header.height);
      roiRaster = await DemSampler.readWindow(0, 0, header.width, header.height);
    } else {
      roiRaster = await extractUtmBbox(utmBboxOfPoints(footprintWgs84(16), 0));
    }
    return roiRaster;
  }

  function checkPixelBudget(w, h) {
    if (w * h > MAX_ROI_PIXELS) {
      throw new Error(`Processing area is ${(w * h / 1e6).toFixed(0)} million pixels — too large for the browser ` +
                      `(limit ${MAX_ROI_PIXELS / 1e6} million). Load trails and process "around trails" instead.`);
    }
  }

  /**
   * Read a working-UTM bounding box from the DEM, reprojecting if the DEM is
   * not in the working zone. Returns a raster in working UTM.
   */
  async function extractUtmBbox(bbox) {
    if (crsInfo.kind === 'utm') {
      const win = DemSampler.bboxToPixelWindow(bbox);
      checkPixelBudget(Math.ceil(win[2] - win[0]), Math.ceil(win[3] - win[1]));
      return DemSampler.readWindow(win[0], win[1], win[2], win[3]);
    }

    const px = Math.max(0.5, Math.round(pixelSizeMeters() * 100) / 100);
    const dst = {
      originX: Math.floor(bbox.west / px) * px,
      originY: Math.ceil(bbox.north / px) * px,
      pixelSizeX: px,
      pixelSizeY: -px
    };
    dst.width = Math.ceil((bbox.east - dst.originX) / px);
    dst.height = Math.ceil((dst.originY - bbox.south) / px);
    checkPixelBudget(dst.width, dst.height);

    // Source pixel window covering the destination box
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        if (i !== 0 && i !== steps && j !== 0 && j !== steps) continue;
        const e = dst.originX + (i / steps) * dst.width * px;
        const n = dst.originY - (j / steps) * dst.height * px;
        const [x, y] = transformer.fromWgs84(Projection.utmToWgs84(e, n));
        const c = (x - header.originX) / header.pixelSizeX;
        const r = (y - header.originY) / header.pixelSizeY;
        if (c < sx0) sx0 = c;
        if (c > sx1) sx1 = c;
        if (r < sy0) sy0 = r;
        if (r > sy1) sy1 = r;
      }
    }
    const src = await DemSampler.readWindow(sx0 - 2, sy0 - 2, sx1 + 2, sy1 + 2);
    console.log(`[Preprocessor] Reprojecting ${src.width}x${src.height} → ${dst.width}x${dst.height} at ${px} m (${Projection.getCrs().label})`);
    return warpToUtm(src, dst);
  }

  /**
   * Reproject a source-CRS raster onto a working-UTM grid with bilinear
   * sampling. The exact transform is evaluated on a coarse node grid and
   * interpolated between nodes (sub-pixel error for smooth projections).
   */
  function warpToUtm(src, dst) {
    const { width: w, height: h } = dst;
    const S = WARP_STEP;
    const gw = Math.ceil(w / S) + 1, gh = Math.ceil(h / S) + 1;
    const gx = new Float64Array(gw * gh), gy = new Float64Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const e = dst.originX + (i * S + 0.5) * dst.pixelSizeX;
        const n = dst.originY + (j * S + 0.5) * dst.pixelSizeY;
        const [x, y] = transformer.fromWgs84(Projection.utmToWgs84(e, n));
        gx[j * gw + i] = (x - src.originX) / src.pixelSizeX - 0.5;
        gy[j * gw + i] = (y - src.originY) / src.pixelSizeY - 0.5;
      }
    }

    const out = new Float32Array(w * h);
    const sd = src.data, sw = src.width, sh = src.height;
    for (let r = 0; r < h; r++) {
      const j = Math.floor(r / S), ty = (r - j * S) / S;
      for (let c = 0; c < w; c++) {
        const i = Math.floor(c / S), tx = (c - i * S) / S;
        const k = j * gw + i;
        const sx = (gx[k] * (1 - tx) + gx[k + 1] * tx) * (1 - ty) + (gx[k + gw] * (1 - tx) + gx[k + gw + 1] * tx) * ty;
        const sy = (gy[k] * (1 - tx) + gy[k + 1] * tx) * (1 - ty) + (gy[k + gw] * (1 - tx) + gy[k + gw + 1] * tx) * ty;

        const c0 = Math.floor(sx), r0 = Math.floor(sy);
        let v = NaN;
        if (c0 >= 0 && r0 >= 0 && c0 + 1 < sw && r0 + 1 < sh) {
          const fx = sx - c0, fy = sy - r0;
          const i00 = r0 * sw + c0;
          const v00 = sd[i00], v10 = sd[i00 + 1], v01 = sd[i00 + sw], v11 = sd[i00 + sw + 1];
          if (v00 === v00 && v10 === v10 && v01 === v01 && v11 === v11) {
            v = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
          } else {
            v = sd[Math.round(sy) * sw + Math.round(sx)];
          }
        } else {
          const cn = Math.round(sx), rn = Math.round(sy);
          if (cn >= 0 && rn >= 0 && cn < sw && rn < sh) v = sd[rn * sw + cn];
        }
        out[r * w + c] = v;
      }
    }

    return { data: out, width: w, height: h,
             originX: dst.originX, originY: dst.originY,
             pixelSizeX: dst.pixelSizeX, pixelSizeY: dst.pixelSizeY };
  }

  /** Min/max of valid cells (sampled) — used for unit sanity checks. */
  function elevationRange(raster) {
    let min = Infinity, max = -Infinity;
    const d = raster.data, step = Math.max(1, Math.floor(d.length / 2e6));
    for (let i = 0; i < d.length; i += step) {
      const v = d[i];
      if (v !== v) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return isFinite(min) ? { min, max } : null;
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
    await CacheStore.putMetadata(demId, {
      roiWidth: roi.width,
      roiHeight: roi.height,
      originX: roi.originX,
      originY: roi.originY,
      pixelSizeX: roi.pixelSizeX,
      pixelSizeY: roi.pixelSizeY,
      demExtent: getExtentWgs84() || rasterBoundsWgs84(roi),
      roiBounds: rasterBoundsWgs84(roi),
      crs: Projection.getCrs(),
      sourceCrs: crsInfo ? crsInfo.label : null,
      verticalUnits
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
    const elevAt = makeGapFilledSampler(roi);

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

          const col = Math.floor((easting - roi.originX) / roi.pixelSizeX);
          const row = Math.floor((northing - roi.originY) / roi.pixelSizeY);
          const elev = elevAt(col, row);

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
   * Elevation lookup for terrain tiles that never returns a gap. Positions
   * outside the raster take the nearest edge cell (the map masks that area,
   * see TrailMap), and nodata cells are filled from a NaN-aware mean pyramid,
   * which gives smooth patches instead of streaks or flat plateaus. Without
   * this, gaps encode as 0 m and render as cliffs in the hillshade and 3D view.
   */
  function makeGapFilledSampler(roi) {
    const { data, width: w, height: h } = roi;
    let sum = 0, cnt = 0, hasGaps = false;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v === v) { sum += v; cnt++; } else hasGaps = true;
    }
    const fallback = cnt ? sum / cnt : 0;

    // Level k holds 2^k x 2^k block means of valid cells (NaN if none)
    const levels = [];
    if (hasGaps) {
      let prev = data, pw = w, ph = h;
      while (pw > 1 || ph > 1) {
        const nw = Math.ceil(pw / 2), nh = Math.ceil(ph / 2);
        const next = new Float32Array(nw * nh);
        let gapsLeft = false;
        for (let y = 0; y < nh; y++) {
          for (let x = 0; x < nw; x++) {
            let s = 0, c = 0;
            for (let dy = 0; dy < 2; dy++) {
              const yy = 2 * y + dy;
              if (yy >= ph) continue;
              for (let dx = 0; dx < 2; dx++) {
                const xx = 2 * x + dx;
                if (xx >= pw) continue;
                const v = prev[yy * pw + xx];
                if (v === v) { s += v; c++; }
              }
            }
            if (c) next[y * nw + x] = s / c;
            else { next[y * nw + x] = NaN; gapsLeft = true; }
          }
        }
        levels.push({ data: next, w: nw, h: nh });
        prev = next; pw = nw; ph = nh;
        if (!gapsLeft) break;
      }
    }

    // Bilinear sample of level L at the center of cell (col,row) of a grid
    // `scale` times finer, using only valid cells.
    function fromLevel(L, col, row, scale) {
      const fx = (col + 0.5) / scale - 0.5, fy = (row + 0.5) / scale - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      let s = 0, ws = 0;
      for (let k = 0; k < 4; k++) {
        const xx = Math.min(L.w - 1, Math.max(0, x0 + (k & 1)));
        const yy = Math.min(L.h - 1, Math.max(0, y0 + (k >> 1)));
        const wt = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? ty : 1 - ty);
        const v = L.data[yy * L.w + xx];
        if (wt > 0 && v === v) { s += v * wt; ws += wt; }
      }
      return ws > 0 ? s / ws : NaN;
    }

    // Push: fill each level's gaps from the (already filled) coarser level,
    // coarsest first, so fills blend smoothly instead of stepping between levels
    for (let k = levels.length - 2; k >= 0; k--) {
      const L = levels[k], C = levels[k + 1];
      for (let y = 0; y < L.h; y++) {
        for (let x = 0; x < L.w; x++) {
          const i = y * L.w + x;
          if (L.data[i] !== L.data[i]) L.data[i] = fromLevel(C, x, y, 2);
        }
      }
    }

    return (col, row) => {
      col = col < 0 ? 0 : col >= w ? w - 1 : col;
      row = row < 0 ? 0 : row >= h ? h - 1 : row;
      const v = data[row * w + col];
      if (v === v) return v;
      if (levels.length) {
        const f = fromLevel(levels[0], col, row, 2);
        if (f === f) return f;
      }
      return fallback;
    };
  }

  function rasterBoundsWgs84(r) {
    const sw = Projection.utmToWgs84(r.originX, r.originY + r.height * r.pixelSizeY);
    const ne = Projection.utmToWgs84(r.originX + r.width * r.pixelSizeX, r.originY);
    const nw = Projection.utmToWgs84(r.originX, r.originY);
    const se = Projection.utmToWgs84(r.originX + r.width * r.pixelSizeX, r.originY + r.height * r.pixelSizeY);
    return {
      west: Math.min(sw[0], nw[0]), east: Math.max(ne[0], se[0]),
      south: Math.min(sw[1], se[1]), north: Math.max(ne[1], nw[1])
    };
  }

  /**
   * Hand the pipeline a raster that is already in working UTM (e.g. fetched
   * from a web service) instead of reading it from a GeoTIFF.
   */
  function setRoiRaster(raster, id, sourceLabel) {
    demId = id;
    roiRaster = raster;
    header = null;
    transformer = null;
    crsInfo = { kind: 'utm', label: sourceLabel || Projection.getCrs().label };
    verticalUnits = 'm';
  }

  /**
   * Release all preprocessing memory. Called after pipeline completes.
   */
  function releaseMemory() {
    roiRaster = null;
    header = null;
    transformer = null;
    DemSampler.release();
    console.log('[Preprocessor] Memory released');
  }

  function getDemId() { return demId; }
  function setDemId(id) { demId = id; }
  function getVerticalUnits() { return verticalUnits; }

  return {
    loadHeader, setVerticalUnits, getVerticalUnits, getExtentGeoJSON, getExtentWgs84,
    trailsInside, extractROI, extractFullExtent, elevationRange, setRoiRaster,
    runPreprocessing, releaseMemory, getDemId, setDemId,
    tileBoundsWgs84, getTilesForBounds, rasterBoundsWgs84
  };
})();
