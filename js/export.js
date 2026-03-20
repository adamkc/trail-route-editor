/**
 * export.js — Export edited trails as GeoJSON or KML
 */
const Export = (() => {

  function downloadGeoJSON(trailData) {
    const json = JSON.stringify(trailData, null, 2);
    download(json, 'edited_trails.geojson', 'application/geo+json');
  }

  function downloadKML(trailData) {
    const kml = KmlUtils.geojsonToKML(trailData);
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
