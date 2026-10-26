/**
 * terrain-fetch.js — Download elevation for an area from the USGS 3DEP
 * ImageServer (United States only), already projected to UTM.
 *
 * The service returns its best available data for each spot (1 m lidar
 * where it exists, otherwise 1/3 arc-second ~10 m), resampled to the
 * requested grid. Requests are tiled to stay well under the service's
 * 8000 x 8000 pixel limit and mosaicked into one raster.
 */
const TerrainFetch = (() => {
  const SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
  const MAX_PIXELS = 25e6;
  const TILE = 2000;
  const CONCURRENCY = 3;
  const RESOLUTIONS = [1, 2, 3, 5, 10];

  /**
   * Work out the UTM grid for a WGS84 bounding box plus a buffer in meters.
   * Returns { zone, south, datum, epsg, minE, maxN, res, W, H, widthKm, heightKm, mb }
   * or { error }.
   */
  function plan(bbox, bufferM = 0, resolution = null) {
    const { zone, south } = Projection.zoneForLngLat((bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2);
    const datum = !south && zone <= 23 ? 'NAD83' : 'WGS84';
    const epsg = datum === 'NAD83' ? 26900 + zone : (south ? 32700 : 32600) + zone;
    const conv = proj4('EPSG:4326', Projection.utmDef(zone, south, datum));

    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        if (i % 4 && j % 4) continue;
        const lng = bbox.west + (i / 4) * (bbox.east - bbox.west);
        const lat = bbox.south + (j / 4) * (bbox.north - bbox.south);
        const [e, n] = conv.forward([lng, lat]);
        minE = Math.min(minE, e); maxE = Math.max(maxE, e);
        minN = Math.min(minN, n); maxN = Math.max(maxN, n);
      }
    }
    minE -= bufferM; maxE += bufferM; minN -= bufferM; maxN += bufferM;
    const wM = maxE - minE, hM = maxN - minN;
    const options = RESOLUTIONS.filter(r => (wM / r) * (hM / r) <= MAX_PIXELS);
    if (!options.length) {
      return { error: `The area is ${(wM / 1000).toFixed(0)} × ${(hM / 1000).toFixed(0)} km — too large to download in a browser. ` +
                      'Zoom in, or select fewer trails.' };
    }
    const res = options.includes(resolution) ? resolution : options[0];
    minE = Math.floor(minE / res) * res;
    maxN = Math.ceil(maxN / res) * res;
    const W = Math.ceil((maxE - minE) / res);
    const H = Math.ceil((maxN - minN) / res);
    return {
      zone, south, datum, epsg, minE, maxN, res, W, H,
      widthKm: W * res / 1000, heightKm: H * res / 1000,
      mb: W * H * 4 / 1e6,
      options: options.map(r => ({ res: r, mb: (wM / r) * (hM / r) * 4 / 1e6 }))
    };
  }

  /** Fetch one tile, streaming so progress can be reported (onBytes(delta)). */
  async function fetchTile(url, onBytes, signal) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      let got = 0;
      try {
        const resp = await fetch(url, { signal });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const type = resp.headers.get('content-type') || '';
        if (!/tiff/i.test(type)) {
          const text = (await resp.text()).slice(0, 200);
          throw new Error('USGS returned an error: ' + text);
        }
        const reader = resp.body.getReader();
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          onBytes(value.length);
        }
        const buf = new Uint8Array(got);
        let o = 0;
        for (const c of chunks) { buf.set(c, o); o += c.length; }
        return buf.buffer;
      } catch (e) {
        onBytes(-got);
        if (signal && signal.aborted) throw e;
        lastErr = e;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw new Error('Could not download elevation from USGS (' + lastErr.message + ')');
  }

  /**
   * Download the planned grid, a few tiles at a time.
   * onProgress(receivedBytes, expectedBytes). Returns a raster in the plan's
   * UTM CRS: { data: Float32Array, width, height, originX, originY, pixelSizeX, pixelSizeY }
   */
  async function fetchMosaic(p, onProgress, signal) {
    const data = new Float32Array(p.W * p.H).fill(NaN);
    const tiles = [];
    for (let ty = 0; ty < p.H; ty += TILE) {
      for (let tx = 0; tx < p.W; tx += TILE) {
        tiles.push({ tx, ty, tw: Math.min(TILE, p.W - tx), th: Math.min(TILE, p.H - ty) });
      }
    }
    const G = GeoTIFF.fromArrayBuffer ? GeoTIFF : GeoTIFF.default;
    const expected = p.W * p.H * 4;
    let received = 0;
    const onBytes = (n) => { received += n; if (onProgress) onProgress(received, expected); };

    async function load(t) {
      const x0 = p.minE + t.tx * p.res, x1 = x0 + t.tw * p.res;
      const y1 = p.maxN - t.ty * p.res, y0 = y1 - t.th * p.res;
      const url = `${SERVICE}?bbox=${x0},${y0},${x1},${y1}&bboxSR=${p.epsg}&imageSR=${p.epsg}` +
                  `&size=${t.tw},${t.th}&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image`;
      const buf = await fetchTile(url, onBytes, signal);
      const img = await (await G.fromArrayBuffer(buf)).getImage();
      if (img.getWidth() !== t.tw || img.getHeight() !== t.th) {
        throw new Error(`USGS returned a ${img.getWidth()}×${img.getHeight()} tile instead of ${t.tw}×${t.th}`);
      }
      const r = (await img.readRasters({ samples: [0] }))[0];
      const isNodata = DemCrs.makeNodataTest(img.getGDALNoData());
      for (let row = 0; row < t.th; row++) {
        const dst = (t.ty + row) * p.W + t.tx, src = row * t.tw;
        for (let col = 0; col < t.tw; col++) {
          const v = r[src + col];
          data[dst + col] = isNodata(v) ? NaN : v;
        }
      }
    }

    let next = 0;
    const worker = async () => { while (next < tiles.length) await load(tiles[next++]); };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, worker));
    return { data, width: p.W, height: p.H, originX: p.minE, originY: p.maxN, pixelSizeX: p.res, pixelSizeY: -p.res };
  }

  return { plan, fetchMosaic };
})();
