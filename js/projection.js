/**
 * projection.js — WGS84 (EPSG:4326) <-> working UTM zone conversion.
 *
 * All metric work (distances, grades, rasters, optimizer) happens in one UTM
 * zone. The zone follows the loaded DEM; until a DEM sets it, the working CRS
 * is NAD83 / UTM 10N, which is also what caches written before per-DEM zones
 * existed were built in.
 */
const Projection = (() => {
  let crs = null;
  let converter = null;

  function utmDef(zone, south, datum) {
    return `+proj=utm +zone=${zone}${south ? ' +south' : ''} ` +
           `+datum=${datum === 'NAD83' ? 'NAD83' : 'WGS84'} +units=m +no_defs +type=crs`;
  }

  /**
   * Switch the working CRS. NAD83 only has EPSG UTM codes for northern
   * zones 1–23; anything else falls back to WGS84 (sub-2 m difference).
   */
  function setUtm(zone, south = false, datum = 'NAD83') {
    zone = Math.round(zone);
    if (!(zone >= 1 && zone <= 60)) throw new Error('Invalid UTM zone: ' + zone);
    south = !!south;
    if (datum !== 'NAD83' || south || zone > 23) datum = 'WGS84';
    const code = datum === 'NAD83' ? 'EPSG:' + (26900 + zone)
                                   : 'EPSG:' + ((south ? 32700 : 32600) + zone);
    proj4.defs(code, utmDef(zone, south, datum));
    converter = proj4('EPSG:4326', code);
    crs = {
      code, zone, south, datum,
      label: `${datum === 'NAD83' ? 'NAD83' : 'WGS 84'} / UTM zone ${zone}${south ? 'S' : 'N'}`
    };
    return crs;
  }

  function zoneForLngLat(lng, lat) {
    return {
      zone: Math.min(60, Math.max(1, Math.floor((lng + 180) / 6) + 1)),
      south: lat < 0
    };
  }

  function getCrs() { return { ...crs }; }

  function isSame(other) {
    return !!other && other.zone === crs.zone && !!other.south === crs.south &&
           (other.datum || 'NAD83') === crs.datum;
  }

  function wgs84ToUtm(lng, lat) {
    if (!isFinite(lng) || !isFinite(lat)) return [NaN, NaN];
    return converter.forward([lng, lat]);
  }

  function utmToWgs84(easting, northing) {
    if (!isFinite(easting) || !isFinite(northing)) return [NaN, NaN];
    return converter.inverse([easting, northing]);
  }

  /**
   * 2D distance in meters between two WGS84 points, measured in the working
   * UTM zone.
   */
  function distanceM(lngLat1, lngLat2) {
    if (!lngLat1 || !lngLat2 ||
        !isFinite(lngLat1[0]) || !isFinite(lngLat1[1]) ||
        !isFinite(lngLat2[0]) || !isFinite(lngLat2[1])) return 0;
    const [e1, n1] = wgs84ToUtm(lngLat1[0], lngLat1[1]);
    const [e2, n2] = wgs84ToUtm(lngLat2[0], lngLat2[1]);
    return Math.sqrt((e2 - e1) ** 2 + (n2 - n1) ** 2);
  }

  setUtm(10, false, 'NAD83');

  return { setUtm, zoneForLngLat, getCrs, isSame, utmDef, wgs84ToUtm, utmToWgs84, distanceM };
})();
