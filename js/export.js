/**
 * export.js — Export edited trails as GeoJSON
 */
const Export = (() => {

  function downloadGeoJSON(trailData) {
    const json = JSON.stringify(trailData, null, 2);
    const blob = new Blob([json], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'edited_trails.geojson';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return { downloadGeoJSON };
})();
