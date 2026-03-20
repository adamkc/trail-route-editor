/**
 * contour-generator.js — Marching-squares contour line generation from DEM raster.
 * Produces GeoJSON MultiLineStrings for minor (2 m) and major (10 m) contours.
 */
const ContourGenerator = (() => {

  /* ---- Marching squares lookup ----
   * Corner order:  TL(8) TR(4)
   *                BL(1) BR(2)
   * Edge indices:  0=top  1=right  2=bottom  3=left
   */
  const EDGES = [
    [],             // 0
    [[3, 2]],       // 1
    [[2, 1]],       // 2
    [[3, 1]],       // 3
    [[1, 0]],       // 4
    [[3, 0],[1, 2]],// 5 saddle
    [[2, 0]],       // 6
    [[3, 0]],       // 7
    [[0, 3]],       // 8
    [[0, 2]],       // 9
    [[0, 1],[2, 3]],// 10 saddle
    [[0, 1]],       // 11
    [[1, 3]],       // 12
    [[1, 2]],       // 13
    [[2, 3]],       // 14
    []              // 15
  ];

  function lerp(v1, v2, level) {
    const d = v2 - v1;
    return Math.abs(d) < 1e-10 ? 0.5 : (level - v1) / d;
  }

  function edgePoint(r, c, edge, tl, tr, bl, br, level) {
    switch (edge) {
      case 0: return [c + lerp(tl, tr, level), r];              // top
      case 1: return [c + 1,                   r + lerp(tr, br, level)]; // right
      case 2: return [c + lerp(bl, br, level), r + 1];          // bottom
      case 3: return [c,                       r + lerp(tl, bl, level)]; // left
    }
  }

  function isNodata(v) {
    return v === -9999 || v === -3.4028235e+38 || v !== v; // NaN check
  }

  /**
   * Generate contour line segments from a DEM raster.
   * interval: contour spacing in meters (e.g. 2)
   * Returns Map<level, [[p1,p2], ...]> in grid coordinates.
   */
  function traceSegments(data, w, h, interval) {
    const byLevel = new Map();

    for (let r = 0; r < h - 1; r++) {
      const row0 = r * w;
      const row1 = row0 + w;
      for (let c = 0; c < w - 1; c++) {
        const tl = data[row0 + c];
        const tr = data[row0 + c + 1];
        const bl = data[row1 + c];
        const br = data[row1 + c + 1];

        if (isNodata(tl) || isNodata(tr) || isNodata(bl) || isNodata(br)) continue;

        const lo = Math.min(tl, tr, bl, br);
        const hi = Math.max(tl, tr, bl, br);
        const first = Math.ceil(lo / interval) * interval;

        for (let lev = first; lev <= hi; lev += interval) {
          let ci = 0;
          if (tl >= lev) ci |= 8;
          if (tr >= lev) ci |= 4;
          if (br >= lev) ci |= 2;
          if (bl >= lev) ci |= 1;

          const pairs = EDGES[ci];
          if (!pairs.length) continue;

          let arr = byLevel.get(lev);
          if (!arr) { arr = []; byLevel.set(lev, arr); }

          for (const [e1, e2] of pairs) {
            arr.push([
              edgePoint(r, c, e1, tl, tr, bl, br, lev),
              edgePoint(r, c, e2, tl, tr, bl, br, lev)
            ]);
          }
        }
      }
    }
    return byLevel;
  }

  /**
   * Connect 2-point segments into polylines using endpoint hashing.
   */
  function connectSegments(segs) {
    const K = 1e6;
    const key = (p) => ((p[0] * K) | 0) + ',' + ((p[1] * K) | 0);

    // Build adjacency: endpoint key -> list of [segIdx, whichEnd(0|1)]
    const adj = new Map();
    for (let i = 0; i < segs.length; i++) {
      for (let e = 0; e < 2; e++) {
        const k = key(segs[i][e]);
        let list = adj.get(k);
        if (!list) { list = []; adj.set(k, list); }
        list.push(i, e); // flat pairs for speed
      }
    }

    const used = new Uint8Array(segs.length);
    const lines = [];

    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;

      const line = [segs[i][0], segs[i][1]];

      // Walk forward from line end
      for (;;) {
        const k = key(line[line.length - 1]);
        const list = adj.get(k);
        if (!list) break;
        let found = false;
        for (let j = 0; j < list.length; j += 2) {
          const si = list[j], se = list[j + 1];
          if (used[si]) continue;
          used[si] = 1;
          line.push(segs[si][1 - se]);
          found = true;
          break;
        }
        if (!found) break;
      }

      // Walk backward from line start
      for (;;) {
        const k = key(line[0]);
        const list = adj.get(k);
        if (!list) break;
        let found = false;
        for (let j = 0; j < list.length; j += 2) {
          const si = list[j], se = list[j + 1];
          if (used[si]) continue;
          used[si] = 1;
          line.unshift(segs[si][1 - se]);
          found = true;
          break;
        }
        if (!found) break;
      }

      lines.push(line);
    }
    return lines;
  }

  /**
   * Main entry point.  Returns a GeoJSON FeatureCollection with two features:
   *   properties.class === 'minor'  (2 m contours that are NOT multiples of 10)
   *   properties.class === 'major'  (10 m contours)
   *
   * raster: result of DemSampler.getFullRaster()
   */
  function generate(raster) {
    const { data, width, height, originX, originY, pixelSizeX, pixelSizeY } = raster;

    console.log('[contours] tracing 2 m interval …');
    const byLevel = traceSegments(data, width, height, 2);

    // Convert grid coords → UTM → WGS 84 and split minor / major
    const minorCoords = [];
    const majorCoords = [];

    for (const [level, segs] of byLevel) {
      const polylines = connectSegments(segs);

      for (const pts of polylines) {
        if (pts.length < 2) continue;
        const coords = pts.map(([gx, gy]) => {
          const easting  = originX + gx * pixelSizeX;
          const northing = originY + gy * pixelSizeY;
          const [lng, lat] = Projection.utmToWgs84(easting, northing);
          return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
        });
        if (level % 10 === 0) {
          majorCoords.push(coords);
        } else {
          minorCoords.push(coords);
        }
      }
    }

    console.log(`[contours] minor lines: ${minorCoords.length}, major lines: ${majorCoords.length}`);

    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'MultiLineString', coordinates: minorCoords },
          properties: { class: 'minor' }
        },
        {
          type: 'Feature',
          geometry: { type: 'MultiLineString', coordinates: majorCoords },
          properties: { class: 'major' }
        }
      ]
    };
  }

  return { generate };
})();
