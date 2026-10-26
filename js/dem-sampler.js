/**
 * dem-sampler.js — GeoTIFF access during DEM processing (GeoTIFF.js).
 *
 * Coordinates here are in the DEM's own CRS (see DemCrs). Raster reads
 * convert nodata to NaN and elevations to meters. After processing, the app
 * samples from RoiSampler (working UTM) and this module is released.
 */
const DemSampler = (() => {
  let image = null;
  let originX, originY, pixelSizeX, pixelSizeY;
  let imgWidth, imgHeight;
  let currentUrl = null;
  let isNodata = DemCrs.makeNodataTest(null);
  let zFactor = 1;
  let transformer = null;  // DEM CRS <-> WGS84

  /**
   * Open a GeoTIFF from a File/Blob (read lazily), an ArrayBuffer, or a URL.
   * Blobs are sliced on demand, so only the header and requested windows are
   * read from disk.
   */
  async function open(source) {
    const G = GeoTIFF.fromBlob ? GeoTIFF : GeoTIFF.default;
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      return G.fromBlob(source);
    }
    if (source instanceof ArrayBuffer) {
      return G.fromArrayBuffer(source);
    }
    const response = await fetch(source);
    if (!response.ok) throw new Error('Failed to fetch DEM: HTTP ' + response.status);
    return G.fromBlob(await response.blob());
  }

  /**
   * Parse the GeoTIFF header only — does NOT read raster data.
   * Returns geo-transform, GeoKeys, and declared nodata.
   */
  async function initHeaderOnly(source, label) {
    currentUrl = label || (typeof source === 'string' ? source : 'local-file');
    const tiff = await open(source);
    image = await tiff.getImage();

    const origin = image.getOrigin();
    const resolution = image.getResolution();
    originX = origin[0];
    originY = origin[1];
    pixelSizeX = resolution[0];
    pixelSizeY = resolution[1];
    imgWidth = image.getWidth();
    imgHeight = image.getHeight();

    const nodata = image.getGDALNoData();
    isNodata = DemCrs.makeNodataTest(nodata);
    zFactor = 1;
    transformer = null;

    console.log(`[DEM] Header parsed: ${imgWidth}x${imgHeight}, origin=(${originX.toFixed(3)}, ${originY.toFixed(3)}), px=${pixelSizeX}, nodata=${nodata}`);
    return {
      width: imgWidth, height: imgHeight, originX, originY, pixelSizeX, pixelSizeY,
      geoKeys: image.getGeoKeys() || {},
      nodata
    };
  }

  function setTransformer(t) { transformer = t; }
  function getTransformer() { return transformer; }

  /** Multiplier from the DEM's vertical units to meters. */
  function setZFactor(f) { zFactor = f; }

  /**
   * Read a windowed sub-region of the raster (pixel coordinates).
   * Nodata becomes NaN; values are converted to meters.
   * Returns { data: Float32Array, width, height, originX, originY, pixelSizeX, pixelSizeY }
   * with the geo-transform in the DEM's CRS.
   */
  async function readWindow(x0, y0, x1, y1) {
    if (!image) throw new Error('DEM not loaded — call initHeaderOnly first');
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(imgWidth, Math.ceil(x1));
    y1 = Math.min(imgHeight, Math.ceil(y1));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) throw new Error('Requested area does not overlap the DEM');
    console.log(`[DEM] Reading window: [${x0},${y0}]-[${x1},${y1}] = ${w}x${h} pixels (${(w * h * 4 / 1e6).toFixed(1)} MB)`);

    const rasters = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0] });
    const src = rasters[0];
    const data = src instanceof Float32Array ? src : new Float32Array(src);

    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      data[i] = isNodata(v) ? NaN : v * zFactor;
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
   * Sample elevation (meters) at a coordinate in the DEM's CRS.
   * Returns null if out of bounds / nodata.
   */
  async function sampleElevation(x, y) {
    if (!image) return null;
    const col = Math.floor((x - originX) / pixelSizeX);
    const row = Math.floor((y - originY) / pixelSizeY);
    if (col < 0 || col >= imgWidth || row < 0 || row >= imgHeight) return null;
    try {
      const data = await image.readRasters({ window: [col, row, col + 1, row + 1], samples: [0] });
      const v = data[0][0];
      return isNodata(v) ? null : v * zFactor;
    } catch (e) {
      console.warn('DEM sample error:', e);
      return null;
    }
  }

  async function sampleAtLngLat(lng, lat) {
    if (!transformer) return null;
    const [x, y] = transformer.fromWgs84([lng, lat]);
    return sampleElevation(x, y);
  }

  async function sampleBatch(lngLatCoords) {
    const elevations = [];
    for (const coord of lngLatCoords) {
      elevations.push(await sampleAtLngLat(coord[0], coord[1]));
    }
    return elevations;
  }

  /** Whether a WGS84 point falls inside the raster footprint. */
  function containsLngLat(lng, lat) {
    if (!image || !transformer) return false;
    const [x, y] = transformer.fromWgs84([lng, lat]);
    const col = (x - originX) / pixelSizeX;
    const row = (y - originY) / pixelSizeY;
    return col >= 0 && col < imgWidth && row >= 0 && row < imgHeight;
  }

  async function getFullRaster() {
    if (!image) return null;
    return readWindow(0, 0, imgWidth, imgHeight);
  }

  /**
   * Convert a bounding box in the DEM's CRS to a pixel window [x0, y0, x1, y1].
   */
  function bboxToPixelWindow(bbox) {
    if (!image) return null;
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

  function getGeoTransform() {
    if (!image) return null;
    return { originX, originY, pixelSizeX, pixelSizeY, width: imgWidth, height: imgHeight };
  }

  /**
   * Release all references to the GeoTIFF image.
   * After calling this, only cached/ROI data should be used.
   */
  function release() {
    image = null;
    currentUrl = null;
    transformer = null;
    console.log('[DEM] Released — GeoTIFF references freed');
  }

  function isLoaded() { return image !== null; }
  function getUrl() { return currentUrl; }

  return {
    initHeaderOnly, readWindow, bboxToPixelWindow,
    setTransformer, getTransformer, setZFactor,
    sampleElevation, sampleAtLngLat, sampleBatch, containsLngLat,
    getFullRaster, getGeoTransform, isLoaded, getUrl, release
  };
})();
