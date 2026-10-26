/**
 * export.js — Export trails and waypoints as GeoJSON, KML, or GPX.
 *
 * GeoJSON trails carry sampled elevations as Z values and per-trail stats
 * (length, gain/loss, average/max grade) as properties. GPX trails carry
 * <ele> per point.
 */
const Export = (() => {

  function mergeWaypoints(trailData) {
    if (typeof Waypoints === 'undefined' || Waypoints.getCount() === 0) return trailData;
    const wpGeoJSON = Waypoints.getWaypointsGeoJSON();
    return {
      type: 'FeatureCollection',
      features: [...trailData.features, ...wpGeoJSON.features]
    };
  }

  function nameOf(f) { return f.properties.Name || f.properties.name; }

  function elevationsFor(name, n) {
    const e = VertexEditor.getElevations(name);
    return e && e.length === n && e.every(v => v != null) ? e : null;
  }

  /** Trail features with Z coordinates and summary stats added. */
  function withElevationsAndStats(trailData) {
    return {
      type: 'FeatureCollection',
      features: trailData.features.map(f => {
        if (!f.geometry || f.geometry.type !== 'LineString') return f;
        const name = nameOf(f);
        const coords = f.geometry.coordinates;
        const props = { ...f.properties };
        const m = VertexEditor.getMetrics(name);
        if (m && m.summary && m.summary.length_m > 0) {
          const s = m.summary;
          Object.assign(props, {
            length_m: s.length_m, elev_gain_m: s.elev_gain_m, elev_loss_m: s.elev_loss_m,
            avg_grade_pct: s.avg_grade_pct, max_grade_pct: s.max_grade_pct
          });
        }
        const e = elevationsFor(name, coords.length);
        const out = coords.map((c, i) => e ? [c[0], c[1], Math.round(e[i] * 100) / 100] : [c[0], c[1]]);
        return { ...f, properties: props, geometry: { type: 'LineString', coordinates: out } };
      })
    };
  }

  function downloadGeoJSON(trailData, baseName) {
    const merged = mergeWaypoints(withElevationsAndStats(trailData));
    download(JSON.stringify(merged, null, 2), baseName + '.geojson', 'application/geo+json');
  }

  function downloadKML(trailData, baseName) {
    const merged = mergeWaypoints(trailData);
    download(KmlUtils.geojsonToKML(merged), baseName + '.kml', 'application/vnd.google-earth.kml+xml');
  }

  function downloadGPX(trailData, baseName) {
    const merged = mergeWaypoints(trailData);
    const gpx = GpxUtils.geojsonToGPX(merged, (name) => {
      const f = trailData.features.find(x => nameOf(x) === name);
      return f ? elevationsFor(name, f.geometry.coordinates.length) : null;
    }, baseName);
    download(gpx, baseName + '.gpx', 'application/gpx+xml');
  }

  function download(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return { downloadGeoJSON, downloadKML, downloadGPX, download };
})();
