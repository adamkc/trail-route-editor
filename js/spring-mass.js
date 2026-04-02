/**
 * spring-mass.js — Spring-mass trail optimizer (ported from R)
 *
 * Forces:
 *   1. Elevation: nudge toward target contour (uses DEM aspect)
 *   2. Adjacent attraction: spring to neighbors (controls length)
 *   3. Laplacian smoothing: pull toward midpoint of neighbors
 *   4. Non-adjacent repulsion: push apart nearby non-neighbor segments
 *   5. Corridor: hard clamp to max drift from original
 *
 * Trail length emerges from the attraction/repulsion balance.
 */
const SpringMass = (() => {

  // ── Default parameters (matching R grid-search winners) ──
  const DEFAULTS = {
    targetGrade:    0.07,
    maxGrade:       0.20,   // used by Phase 2 grade redistribution
    gradeWindow:    40,     // rolling window in meters for Phase 2
    vertexSpacing:  10,
    maxDrift:       200,
    stepSize:       0.3,
    maxIter:        2000,
    wElev:          7.0,
    wAttract:       2.0,
    wSmooth:        1.5,
    wRepel:         0.5,
    minSeparation:  40,
    repelSkip:      3,
    repelRadius:    60,
    batchSize:      15    // iterations per async batch (for live rendering)
  };

  // ── Aspect grid (computed once from DEM raster) ──
  let aspectGrid = null;  // { data, width, height, originX, originY, pxX, pxY }

  /**
   * Load a pre-built aspect grid from cache (preprocessed DEM).
   */
  async function loadAspectGridFromCache(demId) {
    const grid = await CacheStore.getGrid('aspect-grid', demId);
    if (!grid) return null;
    aspectGrid = grid;
    console.log('[SpringMass] Aspect grid loaded from cache:', grid.width, 'x', grid.height);
    return aspectGrid;
  }

  /**
   * Get the best available raster (ROI first, then full DEM).
   */
  async function getBestRaster() {
    if (typeof RoiSampler !== 'undefined' && RoiSampler.isLoaded()) {
      const r = RoiSampler.getFullRaster();
      if (r) return r;
    }
    return DemSampler.getFullRaster();
  }

  async function buildAspectGrid() {
    const r = await getBestRaster();
    if (!r) return null;
    const { data, width, height, originX, originY, pixelSizeX, pixelSizeY } = r;

    // Compute aspect using finite differences (same as terra::terrain)
    const aspect = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        if (row === 0 || row === height - 1 || col === 0 || col === width - 1) {
          aspect[idx] = NaN;
          continue;
        }
        // dz/dx and dz/dy using neighbors
        const left  = data[(row) * width + (col - 1)];
        const right = data[(row) * width + (col + 1)];
        const up    = data[(row - 1) * width + col];
        const down  = data[(row + 1) * width + col];
        if (isNaN(left) || isNaN(right) || isNaN(up) || isNaN(down) ||
            left === -9999 || right === -9999 || up === -9999 || down === -9999) {
          aspect[idx] = NaN;
          continue;
        }
        const dzdx = (right - left) / (2 * Math.abs(pixelSizeX));
        const dzdy = (down - up) / (2 * Math.abs(pixelSizeY));
        // Aspect in radians (compass convention: 0=N, pi/2=E)
        aspect[idx] = Math.atan2(-dzdx, dzdy);
      }
    }
    aspectGrid = { data: aspect, width, height, originX, originY,
                   pxX: pixelSizeX, pxY: pixelSizeY };
    return aspectGrid;
  }

  function sampleAspectUTM(easting, northing) {
    if (!aspectGrid) return NaN;
    const col = Math.floor((easting - aspectGrid.originX) / aspectGrid.pxX);
    const row = Math.floor((northing - aspectGrid.originY) / aspectGrid.pxY);
    if (col < 0 || col >= aspectGrid.width || row < 0 || row >= aspectGrid.height) return NaN;
    return aspectGrid.data[row * aspectGrid.width + col];
  }

  function sampleElevUTM(easting, northing, raster) {
    const col = Math.floor((easting - raster.originX) / raster.pxX);
    const row = Math.floor((northing - raster.originY) / raster.pxY);
    if (col < 0 || col >= raster.width || row < 0 || row >= raster.height) return NaN;
    const val = raster.data[row * raster.width + col];
    if (val === -9999 || val === -3.4028235e+38 || isNaN(val)) return NaN;
    return val;
  }

  // ── Geometry helpers ──

  function trailLength(coords, n) {
    let len = 0;
    for (let i = 1; i < n; i++) {
      const dx = coords[i * 2] - coords[(i - 1) * 2];
      const dy = coords[i * 2 + 1] - coords[(i - 1) * 2 + 1];
      len += Math.sqrt(dx * dx + dy * dy);
    }
    return len;
  }

  /**
   * Densify a trail to uniform spacing.
   * Input: array of [easting, northing] pairs.
   * Returns flat Float64Array [e0,n0, e1,n1, ...] with nVerts points.
   */
  function densify(utmCoords, targetSpacing, totalIdealLength) {
    // Compute cumulative distances
    const nOrig = utmCoords.length;
    const cumDist = [0];
    for (let i = 1; i < nOrig; i++) {
      const dx = utmCoords[i][0] - utmCoords[i - 1][0];
      const dy = utmCoords[i][1] - utmCoords[i - 1][1];
      cumDist.push(cumDist[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    const origLen = cumDist[nOrig - 1];

    const nVerts = Math.max(3, Math.round(totalIdealLength / targetSpacing));
    const out = new Float64Array(nVerts * 2);

    // First and last are pinned
    out[0] = utmCoords[0][0];
    out[1] = utmCoords[0][1];
    out[(nVerts - 1) * 2]     = utmCoords[nOrig - 1][0];
    out[(nVerts - 1) * 2 + 1] = utmCoords[nOrig - 1][1];

    // Interpolate interior points at equal spacing along original
    let segIdx = 0;
    for (let v = 1; v < nVerts - 1; v++) {
      const targetDist = (v / (nVerts - 1)) * origLen;
      while (segIdx < nOrig - 2 && cumDist[segIdx + 1] < targetDist) segIdx++;
      const segLen = cumDist[segIdx + 1] - cumDist[segIdx];
      const t = segLen > 0 ? (targetDist - cumDist[segIdx]) / segLen : 0;
      out[v * 2]     = utmCoords[segIdx][0] + t * (utmCoords[segIdx + 1][0] - utmCoords[segIdx][0]);
      out[v * 2 + 1] = utmCoords[segIdx][1] + t * (utmCoords[segIdx + 1][1] - utmCoords[segIdx][1]);
    }
    return { coords: out, n: nVerts };
  }

  // ── Core iteration batch ──

  function runBatch(coords, coordsOrig, n, targetElev, raster, params, batchSize) {
    const { stepSize, wElev, wAttract, wSmooth, wRepel,
            minSeparation, repelSkip, repelRadius, maxDrift } = params;
    const idealLength = params._idealLength;
    const idealSpacing = params._idealSpacing;
    const frozen = params._frozenFlags;

    let mse = 0, currentLen = 0, exploded = false;

    for (let b = 0; b < batchSize; b++) {
      currentLen = trailLength(coords, n);
      const lenRatio = currentLen / idealLength;
      const wAttractDyn = wAttract * Math.max(0.1, Math.min(3.0, lenRatio));

      // Force accumulator (flat: [fx0,fy0, fx1,fy1, ...])
      const force = new Float64Array(n * 2);

      // Sample elevations and aspect for all nodes
      const elev = new Float64Array(n);
      const asp = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        elev[j] = sampleElevUTM(coords[j * 2], coords[j * 2 + 1], raster);
        asp[j] = sampleAspectUTM(coords[j * 2], coords[j * 2 + 1]);
      }

      // 1. Elevation force — push toward target elevation using DEM aspect
      for (let j = 1; j < n - 1; j++) {
        const err = elev[j] - targetElev[j];
        if (isNaN(err) || isNaN(asp[j])) continue;
        const scale = Math.max(-1, Math.min(1, err / 10));
        force[j * 2]     += wElev * scale * Math.sin(asp[j]);
        force[j * 2 + 1] += wElev * scale * Math.cos(asp[j]);
      }

      // 2. Adjacent attraction + 3. Laplacian smoothing
      for (let j = 1; j < n - 1; j++) {
        const jx = coords[j * 2], jy = coords[j * 2 + 1];
        for (const nb of [j - 1, j + 1]) {
          const vx = coords[nb * 2] - jx;
          const vy = coords[nb * 2 + 1] - jy;
          const d = Math.sqrt(vx * vx + vy * vy);
          if (d > 0) {
            const attract = wAttractDyn * (d - idealSpacing) / d;
            force[j * 2]     += attract * vx;
            force[j * 2 + 1] += attract * vy;
          }
        }
        // Laplacian: pull toward midpoint of neighbors
        const mx = (coords[(j - 1) * 2] + coords[(j + 1) * 2]) / 2;
        const my = (coords[(j - 1) * 2 + 1] + coords[(j + 1) * 2 + 1]) / 2;
        force[j * 2]     += wSmooth * (mx - jx);
        force[j * 2 + 1] += wSmooth * (my - jy);
      }

      // 4. Non-adjacent repulsion (O(n^2) but n is typically ~100-500)
      if (wRepel > 0) {
        for (let j = 1; j < n - 1; j++) {
          const jx = coords[j * 2], jy = coords[j * 2 + 1];
          let rfx = 0, rfy = 0;
          for (let k = 0; k < n; k++) {
            if (Math.abs(k - j) <= repelSkip) continue;
            const dx = jx - coords[k * 2];
            const dy = jy - coords[k * 2 + 1];
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < 0.1 || d > repelRadius) continue;
            let strength = 0;
            if (d < minSeparation) {
              strength = Math.min((minSeparation / d) ** 2 - 1, 5);
            } else if (d < minSeparation * 1.5) {
              strength = ((minSeparation * 1.5 - d) / (minSeparation * 0.5)) ** 2 * 0.2;
            }
            if (strength > 0) {
              rfx += strength * dx / d;
              rfy += strength * dy / d;
            }
          }
          // Cap repulsion magnitude
          const rmag = Math.sqrt(rfx * rfx + rfy * rfy);
          if (rmag > 5) { rfx = rfx / rmag * 5; rfy = rfy / rmag * 5; }
          force[j * 2]     += wRepel * rfx;
          force[j * 2 + 1] += wRepel * rfy;
        }
      }

      // Apply forces + corridor clamp (skip frozen vertices)
      for (let j = 1; j < n - 1; j++) {
        if (frozen && frozen[j]) continue; // frozen — don't move
        let nx = coords[j * 2]     + stepSize * force[j * 2];
        let ny = coords[j * 2 + 1] + stepSize * force[j * 2 + 1];
        // Corridor clamp
        const dx = nx - coordsOrig[j * 2];
        const dy = ny - coordsOrig[j * 2 + 1];
        const drift = Math.sqrt(dx * dx + dy * dy);
        if (drift > maxDrift) {
          nx = coordsOrig[j * 2]     + dx / drift * maxDrift;
          ny = coordsOrig[j * 2 + 1] + dy / drift * maxDrift;
        }
        coords[j * 2]     = nx;
        coords[j * 2 + 1] = ny;
      }

      // Check for NaN
      for (let j = 0; j < n * 2; j++) {
        if (isNaN(coords[j])) { exploded = true; break; }
      }
      if (exploded) break;
    }

    // Compute final MSE
    mse = 0;
    let mseCount = 0;
    for (let j = 1; j < n - 1; j++) {
      const e = sampleElevUTM(coords[j * 2], coords[j * 2 + 1], raster);
      if (!isNaN(e) && !isNaN(targetElev[j])) {
        mse += (e - targetElev[j]) ** 2;
        mseCount++;
      }
    }
    mse = mseCount > 0 ? mse / mseCount : Infinity;
    currentLen = trailLength(coords, n);

    // Compute max segment grade
    let maxSegGrade = 0;
    for (let j = 1; j < n; j++) {
      const dx = coords[j * 2] - coords[(j - 1) * 2];
      const dy = coords[j * 2 + 1] - coords[(j - 1) * 2 + 1];
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen < 0.1) continue;
      const e1 = sampleElevUTM(coords[(j - 1) * 2], coords[(j - 1) * 2 + 1], raster);
      const e2 = sampleElevUTM(coords[j * 2], coords[j * 2 + 1], raster);
      if (isNaN(e1) || isNaN(e2)) continue;
      const grade = Math.abs(e2 - e1) / segLen;
      if (grade > maxSegGrade) maxSegGrade = grade;
    }

    return { mse, length: currentLen, exploded, maxSegGrade };
  }

  // ── Smooth result (3-point moving average + grade-aware Douglas-Peucker) ──

  function smoothCoords(coords, n, raster, maxGradeLimit, frozenFlags) {
    const out = new Float64Array(n * 2);
    // Copy endpoints
    out[0] = coords[0]; out[1] = coords[1];
    out[(n - 1) * 2] = coords[(n - 1) * 2]; out[(n - 1) * 2 + 1] = coords[(n - 1) * 2 + 1];
    // 3-point average for interior — skip frozen vertices
    for (let j = 1; j < n - 1; j++) {
      if (frozenFlags && frozenFlags[j]) {
        // Frozen: keep exact position
        out[j * 2]     = coords[j * 2];
        out[j * 2 + 1] = coords[j * 2 + 1];
      } else {
        out[j * 2]     = (coords[(j - 1) * 2]     + coords[j * 2]     + coords[(j + 1) * 2]) / 3;
        out[j * 2 + 1] = (coords[(j - 1) * 2 + 1] + coords[j * 2 + 1] + coords[(j + 1) * 2 + 1]) / 3;
      }
    }
    // Grade-aware Douglas-Peucker simplification (0.5m tolerance)
    return douglasPeucker(out, n, 0.5, raster, maxGradeLimit, frozenFlags);
  }

  function douglasPeucker(flatCoords, n, tolerance, raster, maxGradeLimit, frozenFlags) {
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    // Always keep frozen vertices — they must not be simplified away
    if (frozenFlags) {
      for (let i = 0; i < n; i++) {
        if (frozenFlags[i]) keep[i] = 1;
      }
    }
    dpRecurse(flatCoords, 0, n - 1, tolerance, keep, raster, maxGradeLimit);
    const result = [];
    for (let i = 0; i < n; i++) {
      if (keep[i]) result.push([flatCoords[i * 2], flatCoords[i * 2 + 1]]);
    }
    return result;
  }

  function dpRecurse(coords, start, end, tol, keep, raster, maxGradeLimit) {
    if (end - start < 2) return;
    let maxDist = 0, maxIdx = start;
    const ax = coords[start * 2], ay = coords[start * 2 + 1];
    const bx = coords[end * 2], by = coords[end * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    for (let i = start + 1; i < end; i++) {
      const px = coords[i * 2] - ax, py = coords[i * 2 + 1] - ay;
      let dist;
      if (lenSq === 0) {
        dist = Math.sqrt(px * px + py * py);
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
        const projX = t * dx, projY = t * dy;
        dist = Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
      }
      if (dist > maxDist) { maxDist = dist; maxIdx = i; }
    }

    if (maxDist > tol) {
      keep[maxIdx] = 1;
      dpRecurse(coords, start, maxIdx, tol, keep, raster, maxGradeLimit);
      dpRecurse(coords, maxIdx, end, tol, keep, raster, maxGradeLimit);
    } else if (raster && maxGradeLimit > 0) {
      // Before removing all interior points, check if the resulting segment
      // would exceed maxGrade. If so, keep the point that has the most
      // elevation deviation to preserve the optimizer's grade work.
      const segLen = Math.sqrt(lenSq);
      if (segLen > 0.1) {
        const eStart = sampleElevUTM(ax, ay, raster);
        const eEnd = sampleElevUTM(bx, by, raster);
        if (!isNaN(eStart) && !isNaN(eEnd)) {
          const grade = Math.abs(eEnd - eStart) / segLen;
          if (grade > maxGradeLimit) {
            // Force-keep the midpoint to break the steep segment
            const mid = Math.floor((start + end) / 2);
            keep[mid] = 1;
            dpRecurse(coords, start, mid, tol, keep, raster, maxGradeLimit);
            dpRecurse(coords, mid, end, tol, keep, raster, maxGradeLimit);
          }
        }
      }
    }
  }

  // ── Main optimize function ──

  /**
   * Optimize a trail using the spring-mass model.
   *
   * @param {Array} wgs84Coords - Array of [lng, lat] coordinates
   * @param {Array} elevations  - Parallel array of elevation values
   * @param {Object} params     - Override defaults (targetGrade, stepSize, etc.)
   * @param {Object} callbacks  - { onProgress, onFrame, shouldAbort }
   * @param {Array}  isFrozen   - Optional boolean array (same length as wgs84Coords). True = frozen.
   * @returns {Promise<{coords, elevations, converged, aborted, stats}>}
   */
  async function optimize(wgs84Coords, elevations, params, callbacks, isFrozen) {
    const P = { ...DEFAULTS, ...params };
    const { onProgress, onFrame, shouldAbort } = callbacks || {};

    // Build aspect grid if not cached
    if (!aspectGrid) {
      await buildAspectGrid();
    }
    const raster = await getBestRaster();
    if (!raster) throw new Error('DEM not loaded');
    // Attach raster metadata for sampleElevUTM
    raster.pxX = raster.pixelSizeX;
    raster.pxY = raster.pixelSizeY;

    // Convert WGS84 → UTM
    const utmCoords = wgs84Coords.map(c => {
      const [e, n] = Projection.wgs84ToUtm(c[0], c[1]);
      return [e, n];
    });

    // Compute start/end elevations and ideal length
    const startElev = elevations[0];
    const endElev = elevations[elevations.length - 1];
    const elevChange = Math.abs(endElev - startElev);
    const origLength = (() => {
      let len = 0;
      for (let i = 1; i < utmCoords.length; i++) {
        const dx = utmCoords[i][0] - utmCoords[i - 1][0];
        const dy = utmCoords[i][1] - utmCoords[i - 1][1];
        len += Math.sqrt(dx * dx + dy * dy);
      }
      return len;
    })();

    // Nearly flat — skip
    if (elevChange < 5) {
      return {
        coords: wgs84Coords.map(c => [...c]),
        elevations: [...elevations],
        converged: true, aborted: false,
        stats: { grade: elevChange / origLength, length: origLength, mse: 0, iterations: 0,
                 origLength, origGrade: elevChange / origLength, idealLength: origLength, elevChange }
      };
    }

    const idealLength = elevChange / P.targetGrade;
    const idealSpacing = P.vertexSpacing;

    // Densify
    const { coords: flatCoords, n } = densify(utmCoords, idealSpacing, idealLength);
    const coordsOrig = new Float64Array(flatCoords);

    // Map frozen flags from original coords to densified coords
    // A densified vertex is frozen if the nearest original vertex was frozen
    const frozenFlags = new Uint8Array(n); // 0 = free, 1 = frozen
    if (isFrozen && isFrozen.some(Boolean)) {
      // Build cumulative distance for original coords
      const origCumDist = [0];
      for (let i = 1; i < utmCoords.length; i++) {
        const dx = utmCoords[i][0] - utmCoords[i - 1][0];
        const dy = utmCoords[i][1] - utmCoords[i - 1][1];
        origCumDist.push(origCumDist[i - 1] + Math.sqrt(dx * dx + dy * dy));
      }
      const origLen = origCumDist[utmCoords.length - 1];

      for (let v = 0; v < n; v++) {
        const denseDist = (v / (n - 1)) * origLen;
        // Find nearest original vertex by cumulative distance
        let bestOrigIdx = 0;
        let bestDistDiff = Infinity;
        for (let j = 0; j < utmCoords.length; j++) {
          const diff = Math.abs(origCumDist[j] - denseDist);
          if (diff < bestDistDiff) {
            bestDistDiff = diff;
            bestOrigIdx = j;
          }
        }
        if (isFrozen[bestOrigIdx]) frozenFlags[v] = 1;
      }
      // Endpoints always frozen
      frozenFlags[0] = 1;
      frozenFlags[n - 1] = 1;
      const frozenCount = frozenFlags.reduce((s, v) => s + v, 0);
      console.log(`[SpringMass] ${frozenCount}/${n} vertices frozen`);
    }

    // Compute target elevation ramp — piecewise between frozen anchor points
    const targetElev = new Float64Array(n);

    // Collect frozen anchor indices and their DEM elevations
    const anchors = []; // { idx, elev }
    for (let j = 0; j < n; j++) {
      if (frozenFlags[j]) {
        const elev = sampleElevUTM(flatCoords[j * 2], flatCoords[j * 2 + 1], raster);
        anchors.push({ idx: j, elev: isNaN(elev) ? null : elev });
      }
    }

    // Ensure endpoints are always anchors (they should be, but guard)
    if (anchors.length === 0 || anchors[0].idx !== 0) {
      anchors.unshift({ idx: 0, elev: startElev });
    }
    if (anchors[anchors.length - 1].idx !== n - 1) {
      anchors.push({ idx: n - 1, elev: endElev });
    }
    // Fix any null elevations at endpoints
    if (anchors[0].elev == null) anchors[0].elev = startElev;
    if (anchors[anchors.length - 1].elev == null) anchors[anchors.length - 1].elev = endElev;

    // Fill nulls by linear interpolation from neighboring anchors
    for (let a = 0; a < anchors.length; a++) {
      if (anchors[a].elev == null) {
        // Find prev and next non-null
        let prev = a - 1; while (prev >= 0 && anchors[prev].elev == null) prev--;
        let next = a + 1; while (next < anchors.length && anchors[next].elev == null) next++;
        if (prev >= 0 && next < anchors.length) {
          const frac = (anchors[a].idx - anchors[prev].idx) / (anchors[next].idx - anchors[prev].idx);
          anchors[a].elev = anchors[prev].elev + frac * (anchors[next].elev - anchors[prev].elev);
        } else if (prev >= 0) {
          anchors[a].elev = anchors[prev].elev;
        } else if (next < anchors.length) {
          anchors[a].elev = anchors[next].elev;
        }
      }
    }

    // Interpolate target elevation piecewise between consecutive anchors
    for (let a = 0; a < anchors.length - 1; a++) {
      const fromIdx = anchors[a].idx;
      const toIdx = anchors[a + 1].idx;
      const fromElev = anchors[a].elev;
      const toElev = anchors[a + 1].elev;

      for (let j = fromIdx; j <= toIdx; j++) {
        const span = toIdx - fromIdx;
        const frac = span > 0 ? (j - fromIdx) / span : 0;
        targetElev[j] = fromElev + frac * (toElev - fromElev);
      }
    }

    if (anchors.length > 2) {
      console.log(`[SpringMass] Piecewise target elevation: ${anchors.length} anchor points`);
    }

    // Internal params for batch runner
    const batchParams = {
      ...P,
      _idealLength: idealLength,
      _idealSpacing: idealSpacing,
      _frozenFlags: frozenFlags
    };

    // Retry logic (matching R script)
    const retryConfigs = [
      { stepSize: P.stepSize, wElev: P.wElev, wAttract: P.wAttract, wRepel: P.wRepel },
      { stepSize: P.stepSize * 0.5, wElev: P.wElev, wAttract: P.wAttract * 0.7, wRepel: P.wRepel * 0.5 },
      { stepSize: P.stepSize * 0.25, wElev: P.wElev * 0.8, wAttract: P.wAttract * 0.5, wRepel: P.wRepel * 0.3 }
    ];

    let finalCoords = flatCoords;
    let finalMse = Infinity, finalLen = 0;
    let converged = false, aborted = false;
    let totalIter = 0, bestMse = Infinity;

    for (let attempt = 0; attempt < retryConfigs.length; attempt++) {
      const rc = retryConfigs[attempt];
      const runParams = { ...batchParams, ...rc };
      const runCoords = attempt === 0 ? flatCoords : new Float64Array(coordsOrig);
      if (attempt > 0) {
        // Reset to original for retry
        for (let i = 0; i < n * 2; i++) runCoords[i] = coordsOrig[i];
        console.log(`[SpringMass] Retry ${attempt + 1}: step=${rc.stepSize.toFixed(3)}`);
      }

      let iter = 0;
      let exploded = false;
      bestMse = Infinity;
      const energyHistory = [];

      while (iter < P.maxIter) {
        // Check abort
        if (shouldAbort && shouldAbort()) {
          aborted = true;
          break;
        }

        const result = runBatch(runCoords, coordsOrig, n, targetElev, raster, runParams, P.batchSize);
        iter += P.batchSize;
        totalIter = iter;

        energyHistory.push(result.mse);
        if (result.mse < bestMse) bestMse = result.mse;

        // Explosion detection
        if (iter > P.batchSize * 2 && (result.mse > bestMse * 10 || result.length > idealLength * 3)) {
          console.log(`[SpringMass] Explosion at iter ${iter} (MSE: ${result.mse.toFixed(1)}, best: ${bestMse.toFixed(1)})`);
          exploded = true;
          break;
        }

        if (result.exploded) { exploded = true; break; }

        // Progress callback
        const grade = elevChange / result.length;
        if (onProgress) {
          onProgress(iter, P.maxIter, result.mse, grade, result.length, result.maxSegGrade);
        }

        // Live map frame
        if (onFrame) {
          // Convert current UTM coords back to WGS84 for map display
          const frameWgs84 = [];
          for (let j = 0; j < n; j++) {
            const [lng, lat] = Projection.utmToWgs84(runCoords[j * 2], runCoords[j * 2 + 1]);
            frameWgs84.push([lng, lat]);
          }
          onFrame(frameWgs84);
        }

        // Convergence check (every 50 iters worth of batches)
        if (energyHistory.length > Math.ceil(50 / P.batchSize) + 1) {
          const lookback = Math.ceil(50 / P.batchSize);
          const prev = energyHistory[energyHistory.length - 1 - lookback];
          if (prev > 0 && Math.abs(result.mse - prev) / prev < 0.01) {
            console.log(`[SpringMass] Converged at iter ${iter} (MSE: ${result.mse.toFixed(1)})`);
            converged = true;
            break;
          }
        }

        finalMse = result.mse;
        finalLen = result.length;

        // Yield to browser for rendering
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      if (aborted) {
        finalCoords = runCoords;
        break;
      }
      if (!exploded) {
        finalCoords = runCoords;
        converged = converged || iter >= P.maxIter;
        break;
      }
      // If exploded and more retries, continue loop
      if (attempt === retryConfigs.length - 1) {
        console.log('[SpringMass] All retries exhausted — using last result');
        finalCoords = runCoords;
      }
    }

    // Collect frozen vertex WGS84 positions before smoothing (for Phase 2 handoff)
    const frozenWgs84 = [];
    for (let j = 0; j < n; j++) {
      if (frozenFlags[j]) {
        const [lng, lat] = Projection.utmToWgs84(finalCoords[j * 2], finalCoords[j * 2 + 1]);
        frozenWgs84.push([lng, lat]);
      }
    }

    // Smooth the result (pass raster + maxGrade so DP won't re-introduce steep segments)
    // Pass frozenFlags so frozen vertices are preserved through smoothing + simplification
    const smoothedUTM = smoothCoords(finalCoords, n, raster, P.maxGrade, frozenFlags);

    // Convert back to WGS84
    const resultCoords = smoothedUTM.map(([e, n]) => {
      const [lng, lat] = Projection.utmToWgs84(e, n);
      return [lng, lat];
    });

    // Sample elevations for result (prefer RoiSampler, fall back to DemSampler)
    const useRoi = typeof RoiSampler !== 'undefined' && RoiSampler.isLoaded();
    const resultElevs = [];
    for (const c of resultCoords) {
      const elev = useRoi
        ? RoiSampler.sampleAtLngLat(c[0], c[1])
        : await DemSampler.sampleAtLngLat(c[0], c[1]);
      resultElevs.push(elev);
    }

    const finalGrade = elevChange / finalLen;
    return {
      coords: resultCoords,
      elevations: resultElevs,
      frozenCoords: frozenWgs84, // WGS84 positions of frozen vertices (for Phase 2)
      converged,
      aborted,
      stats: {
        grade: finalGrade,
        length: finalLen,
        mse: finalMse,
        iterations: totalIter,
        origLength,
        origGrade: elevChange / origLength,
        idealLength,
        elevChange
      }
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // Phase 2: Grade Redistribution
  //
  // After the spring-mass optimizer converges, this pass finds sections
  // where the rolling-window average grade exceeds maxGrade and
  // redistributes vertices within those sections so grade is uniform.
  //
  // This directly eliminates the up-down-up-down sawtooth pattern
  // because all segments in a steep zone get the SAME grade.
  // Short spikes at switchback turns are allowed (rolling window).
  // ══════════════════════════════════════════════════════════════════

  /**
   * Phase 2: Smooth grades on an existing trail.
   *
   * @param {Array} wgs84Coords - Array of [lng, lat] coordinates
   * @param {Array} elevations  - Parallel array of elevation values
   * @param {Object} params     - { maxGrade, gradeWindow, passes }
   * @param {Object} callbacks  - { onProgress, onFrame, shouldAbort }
   * @returns {Promise<{coords, elevations, stats}>}
   */
  async function gradeRedistribute(wgs84Coords, elevations, params, callbacks, frozenCoords) {
    const maxGrade = params.maxGrade || 0.20;
    const windowM = params.gradeWindow || 40;
    const passes = params.gradePasses || 30;
    const stepScale = params.gradeStepSize != null ? params.gradeStepSize : 0.4;
    const maxLateralDrift = 15 * stepScale; // scale lateral drift with step size
    const { onProgress, onFrame, shouldAbort } = callbacks || {};

    const n = wgs84Coords.length;
    if (n < 3) {
      return { coords: wgs84Coords.map(c => [...c]), elevations: [...elevations], stats: {} };
    }

    // Convert to UTM for metric calculations
    const utmCoords = wgs84Coords.map(c => Projection.wgs84ToUtm(c[0], c[1]));

    // Build frozen flags by matching frozen WGS84 coords to Phase 2 vertices
    // (Phase 1 output has different vertex count than original, so we match by proximity)
    const p2Frozen = new Uint8Array(n);
    if (frozenCoords && frozenCoords.length > 0) {
      const frozenUTM = frozenCoords.map(c => Projection.wgs84ToUtm(c[0], c[1]));
      const SNAP_DIST = 2.0; // meters — snap threshold for matching frozen positions
      for (let i = 0; i < n; i++) {
        for (const fc of frozenUTM) {
          const dx = utmCoords[i][0] - fc[0];
          const dy = utmCoords[i][1] - fc[1];
          if (Math.sqrt(dx * dx + dy * dy) < SNAP_DIST) {
            p2Frozen[i] = 1;
            break;
          }
        }
      }
      // Endpoints always frozen
      p2Frozen[0] = 1;
      p2Frozen[n - 1] = 1;
      const fc = p2Frozen.reduce((s, v) => s + v, 0);
      console.log(`[Phase2] ${fc}/${n} vertices frozen`);
    }

    // Working copy of UTM coords
    const wx = utmCoords.map(c => c[0]);
    const wy = utmCoords.map(c => c[1]);

    // Cumulative distances (updated each pass)
    const cumDist = new Float64Array(n);
    function updateCumDist() {
      cumDist[0] = 0;
      for (let i = 1; i < n; i++) {
        const dx = wx[i] - wx[i - 1];
        const dy = wy[i] - wy[i - 1];
        cumDist[i] = cumDist[i - 1] + Math.sqrt(dx * dx + dy * dy);
      }
    }
    updateCumDist();

    const raster = await getBestRaster();
    if (raster) {
      raster.pxX = raster.pixelSizeX;
      raster.pxY = raster.pixelSizeY;
    }

    function getElev(i) {
      if (raster) {
        const e = sampleElevUTM(wx[i], wy[i], raster);
        if (!isNaN(e)) return e;
      }
      return elevations[i];
    }

    function getElevAt(x, y) {
      if (raster) {
        const e = sampleElevUTM(x, y, raster);
        if (!isNaN(e)) return e;
      }
      return NaN;
    }

    function segLen(i) {
      const dx = wx[i + 1] - wx[i];
      const dy = wy[i + 1] - wy[i];
      return Math.sqrt(dx * dx + dy * dy);
    }

    // ── Main redistribution loop ──
    let maxSeg = 0;
    let steepCount = 0;

    for (let pass = 0; pass < passes; pass++) {
      if (shouldAbort && shouldAbort()) break;

      // Identify problem vertices using BOTH per-segment and rolling-window checks
      const isProblematic = new Uint8Array(n);

      // Check 1: Per-segment grade — any segment exceeding maxGrade flags both endpoints
      for (let j = 1; j < n; j++) {
        const sl = segLen(j - 1);
        if (sl < 0.1) continue;
        const g = Math.abs(getElev(j) - getElev(j - 1)) / sl;
        if (g > maxGrade) {
          isProblematic[j - 1] = 1;
          isProblematic[j] = 1;
        }
      }

      // Check 2: Rolling-window average
      for (let i = 1; i < n - 1; i++) {
        let jStart = i, jEnd = i;
        const halfWin = windowM / 2;
        while (jStart > 0 && cumDist[i] - cumDist[jStart] < halfWin) jStart--;
        while (jEnd < n - 1 && cumDist[jEnd] - cumDist[i] < halfWin) jEnd++;
        const dist = Math.max(0.1, cumDist[jEnd] - cumDist[jStart]);
        const dElev = Math.abs(getElev(jEnd) - getElev(jStart));
        if (dElev / dist > maxGrade) isProblematic[i] = 1;
      }

      // Don't move endpoints or frozen vertices
      isProblematic[0] = 0;
      isProblematic[n - 1] = 0;
      for (let i = 0; i < n; i++) {
        if (p2Frozen[i]) isProblematic[i] = 0;
      }

      // Build contiguous zones from problematic vertices
      // Frozen vertices have isProblematic=0, so they naturally act as zone boundaries
      const zones = [];
      let inZone = false, zoneStart = 0;
      for (let i = 0; i < n; i++) {
        if (isProblematic[i]) {
          if (!inZone) { zoneStart = Math.max(0, i - 1); inZone = true; }
        } else {
          if (inZone) {
            zones.push([zoneStart, Math.min(n - 1, i)]);
            inZone = false;
          }
        }
      }
      if (inZone) zones.push([zoneStart, n - 1]);

      steepCount = isProblematic.reduce((s, v) => s + v, 0);
      if (steepCount === 0) {
        console.log(`[Phase2] Pass ${pass + 1}: no vertices exceed ${(maxGrade * 100).toFixed(0)}% — done`);
        break;
      }

      // For each zone, nudge interior vertices perpendicular to trail
      // to find terrain at the target elevation (uniform grade within zone)
      for (const [zs, ze] of zones) {
        if (ze - zs < 2) continue;

        const startElev = getElev(zs);
        const endElev = getElev(ze);
        const zoneDist = cumDist[ze] - cumDist[zs];
        if (zoneDist < 0.1) continue;

        for (let j = zs + 1; j < ze; j++) {
          const frac = (cumDist[j] - cumDist[zs]) / zoneDist;
          const targetE = startElev + frac * (endElev - startElev);
          const curElev = getElev(j);
          const elevErr = curElev - targetE;

          if (Math.abs(elevErr) < 0.1) continue;

          // Trail direction at this vertex
          const tdx = wx[Math.min(j + 1, ze)] - wx[Math.max(j - 1, zs)];
          const tdy = wy[Math.min(j + 1, ze)] - wy[Math.max(j - 1, zs)];
          const td = Math.sqrt(tdx * tdx + tdy * tdy);
          if (td < 0.1) continue;

          // Perpendicular direction
          const perpX = -tdy / td;
          const perpY = tdx / td;

          // Search perpendicular — cap at maxLateralDrift
          let bestOff = 0, bestErr = Math.abs(elevErr);
          for (const off of [1, -1, 2, -2, 4, -4, 7, -7, 10, -10, 15, -15]) {
            if (Math.abs(off) > maxLateralDrift) continue;
            const tx = wx[j] + off * perpX;
            const ty = wy[j] + off * perpY;
            const te = getElevAt(tx, ty);
            if (!isNaN(te)) {
              const err = Math.abs(te - targetE);
              if (err < bestErr) {
                bestErr = err;
                bestOff = off;
              }
            }
          }

          if (bestOff !== 0) {
            // Damped move: stepScale controls how far we go per pass
            wx[j] += stepScale * bestOff * perpX;
            wy[j] += stepScale * bestOff * perpY;
          }
        }
      }

      // Laplacian smoothing pass — pull each moved vertex toward its neighbors' midpoint
      // This prevents the trail from developing kinks/detours from lateral moves
      // Skip frozen vertices — they must not move
      const smoothBlend = Math.min(0.3, stepScale * 0.75);
      for (let j = 1; j < n - 1; j++) {
        if (!isProblematic[j] || p2Frozen[j]) continue;
        const mx = (wx[j - 1] + wx[j + 1]) / 2;
        const my = (wy[j - 1] + wy[j + 1]) / 2;
        wx[j] += smoothBlend * (mx - wx[j]);
        wy[j] += smoothBlend * (my - wy[j]);
      }

      // Update cumulative distances
      updateCumDist();

      // Compute max segment grade for reporting
      maxSeg = 0;
      for (let j = 1; j < n; j++) {
        const sl = segLen(j - 1);
        if (sl < 0.1) continue;
        const g = Math.abs(getElev(j) - getElev(j - 1)) / sl;
        if (g > maxSeg) maxSeg = g;
      }

      if (onProgress) {
        onProgress(pass + 1, passes, steepCount, maxSeg);
      }

      if (onFrame) {
        const frameCoords = [];
        for (let j = 0; j < n; j++) {
          const [lng, lat] = Projection.utmToWgs84(wx[j], wy[j]);
          frameCoords.push([lng, lat]);
        }
        onFrame(frameCoords);
      }

      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // Convert back to WGS84
    const resultCoords = [];
    const resultElevs = [];
    for (let j = 0; j < n; j++) {
      const [lng, lat] = Projection.utmToWgs84(wx[j], wy[j]);
      resultCoords.push([lng, lat]);
      resultElevs.push(getElev(j));
    }

    // Final stats
    let finalMaxSeg = 0;
    for (let j = 1; j < n; j++) {
      const sl = segLen(j - 1);
      if (sl < 0.1) continue;
      const g = Math.abs(getElev(j) - getElev(j - 1)) / sl;
      if (g > finalMaxSeg) finalMaxSeg = g;
    }

    return {
      coords: resultCoords,
      elevations: resultElevs,
      stats: {
        maxSegGrade: finalMaxSeg,
        length: cumDist[n - 1],
        steepVertices: steepCount,
        totalElevChange: Math.abs(elevations[elevations.length - 1] - elevations[0])
      }
    };
  }

  return { optimize, gradeRedistribute, DEFAULTS, buildAspectGrid, loadAspectGridFromCache };
})();
