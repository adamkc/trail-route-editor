/**
 * drainage-analysis.js — Detect fall-line-aligned trail segments (water drainage risk)
 *
 * When a trail follows the fall line (DEM aspect direction) for too long,
 * water channels along the trail surface causing erosion.
 */
const DrainageAnalysis = (() => {

  const DEFAULTS = {
    angleTolerance: 30,   // degrees — trail bearing within this angle of fall line = aligned
    minRunLength: 30      // meters — contiguous aligned run must exceed this to flag
  };

  // Raster cache for synchronous DEM sampling
  let raster = null;

  function sampleElevSync(easting, northing) {
    if (!raster) return NaN;
    const col = Math.floor((easting - raster.originX) / raster.pixelSizeX);
    const row = Math.floor((northing - raster.originY) / raster.pixelSizeY);
    if (col < 0 || col >= raster.width || row < 0 || row >= raster.height) return NaN;
    const val = raster.data[row * raster.width + col];
    if (val === -9999 || val === -3.4028235e+38 || isNaN(val)) return NaN;
    return val;
  }

  /**
   * Compute the DEM aspect (fall line direction, degrees 0-360) at a UTM point.
   * Uses central differences on 4 neighbors.
   */
  function sampleAspectUTM(easting, northing) {
    const dx = Math.abs(raster.pixelSizeX) * 2;
    const dy = Math.abs(raster.pixelSizeY) * 2;

    const eE = sampleElevSync(easting + dx, northing);
    const eW = sampleElevSync(easting - dx, northing);
    const eN = sampleElevSync(easting, northing + dy);
    const eS = sampleElevSync(easting, northing - dy);

    if (isNaN(eE) || isNaN(eW) || isNaN(eN) || isNaN(eS)) return NaN;

    const dzdx = (eE - eW) / (2 * dx);
    const dzdy = (eN - eS) / (2 * dy);

    // Aspect = direction of steepest DESCENT (in degrees, 0=North, 90=East)
    let aspect = Math.atan2(-dzdx, -dzdy) * 180 / Math.PI;
    if (aspect < 0) aspect += 360;
    return aspect;
  }

  /**
   * Compute bearing between two UTM points (degrees, 0=North, 90=East).
   */
  function bearing(e1, n1, e2, n2) {
    let b = Math.atan2(e2 - e1, n2 - n1) * 180 / Math.PI;
    if (b < 0) b += 360;
    return b;
  }

  /**
   * Angular difference (0-180 degrees).
   */
  function angleDiff(a, b) {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
  }

  /**
   * Analyze a trail for fall-line alignment.
   *
   * @param {Array} coords - Array of [lng, lat] trail coordinates
   * @param {Object} opts  - { angleTolerance, minRunLength }
   * @returns {Array} zones - [{ startIdx, endIdx, startDist, endDist, length, avgAngle }]
   */
  async function analyze(coords, opts = {}) {
    const { angleTolerance, minRunLength } = { ...DEFAULTS, ...opts };

    if (coords.length < 2) return [];

    // Use ROI raster if available, fall back to full DEM
    if (typeof RoiSampler !== 'undefined' && RoiSampler.isLoaded()) {
      raster = RoiSampler.getFullRaster();
    } else if (DemSampler.isLoaded()) {
      raster = await DemSampler.getFullRaster();
    }
    if (!raster) return [];

    // Convert all coords to UTM
    const utm = coords.map(c => Projection.wgs84ToUtm(c[0], c[1]));

    // Compute per-segment: trail bearing, DEM aspect at midpoint, angular difference, length
    const segments = [];
    let cumDist = 0;
    for (let i = 0; i < utm.length - 1; i++) {
      const [e1, n1] = utm[i];
      const [e2, n2] = utm[i + 1];
      const dx = e2 - e1, dy = n2 - n1;
      const segLen = Math.sqrt(dx * dx + dy * dy);

      const midE = (e1 + e2) / 2, midN = (n1 + n2) / 2;
      const trailBearing = bearing(e1, n1, e2, n2);
      const aspect = sampleAspectUTM(midE, midN);

      let aligned = false;
      let diff = NaN;
      if (!isNaN(aspect)) {
        // Check if trail goes either WITH or AGAINST the fall line
        // (both directions channel water)
        diff = angleDiff(trailBearing, aspect);
        if (diff > 90) diff = 180 - diff; // uphill alignment is also bad
        aligned = diff <= angleTolerance;
      }

      segments.push({
        index: i,
        distStart: cumDist,
        distEnd: cumDist + segLen,
        length: segLen,
        trailBearing,
        aspect,
        angleDiff: diff,
        aligned
      });
      cumDist += segLen;
    }

    // Find contiguous runs of aligned segments
    const zones = [];
    let runStart = null;
    let runLength = 0;
    let runAngleSum = 0;
    let runCount = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.aligned) {
        if (runStart === null) {
          runStart = i;
          runLength = 0;
          runAngleSum = 0;
          runCount = 0;
        }
        runLength += seg.length;
        runAngleSum += seg.angleDiff;
        runCount++;
      } else {
        if (runStart !== null && runLength >= minRunLength) {
          zones.push({
            startIdx: runStart,
            endIdx: i - 1,
            startDist: segments[runStart].distStart,
            endDist: segments[i - 1].distEnd,
            length: runLength,
            avgAngle: runAngleSum / runCount
          });
        }
        runStart = null;
      }
    }
    // Close any open run
    if (runStart !== null && runLength >= minRunLength) {
      const lastSeg = segments[segments.length - 1];
      zones.push({
        startIdx: runStart,
        endIdx: segments.length - 1,
        startDist: segments[runStart].distStart,
        endDist: lastSeg.distEnd,
        length: runLength,
        avgAngle: runAngleSum / runCount
      });
    }

    return zones;
  }

  return { analyze, DEFAULTS };
})();
