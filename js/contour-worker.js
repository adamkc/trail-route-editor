/**
 * contour-worker.js — Web Worker for contour generation.
 *
 * Runs marching squares + segment connection + Douglas-Peucker simplification
 * off the main thread. Processes one tile at a time to minimize memory.
 *
 * Messages:
 *   IN:  { type: 'generateTile', tileKey, data: ArrayBuffer, width, height,
 *          originX, originY, pixelSizeX, pixelSizeY, interval, format,
 *          tileSize, simplifyTolerance }
 *     format: 'raster' → returns { imageData: ArrayBuffer(RGBA), tileSize }
 *             'vector' → returns { geojson: string }
 *
 *   OUT: { type: 'tileReady', tileKey, format, result }
 *        { type: 'error', tileKey, message }
 */

// ── Marching squares (copied from contour-generator.js) ──

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
    case 0: return [c + lerp(tl, tr, level), r];
    case 1: return [c + 1, r + lerp(tr, br, level)];
    case 2: return [c + lerp(bl, br, level), r + 1];
    case 3: return [c, r + lerp(tl, bl, level)];
  }
}

function isNodata(v) {
  return v === -9999 || v === -3.4028235e+38 || v !== v;
}

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

function connectSegments(segs) {
  const K = 1e6;
  const key = (p) => ((p[0] * K) | 0) + ',' + ((p[1] * K) | 0);
  const adj = new Map();
  for (let i = 0; i < segs.length; i++) {
    for (let e = 0; e < 2; e++) {
      const k = key(segs[i][e]);
      let list = adj.get(k);
      if (!list) { list = []; adj.set(k, list); }
      list.push(i, e);
    }
  }
  const used = new Uint8Array(segs.length);
  const lines = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [segs[i][0], segs[i][1]];
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

// ── Douglas-Peucker line simplification ──

function sqDist(p, a, b) {
  let dx = b[0] - a[0], dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq > 0) {
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    if (t > 1) { dx = p[0] - b[0]; dy = p[1] - b[1]; }
    else if (t > 0) { dx = p[0] - (a[0] + t * dx); dy = p[1] - (a[1] + t * dy); }
    else { dx = p[0] - a[0]; dy = p[1] - a[1]; }
  } else {
    dx = p[0] - a[0]; dy = p[1] - a[1];
  }
  return dx * dx + dy * dy;
}

function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points;
  const tolSq = tolerance * tolerance;
  const stack = [[0, points.length - 1]];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDist = 0, maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      const d = sqDist(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > tolSq) {
      keep[maxIdx] = 1;
      if (maxIdx - start > 1) stack.push([start, maxIdx]);
      if (end - maxIdx > 1) stack.push([maxIdx, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// ── Tile generation ──

function generateVectorTile(msg) {
  const data = new Float32Array(msg.data);
  const { width, height, originX, originY, pixelSizeX, pixelSizeY, interval, simplifyTolerance } = msg;
  const tol = simplifyTolerance || 0.000005; // ~0.5m in degrees

  const byLevel = traceSegments(data, width, height, interval);
  const minorCoords = [];
  const majorCoords = [];

  for (const [level, segs] of byLevel) {
    const polylines = connectSegments(segs);
    for (const pts of polylines) {
      if (pts.length < 2) continue;
      // Convert grid coords to WGS84-like coords for simplification
      let coords = pts.map(([gx, gy]) => {
        const easting = originX + gx * pixelSizeX;
        const northing = originY + gy * pixelSizeY;
        // Inline UTM → approximate WGS84 (proj4 not available in worker)
        // Store as UTM for now, convert on main thread
        return [easting, northing];
      });
      // Simplify in UTM space (tolerance in meters — coords are already UTM)
      coords = douglasPeucker(coords, simplifyTolerance || 1.0);
      if (coords.length < 2) continue;
      if (level % 10 === 0) {
        majorCoords.push({ level, coords });
      } else {
        minorCoords.push({ level, coords });
      }
    }
  }

  return { minorCoords, majorCoords };
}

function generateRasterTile(msg) {
  const data = new Float32Array(msg.data);
  const { width, height, tileSize } = msg;
  const ts = tileSize || 256;
  const interval = 10; // major contours only for raster tiles

  const byLevel = traceSegments(data, width, height, interval);

  // Render contour lines into an RGBA pixel array
  const pixels = new Uint8ClampedArray(ts * ts * 4); // transparent by default

  const scaleX = ts / width;
  const scaleY = ts / height;

  for (const [, segs] of byLevel) {
    for (const [p1, p2] of segs) {
      // Bresenham-ish line drawing in tile pixel space
      const x0 = Math.round(p1[0] * scaleX);
      const y0 = Math.round(p1[1] * scaleY);
      const x1 = Math.round(p2[0] * scaleX);
      const y1 = Math.round(p2[1] * scaleY);
      drawLine(pixels, ts, x0, y0, x1, y1, 0, 0, 0, 140); // black, semi-transparent
    }
  }

  return { pixels: pixels.buffer, tileSize: ts };
}

function drawLine(pixels, size, x0, y0, x1, y1, r, g, b, a) {
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x0 >= 0 && x0 < size && y0 >= 0 && y0 < size) {
      const idx = (y0 * size + x0) * 4;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = a;
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// ── Message handler ──

self.onmessage = function(e) {
  const msg = e.data;
  if (msg.type !== 'generateTile') return;

  try {
    if (msg.format === 'vector') {
      const result = generateVectorTile(msg);
      self.postMessage({ type: 'tileReady', tileKey: msg.tileKey, format: 'vector', result });
    } else if (msg.format === 'raster') {
      const result = generateRasterTile(msg);
      self.postMessage(
        { type: 'tileReady', tileKey: msg.tileKey, format: 'raster', result },
        [result.pixels] // transfer ownership
      );
    }
  } catch (err) {
    self.postMessage({ type: 'error', tileKey: msg.tileKey, message: err.message });
  }
};
