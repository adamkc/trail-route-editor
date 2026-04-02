/**
 * roi-sampler.js — Lightweight elevation sampler for App Mode.
 *
 * Replaces DemSampler as the primary elevation source after preprocessing.
 * Works from a small ROI (region of interest) raster clipped from the full DEM,
 * typically 5–20 MB instead of 200+ MB.
 */
const RoiSampler = (() => {
  let roiData = null; // { data, width, height, originX, originY, pixelSizeX, pixelSizeY }
  let currentDemId = null; // track which DEM is currently loaded

  /**
   * Load ROI raster from CacheStore.
   */
  async function loadFromCache(demId) {
    const grid = await CacheStore.getGrid('roi-raster', demId);
    if (!grid) return false;
    roiData = grid;
    currentDemId = demId;
    console.log(`[RoiSampler] Loaded from cache (${demId}): ${grid.width}x${grid.height} (${(grid.data.byteLength / 1e6).toFixed(1)} MB)`);
    return true;
  }

  /**
   * Load directly from a raster object (skip IndexedDB round-trip during preprocessing).
   */
  function loadFromRaster(rasterObj, demId) {
    roiData = rasterObj;
    currentDemId = demId || null;
    console.log(`[RoiSampler] Loaded from raster (${demId || '?'}): ${rasterObj.width}x${rasterObj.height}`);
  }

  /**
   * Sample elevation at a UTM coordinate (EPSG:26910).
   * Synchronous — no async needed since data is in memory.
   */
  function sampleElevation(easting, northing) {
    if (!roiData) return null;
    const col = Math.floor((easting - roiData.originX) / roiData.pixelSizeX);
    const row = Math.floor((northing - roiData.originY) / roiData.pixelSizeY);
    if (col < 0 || col >= roiData.width || row < 0 || row >= roiData.height) return null;
    const val = roiData.data[row * roiData.width + col];
    if (val === -9999 || val === -3.4028235e+38 || isNaN(val)) return null;
    return val;
  }

  /**
   * Sample elevation at WGS84 coordinate.
   */
  function sampleAtLngLat(lng, lat) {
    if (!isFinite(lng) || !isFinite(lat)) return null;
    const [easting, northing] = Projection.wgs84ToUtm(lng, lat);
    return sampleElevation(easting, northing);
  }

  /**
   * Batch sample elevations. Synchronous since data is in-memory.
   */
  function sampleBatch(lngLatCoords) {
    return lngLatCoords.map(c => {
      if (!c || !isFinite(c[0]) || !isFinite(c[1])) return null;
      return sampleAtLngLat(c[0], c[1]);
    });
  }

  /**
   * Return the ROI raster object (for consumers that need the grid, e.g. contour gen, aspect).
   * This is the small clipped version, NOT the full DEM.
   */
  function getFullRaster() {
    return roiData;
  }

  function isLoaded() {
    return roiData !== null;
  }

  /**
   * Check if data for a specific DEM is loaded.
   */
  function isLoadedFor(demId) {
    return roiData !== null && currentDemId === demId;
  }

  function getDemId() {
    return currentDemId;
  }

  /**
   * Get WGS84 bounds of the ROI.
   */
  function getBounds() {
    if (!roiData) return null;
    const sw = Projection.utmToWgs84(
      roiData.originX,
      roiData.originY + roiData.height * roiData.pixelSizeY
    );
    const ne = Projection.utmToWgs84(
      roiData.originX + roiData.width * roiData.pixelSizeX,
      roiData.originY
    );
    return { west: sw[0], south: sw[1], east: ne[0], north: ne[1] };
  }

  function release() {
    roiData = null;
    currentDemId = null;
    console.log('[RoiSampler] Released');
  }

  return {
    loadFromCache, loadFromRaster,
    sampleElevation, sampleAtLngLat, sampleBatch,
    getFullRaster, isLoaded, isLoadedFor, getDemId, getBounds, release
  };
})();
