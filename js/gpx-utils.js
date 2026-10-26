/**
 * gpx-utils.js — GPX 1.1 ↔ GeoJSON (browser-native, no dependencies)
 *
 * Read: each <trk> becomes one feature (a MultiLineString when it has
 * several <trkseg>s — TrailImport joins or splits those), each <rte> a
 * LineString, each <wpt> a Point.
 * Write: trails as <trk> with <ele> when elevations are known, waypoints as
 * <wpt>. Same layout the Trail Router mobile app reads and writes.
 */
const GpxUtils = (() => {

  function text(el, tag) {
    const c = el.getElementsByTagName(tag)[0];
    return c ? c.textContent.trim() : '';
  }

  function pointsOf(el, tag) {
    const out = [];
    for (const p of el.getElementsByTagName(tag)) {
      const lat = parseFloat(p.getAttribute('lat'));
      const lon = parseFloat(p.getAttribute('lon'));
      if (isFinite(lat) && isFinite(lon)) out.push([lon, lat]);
    }
    return out;
  }

  function gpxToGeoJSON(gpxText) {
    const doc = new DOMParser().parseFromString(gpxText, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid GPX file');
    const features = [];

    let n = 0;
    for (const trk of doc.getElementsByTagName('trk')) {
      n++;
      const parts = [];
      for (const seg of trk.getElementsByTagName('trkseg')) {
        const pts = pointsOf(seg, 'trkpt');
        if (pts.length >= 2) parts.push(pts);
      }
      if (!parts.length) continue;
      const props = { Name: text(trk, 'name') || `Track ${n}` };
      const desc = text(trk, 'desc');
      if (desc) props.description = desc;
      const type = text(trk, 'type');
      if (type) props.status = type;
      features.push({
        type: 'Feature', properties: props,
        geometry: parts.length === 1 ? { type: 'LineString', coordinates: parts[0] }
                                     : { type: 'MultiLineString', coordinates: parts }
      });
    }

    n = 0;
    for (const rte of doc.getElementsByTagName('rte')) {
      n++;
      const pts = pointsOf(rte, 'rtept');
      if (pts.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: { Name: text(rte, 'name') || `Route ${n}` },
        geometry: { type: 'LineString', coordinates: pts }
      });
    }

    for (const wpt of doc.getElementsByTagName('wpt')) {
      const lat = parseFloat(wpt.getAttribute('lat'));
      const lon = parseFloat(wpt.getAttribute('lon'));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const props = { name: text(wpt, 'name') || 'Waypoint' };
      const desc = text(wpt, 'desc');
      if (desc) props.description = desc;
      const type = text(wpt, 'type');
      if (type) props.type = type;
      features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
    }

    return { type: 'FeatureCollection', features };
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fix = (v, d) => Number(v).toFixed(d);

  /**
   * @param {Object} fc        FeatureCollection of LineStrings and Points
   * @param {Function} elevFor (trailName) → array of elevations parallel to coords, or null
   */
  function geojsonToGPX(fc, elevFor, docName) {
    const wpts = [], trks = [];
    for (const f of fc.features || []) {
      const g = f.geometry, p = f.properties || {};
      if (!g) continue;
      if (g.type === 'Point') {
        const ele = p.elevation != null && isFinite(p.elevation) ? `\n    <ele>${fix(p.elevation, 1)}</ele>` : '';
        wpts.push(`  <wpt lat="${fix(g.coordinates[1], 7)}" lon="${fix(g.coordinates[0], 7)}">${ele}\n` +
                  `    <name>${esc(p.name || p.Name || 'Waypoint')}</name>` +
                  (p.type ? `\n    <type>${esc(p.type)}</type>` : '') + `\n  </wpt>`);
      } else if (g.type === 'LineString') {
        const name = p.Name || p.name || 'Trail';
        const elevs = elevFor ? elevFor(name) : null;
        const useEle = elevs && elevs.length === g.coordinates.length;
        const pts = g.coordinates.map((c, i) => {
          const e = useEle && elevs[i] != null ? `<ele>${fix(elevs[i], 1)}</ele>` : '';
          return `      <trkpt lat="${fix(c[1], 7)}" lon="${fix(c[0], 7)}">${e}</trkpt>`;
        }).join('\n');
        trks.push(`  <trk>\n    <name>${esc(name)}</name>\n` +
                  (p.status ? `    <type>${esc(p.status)}</type>\n` : '') +
                  `    <trkseg>\n${pts}\n    </trkseg>\n  </trk>`);
      }
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="Trail Route Editor"\n` +
      `     xmlns="http://www.topografix.com/GPX/1/1"\n` +
      `     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n` +
      `     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n` +
      `  <metadata><name>${esc(docName || 'Trails')}</name><time>${new Date().toISOString()}</time></metadata>\n` +
      [...wpts, ...trks].join('\n') + `\n</gpx>\n`;
  }

  return { gpxToGeoJSON, geojsonToGPX };
})();
