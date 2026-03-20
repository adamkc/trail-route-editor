/**
 * projection.js — UTM Zone 10N (EPSG:26910) <-> WGS84 (EPSG:4326) conversion
 */
const Projection = (() => {
  // Define EPSG:26910 for proj4
  proj4.defs('EPSG:26910',
    '+proj=utm +zone=10 +datum=NAD83 +units=m +no_defs +type=crs');

  function wgs84ToUtm(lng, lat) {
    return proj4('EPSG:4326', 'EPSG:26910', [lng, lat]);
  }

  function utmToWgs84(easting, northing) {
    return proj4('EPSG:26910', 'EPSG:4326', [easting, northing]);
  }

  /**
   * Compute 2D distance in meters between two WGS84 points
   * by converting to UTM first.
   */
  function distanceM(lngLat1, lngLat2) {
    const [e1, n1] = wgs84ToUtm(lngLat1[0], lngLat1[1]);
    const [e2, n2] = wgs84ToUtm(lngLat2[0], lngLat2[1]);
    return Math.sqrt((e2 - e1) ** 2 + (n2 - n1) ** 2);
  }

  return { wgs84ToUtm, utmToWgs84, distanceM };
})();
