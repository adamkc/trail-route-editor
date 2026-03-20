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
    maxGrade:       0.25,   // hard cap: segments above this grade get extra correction
    vertexSpacing:  10,
    maxDrift:       200,
    stepSize:       0.3,
    maxIter:        2000,
    wElev:          7.0,
    wAttract:       2.0,
    wSmooth:        1.5,
    wRepel:         0.5,
    wSlopeCap:      4.0,    // strength of slope-cap correction force
    minSeparation:  40,
    repelSkip:      3,
    repelRadius:    60,
    batchSize:      15    // iterations per async batch (for live rendering)
  };

  // ── Aspect grid (computed once from DEM raster) ──
  let aspectGrid = null;  // { data, width, height, originX, originY, pxX, pxY }

  async function buildAspectGrid() {
    const r = await DemSampler.getFullRaster();
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
    const { stepSize, wElev, wAttract, wSmooth, wRepel, wSlopeCap,
            minSeparation, repelSkip, repelRadius, maxDrift, maxGrade } = params;
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

      // 1. Elevation force
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

      // 5. Slope cap force — push vertices sideways when segment grade exceeds maxGrade
      // Uses escalating strength: the more over the cap, the harder the push.
      // Also scales up over iterations so early iterations focus on shape,
      // later iterations enforce the cap more strictly.
      if (wSlopeCap > 0 && maxGrade > 0) {
        for (let j = 1; j < n - 1; j++) {
          // Check both adjacent segments (j-1→j and j→j+1)
          for (const [a, b] of [[j - 1, j], [j, j + 1]]) {
            if (b >= n) continue;
            const dx = coords[b * 2] - coords[a * 2];
            const dy = coords[b * 2 + 1] - coords[a * 2 + 1];
            const segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen < 0.1) continue;
            const dElev = Math.abs(elev[b] - elev[a]);
            if (isNaN(dElev)) continue;
            const grade = dElev / segLen;
            if (grade <= maxGrade) continue;

            // How far over the cap (ratio > 1 means over)
            const overRatio = grade / maxGrade;
            // Exponential penalty: stronger the further over the cap
            const penalty = (overRatio - 1) * overRatio;

            // Push vertex j perpendicular to the segment direction
            const perpX = -dy / segLen;
            const perpY =  dx / segLen;

            // Use aspect to choose which perpendicular direction follows the contour
            const asp = sampleAspectUTM(coords[j * 2], coords[j * 2 + 1]);
            let sign = 1;
            if (!isNaN(asp)) {
              const contourX = Math.cos(asp);
              const contourY = -Math.sin(asp);
              const dot = perpX * contourX + perpY * contourY;
              sign = dot >= 0 ? 1 : -1;
            }

            const strength = wSlopeCap * Math.min(penalty, 5.0);
            force[j * 2]     += strength * sign * perpX;
            force[j * 2 + 1] += strength * sign * perpY;
          }
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

  function smoothCoords(coords, n, raster, maxGradeLimit) {
    const out = new Float64Array(n * 2);
    // Copy endpoints
    out[0] = coords[0]; out[1] = coords[1];
    out[(n - 1) * 2] = coords[(n - 1) * 2]; out[(n - 1) * 2 + 1] = coords[(n - 1) * 2 + 1];
    // 3-point average for interior
    for (let j = 1; j < n - 1; j++) {
      out[j * 2]     = (coords[(j - 1) * 2]     + coords[j * 2]     + coords[(j + 1) * 2]) / 3;
      out[j * 2 + 1] = (coords[(j - 1) * 2 + 1] + coords[j * 2 + 1] + coords[(j + 1) * 2 + 1]) / 3;
    }
    // Grade-aware Douglas-Peucker simplification (0.5m tolerance)
    return douglasPeucker(out, n, 0.5, raster, maxGradeLimit);
  }

  function douglasPeucker(flatCoords, n, tolerance, raster, maxGradeLimit) {
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
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
    const raster = await DemSampler.getFullRaster();
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
        stats: { grade: elevChange / origLength, length: origLength, mse: 0, iterations: 0 }
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

    // Smooth the result (pass raster + maxGrade so DP won't re-introduce steep segments)
    const smoothedUTM = smoothCoords(finalCoords, n, raster, P.maxGrade);

    // Convert back to WGS84
    const resultCoords = smoothedUTM.map(([e, n]) => {
      const [lng, lat] = Projection.utmToWgs84(e, n);
      return [lng, lat];
    });

    // Sample elevations for result
    const resultElevs = [];
    for (const c of resultCoords) {
      const elev = await DemSampler.sampleAtLngLat(c[0], c[1]);
      resultElevs.push(elev);
    }

    const finalGrade = elevChange / finalLen;
    return {
      coords: resultCoords,
      elevations: resultElevs,
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

  return { optimize, DEFAULTS, buildAspectGrid };
})();
