/**
 * trail-import.js — Read trail files into a clean WGS84 FeatureCollection.
 *
 * Formats: GeoJSON, KML, KMZ, GPX, zipped shapefile (.zip with .shp/.dbf/.prj).
 * normalize() then:
 *   - reprojects GeoJSON that is in a projected CRS (from its "crs" member)
 *   - keeps LineStrings (trails) and Points (waypoints); skips polygons
 *   - joins multi-part lines whose parts touch; splits parts with gaps into
 *     separate trails instead of drawing a straight jump between them
 *   - drops Z/M values, repeated vertices, and lines with < 2 vertices
 *   - finds a name in common attribute fields; renames duplicate names
 * and returns { data, notes } where notes describe anything changed.
 */
const TrailImport = (() => {
  const SHPJS_URL = 'https://cdn.jsdelivr.net/npm/shpjs@6.1.0/dist/shp.min.js';
  const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  const JOIN_TOLERANCE_M = 5;
  const NAME_KEYS = ['Name', 'name', 'NAME', 'TrailName', 'trail_name', 'TRAIL_NAME', 'TRAILNAME',
                     'TRL_NAME', 'title', 'Title', 'label', 'Label'];
  const ACCEPT = '.geojson,.json,.kml,.kmz,.gpx,.zip';

  const scripts = {};
  function loadScript(url) {
    if (!scripts[url]) {
      scripts[url] = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = res;
        s.onerror = () => { delete scripts[url]; rej(new Error('Could not load ' + url)); };
        document.head.appendChild(s);
      });
    }
    return scripts[url];
  }

  /** Parse a File into raw GeoJSON (not yet normalized). */
  async function parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'zip') return readShapefileZip(await file.arrayBuffer());
    if (ext === 'kmz') return readKmz(await file.arrayBuffer());
    return parseText(await file.text(), ext);
  }

  function parseText(text, ext) {
    if (ext === 'gpx') return GpxUtils.gpxToGeoJSON(text);
    if (ext === 'kml') return KmlUtils.kmlToGeoJSON(text);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Not a valid GeoJSON file (' + e.message + ')');
    }
  }

  async function readKmz(buffer) {
    await loadScript(JSZIP_URL);
    const zip = await JSZip.loadAsync(buffer);
    const entry = Object.values(zip.files).find(f => !f.dir && /\.kml$/i.test(f.name));
    if (!entry) throw new Error('No .kml file inside the KMZ');
    return KmlUtils.kmlToGeoJSON(await entry.async('string'));
  }

  async function readShapefileZip(buffer) {
    await loadScript(SHPJS_URL);
    const out = await shp(buffer);
    const list = Array.isArray(out) ? out : [out];
    return { type: 'FeatureCollection', features: list.flatMap(c => c.features || []) };
  }

  // ── Geometry helpers ──

  function haversineM(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function clean2D(coords) {
    const out = [];
    for (const c of coords || []) {
      if (!Array.isArray(c)) continue;
      const p = [Number(c[0]), Number(c[1])];
      if (!isFinite(p[0]) || !isFinite(p[1])) continue;
      if (out.length && haversineM(out[out.length - 1], p) < 0.05) continue;
      out.push(p);
    }
    return out;
  }

  /** Chain parts in file order, reversing a part when that makes its ends meet. */
  function joinParts(parts) {
    const chains = [];
    for (const part of parts) {
      const cur = chains[chains.length - 1];
      if (cur) {
        const end = cur[cur.length - 1];
        if (haversineM(end, part[0]) <= JOIN_TOLERANCE_M) { cur.push(...part.slice(1)); continue; }
        if (haversineM(end, part[part.length - 1]) <= JOIN_TOLERANCE_M) { cur.push(...part.slice(0, -1).reverse()); continue; }
        if (cur.length && haversineM(cur[0], part[part.length - 1]) <= JOIN_TOLERANCE_M) { cur.unshift(...part.slice(0, -1)); continue; }
      }
      chains.push(part.slice());
    }
    return chains;
  }

  function mapCoords(geom, fn) {
    const walk = (a) => (typeof a[0] === 'number' ? fn(a) : a.map(walk));
    return { ...geom, coordinates: walk(geom.coordinates) };
  }

  function firstCoord(features) {
    for (const f of features) {
      let a = f.geometry && f.geometry.coordinates;
      while (Array.isArray(a) && Array.isArray(a[0])) a = a[0];
      if (Array.isArray(a) && a.length >= 2) return a;
    }
    return null;
  }

  function epsgFromCrsMember(crs) {
    const name = crs && crs.properties && crs.properties.name;
    if (!name) return null;
    if (/CRS84/i.test(name)) return 4326;
    const m = /EPSG:{1,2}(\d+)/i.exec(name);
    return m ? parseInt(m[1], 10) : null;
  }

  function nameOf(props) {
    for (const k of NAME_KEYS) {
      const v = props[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  }

  // ── Normalize ──

  async function normalize(input) {
    if (!input || typeof input !== 'object') throw new Error('File does not contain GeoJSON features');
    let features =
      input.type === 'FeatureCollection' ? (input.features || []) :
      input.type === 'Feature' ? [input] :
      input.coordinates ? [{ type: 'Feature', properties: {}, geometry: input }] : null;
    if (!features) throw new Error('File does not contain GeoJSON features');
    features = features.filter(f => f && f.geometry && f.geometry.coordinates);
    if (features.length === 0) throw new Error('No features with geometry found in file');

    const notes = [];
    const sample = firstCoord(features);
    if (sample && (Math.abs(sample[0]) > 180 || Math.abs(sample[1]) > 90)) {
      const code = epsgFromCrsMember(input.crs);
      if (!code) {
        throw new Error(`The coordinates look projected (first point ${Math.round(sample[0])}, ${Math.round(sample[1])}) ` +
                        'but the file does not say which coordinate system. Export it in WGS84 (EPSG:4326) lat/long.');
      }
      const conv = proj4(await DemCrs.defForEpsg(code), 'EPSG:4326');
      features = features.map(f => ({ ...f, geometry: mapCoords(f.geometry, c => conv.forward([c[0], c[1]])) }));
      notes.push(`Converted coordinates from EPSG:${code} to lat/long.`);
    }

    const trails = [], points = [];
    let polygons = 0, dropped = 0, splitInto = 0, joined = 0;

    for (const f of features) {
      const props = { ...(f.properties || {}) };
      const g = f.geometry;
      if (g.type === 'Point' || g.type === 'MultiPoint') {
        const pts = g.type === 'Point' ? [g.coordinates] : g.coordinates;
        for (const c of pts) {
          const p = clean2D([c])[0];
          if (p) points.push({ type: 'Feature', properties: { ...props }, geometry: { type: 'Point', coordinates: p } });
        }
        continue;
      }
      if (g.type === 'Polygon' || g.type === 'MultiPolygon') { polygons++; continue; }
      if (g.type !== 'LineString' && g.type !== 'MultiLineString') { dropped++; continue; }

      const parts = (g.type === 'LineString' ? [g.coordinates] : g.coordinates)
        .map(clean2D).filter(p => p.length >= 2);
      if (parts.length === 0) { dropped++; continue; }
      const chains = joinParts(parts);
      if (parts.length > 1) joined += parts.length - chains.length;
      if (chains.length > 1) splitInto += chains.length;

      const base = nameOf(props);
      chains.forEach((c, i) => {
        const p = { ...props };
        if (base) p.Name = chains.length > 1 ? `${base} (part ${i + 1})` : base;
        trails.push({ type: 'Feature', properties: p, geometry: { type: 'LineString', coordinates: c } });
      });
    }

    // Unique names: unnamed trails get "Trail N"; repeats get " (2)", " (3)", ...
    const used = new Map();
    let unnamed = 0, renamed = 0;
    for (const t of trails) {
      let n = t.properties.Name;
      if (!n) { unnamed++; n = `Trail ${unnamed}`; }
      if (used.has(n)) {
        let k = used.get(n) + 1;
        while (used.has(`${n} (${k})`)) k++;
        used.set(n, k);
        n = `${n} (${k})`;
        renamed++;
      }
      used.set(n, used.get(n) || 1);
      t.properties.Name = n;
    }

    if (joined) notes.push(`Joined ${joined} touching line part${joined > 1 ? 's' : ''} into continuous trails.`);
    if (splitInto) notes.push(`Multi-part lines with gaps were split into ${splitInto} separate trails ("… (part 2)") rather than drawn with straight jumps.`);
    if (renamed) notes.push(`Renamed ${renamed} trail${renamed > 1 ? 's' : ''} that shared a name with another.`);
    if (polygons) notes.push(`Skipped ${polygons} polygon feature${polygons > 1 ? 's' : ''} — only lines and points are used.`);
    if (dropped) notes.push(`Skipped ${dropped} feature${dropped > 1 ? 's' : ''} with too few vertices or an unsupported geometry.`);
    if (trails.length === 0 && points.length === 0) throw new Error('No trail lines or waypoints found in the file');

    return { data: { type: 'FeatureCollection', features: [...trails, ...points] }, notes };
  }

  /** Rename incoming trails that collide with names already in use. */
  function dedupeAgainst(existingNames, data) {
    const used = new Set(existingNames);
    let renamed = 0;
    for (const f of data.features) {
      if (f.geometry.type !== 'LineString') continue;
      let n = f.properties.Name, k = 2;
      if (!used.has(n)) { used.add(n); continue; }
      while (used.has(`${n} (${k})`)) k++;
      f.properties.Name = `${n} (${k})`;
      used.add(f.properties.Name);
      renamed++;
    }
    return renamed;
  }

  return { ACCEPT, parseFile, parseText, normalize, dedupeAgainst };
})();
