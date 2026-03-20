/**
 * export.js — Export edited trails as GeoJSON or KML
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

  function downloadGeoJSON(trailData) {
    const merged = mergeWaypoints(trailData);
    const json = JSON.stringify(merged, null, 2);
    download(json, 'edited_trails.geojson', 'application/geo+json');
  }

  function downloadKML(trailData) {
    const merged = mergeWaypoints(trailData);
    const kml = KmlUtils.geojsonToKML(merged);
    download(kml, 'edited_trails.kml', 'application/vnd.google-earth.kml+xml');
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

  return { downloadGeoJSON, downloadKML };
})();
