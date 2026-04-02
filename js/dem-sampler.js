/**
 * dem-sampler.js — Client-side elevation sampling from tiled GeoTIFF using GeoTIFF.js
 */
const DemSampler = (() => {
  let image = null;
  let originX, originY, pixelSizeX, pixelSizeY;
  let imgWidth, imgHeight;
  let currentUrl = null;

  /**
   * Initialize from a URL string OR a raw ArrayBuffer (for serverless mode).
   * @param {string|ArrayBuffer} source - URL to fetch, or an ArrayBuffer of a GeoTIFF
   * @param {string} [label] - optional display name (used when source is ArrayBuffer)
   */
  async function init(source, label) {
    let buffer;
    if (source instanceof ArrayBuffer) {
      buffer = source;
      currentUrl = label || 'local-file';
      console.log('[DEM] Loading from ArrayBuffer,', (buffer.byteLength / 1024 / 1024).toFixed(1), 'MB');
    } else {
      currentUrl = source;
      console.log('[DEM] Fetching', source, '...');
      const response = await fetch(source);
      if (!response.ok) throw new Error('Failed to fetch DEM: HTTP ' + response.status);
      buffer = await response.arrayBuffer();
      console.log('[DEM] Downloaded', (buffer.byteLength / 1024 / 1024).toFixed(1), 'MB');
    }

    const fromArrayBuffer = (typeof GeoTIFF.fromArrayBuffer === 'function')
      ? GeoTIFF.fromArrayBuffer
      : GeoTIFF.default ? GeoTIFF.default.fromArrayBuffer : null;
    if (!fromArrayBuffer) throw new Error('GeoTIFF.fromArrayBuffer not found');

    const tiff = await fromArrayBuffer(buffer);
    image = await tiff.getImage();

    // Get geo transform
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    originX = origin[0];
    originY = origin[1];
    pixelSizeX = resolution[0];   // positive (e.g., 1.099)
    pixelSizeY = resolution[1];   // negative (e.g., -1.099)
    imgWidth = image.getWidth();
    imgHeight = image.getHeight();

    console.log(`DEM loaded: ${imgWidth}x${imgHeight}, origin=(${originX.toFixed(1)}, ${originY.toFixed(1)}), px=${pixelSizeX.toFixed(3)}`);
    return true;
  }

  /**
   * Sample elevation at a UTM coordinate (EPSG:26910).
   * Returns elevation in meters, or null if out of bounds / nodata.
   */
  async function sampleElevation(easting, northing) {
    if (!image) return null;

    const col = Math.floor((easting - originX) / pixelSizeX);
    const row = Math.floor((northing - originY) / pixelSizeY);

    if (col < 0 || col >= imgWidth || row < 0 || row >= imgHeight) return null;

    try {
      const data = await image.readRasters({
        window: [col, row, col + 1, row + 1]
      });
      const val = data[0][0];
      // Common nodata values
      if (val === -9999 || val === -3.4028235e+38 || isNaN(val)) return null;
      return val;
    } catch (e) {
      console.warn('DEM sample error:', e);
      return null;
    }
  }

  /**
   * Sample elevation at a WGS84 coordinate (lng, lat).
   * Converts to UTM internally.
   */
  async function sampleAtLngLat(lng, lat) {
    const [easting, northing] = Projection.wgs84ToUtm(lng, lat);
    return sampleElevation(easting, northing);
  }

  /**
   * Batch sample elevations for an array of [lng, lat] coordinates.
   * More efficient than individual calls for initial trail loading.
   */
  async function sampleBatch(lngLatCoords) {
    const elevations = [];
    for (const coord of lngLatCoords) {
      const elev = await sampleAtLngLat(coord[0], coord[1]);
      elevations.push(elev);
    }
    return elevations;
  }

  /**
   * Read the full raster band + geo-transform for contour generation.
   * Returns { data: Float32Array, width, height, originX, originY, pixelSizeX, pixelSizeY }
   */
  async function getFullRaster() {
    if (!image) return null;
    const rasters = await image.readRasters();
    return {
      data: rasters[0],
      width: imgWidth,
      height: imgHeight,
      originX, originY,
      pixelSizeX, pixelSizeY
    };
  }

  /**
   * Parse GeoTIFF header only — does NOT read raster data.
   * Returns geo-transform metadata with ~zero memory footprint.
   */
  async function initHeaderOnly(source, label) {
    let buffer;
    if (source instanceof ArrayBuffer) {
      buffer = source;
      currentUrl = label || 'local-file';
    } else {
      currentUrl = source;
      const response = await fetch(source);
      if (!response.ok) throw new Error('Failed to fetch DEM: HTTP ' + response.status);
      buffer = await response.arrayBuffer();
    }

    const fromArrayBuffer = (typeof GeoTIFF.fromArrayBuffer === 'function')
      ? GeoTIFF.fromArrayBuffer
      : GeoTIFF.default ? GeoTIFF.default.fromArrayBuffer : null;
    if (!fromArrayBuffer) throw new Error('GeoTIFF.fromArrayBuffer not found');

    const tiff = await fromArrayBuffer(buffer);
    image = await tiff.getImage();

    const origin = image.getOrigin();
    const resolution = image.getResolution();
    originX = origin[0];
    originY = origin[1];
    pixelSizeX = resolution[0];
    pixelSizeY = resolution[1];
    imgWidth = image.getWidth();
    imgHeight = image.getHeight();

    console.log(`[DEM] Header parsed: ${imgWidth}x${imgHeight}, origin=(${originX.toFixed(1)}, ${originY.toFixed(1)}), px=${pixelSizeX.toFixed(3)}`);
    return { width: imgWidth, height: imgHeight, originX, originY, pixelSizeX, pixelSizeY };
  }

  /**
   * Read a windowed sub-region of the raster (pixel coordinates).
   * Returns { data: Float32Array, width, height, originX, originY, pixelSizeX, pixelSizeY }
   */
  async function readWindow(x0, y0, x1, y1) {
    if (!image) throw new Error('DEM not loaded — call init or initHeaderOnly first');
    // Clamp to raster bounds
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(imgWidth, Math.ceil(x1));
    y1 = Math.min(imgHeight, Math.ceil(y1));
    const w = x1 - x0;
    const h = y1 - y0;
    console.log(`[DEM] Reading window: [${x0},${y0}]-[${x1},${y1}] = ${w}x${h} pixels (${(w * h * 4 / 1e6).toFixed(1)} MB)`);

    const rasters = await image.readRasters({ window: [x0, y0, x1, y1] });
    const data = rasters[0];

    // Clamp nodata values to 0 so contour generation and terrain tiles work cleanly
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v === -9999 || v === -3.4028235e+38 || isNaN(v) || v < 0) {
        data[i] = 0;
      }
    }

    return {
      data,
      width: w,
      height: h,
      originX: originX + x0 * pixelSizeX,
      originY: originY + y0 * pixelSizeY,
      pixelSizeX,
      pixelSizeY
    };
  }

  /**
   * Convert UTM bounding box to pixel window coordinates.
   * bbox: { west, south, east, north } in UTM (easting/northing)
   * Returns [x0, y0, x1, y1] in pixel coords, or null if out of bounds.
   */
  function utmBboxToPixelWindow(bbox) {
    if (!image) return null;
    // Note: pixelSizeY is negative (north-up raster)
    const col0 = (bbox.west - originX) / pixelSizeX;
    const col1 = (bbox.east - originX) / pixelSizeX;
    const row0 = (bbox.north - originY) / pixelSizeY;
    const row1 = (bbox.south - originY) / pixelSizeY;
    return [
      Math.min(col0, col1),
      Math.min(row0, row1),
      Math.max(col0, col1),
      Math.max(row0, row1)
    ];
  }

  /**
   * Get geo-transform metadata without touching raster data.
   */
  function getGeoTransform() {
    if (!image) return null;
    return { originX, originY, pixelSizeX, pixelSizeY, width: imgWidth, height: imgHeight };
  }

  /**
   * Release all references to the GeoTIFF image and raster data.
   * After calling this, only cached/ROI data should be used.
   */
  function release() {
    image = null;
    currentUrl = null;
    console.log('[DEM] Released — GeoTIFF references freed');
  }

  function isLoaded() { return image !== null; }
  function getUrl() { return currentUrl; }

  return {
    init, initHeaderOnly, readWindow, utmBboxToPixelWindow,
    sampleElevation, sampleAtLngLat, sampleBatch,
    getFullRaster, getGeoTransform, isLoaded, getUrl, release
  };
})();
