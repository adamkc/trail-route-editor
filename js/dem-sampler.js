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

  function isLoaded() { return image !== null; }
  function getUrl() { return currentUrl; }

  return { init, sampleElevation, sampleAtLngLat, sampleBatch, getFullRaster, isLoaded, getUrl };
})();
