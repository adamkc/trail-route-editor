/**
 * dem-crs.js — Identify a GeoTIFF's coordinate system and units from its
 * GeoKeys, and build transforms between it and WGS84.
 *
 * Kinds:
 *   utm         — any UTM zone (NAD83, NAD83(2011), WGS84); read directly
 *   geographic  — lon/lat degrees; reprojected into UTM during processing
 *   projected   — any other EPSG projected CRS (State Plane, Albers, ...);
 *                 reprojected using a proj4 definition (built in or epsg.io)
 *   unsupported — NAD27, user-defined non-UTM projections, missing CRS
 */
const DemCrs = (() => {
  const UNIT_CODES = { 9001: 'm', 9002: 'ft', 9003: 'usft' };
  const UNIT_TO_M = { m: 1, ft: 0.3048, usft: 1200 / 3937 };
  const UNIT_LABEL = { m: 'meters', ft: 'feet', usft: 'US survey feet' };

  const BUILTIN_DEFS = {
    3310: '+proj=aea +lat_0=0 +lon_0=-120 +lat_1=34 +lat_2=40.5 +x_0=0 +y_0=-4000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
    5070: '+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs +type=crs',
    3857: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs'
  };

  const DEF_CACHE_PREFIX = 'trail-editor-proj4:';

  function utmFromEpsg(code) {
    if (code >= 26901 && code <= 26923) return { zone: code - 26900, south: false, datum: 'NAD83' };
    if (code >= 32601 && code <= 32660) return { zone: code - 32600, south: false, datum: 'WGS84' };
    if (code >= 32701 && code <= 32760) return { zone: code - 32700, south: true, datum: 'WGS84' };
    // NAD83(2011) / UTM: 6328 = 59N, 6329 = 60N, 6330–6348 = 1N–19N
    if (code === 6328) return { zone: 59, south: false, datum: 'NAD83' };
    if (code === 6329) return { zone: 60, south: false, datum: 'NAD83' };
    if (code >= 6330 && code <= 6348) return { zone: code - 6329, south: false, datum: 'NAD83' };
    if (code >= 26703 && code <= 26722) return { zone: code - 26700, south: false, datum: 'NAD27' };
    return null;
  }

  function datumFromText(text) {
    if (/NAD\s?27|1927/i.test(text)) return 'NAD27';
    if (/NAD\s?83|1983/i.test(text)) return 'NAD83';
    return 'WGS84';
  }

  function utmFromCitation(text) {
    const m = /UTM[\s_]*zone[\s_]*(\d{1,2})\s*([NS])?/i.exec(text || '');
    if (!m) return null;
    return { zone: parseInt(m[1], 10), south: (m[2] || 'N').toUpperCase() === 'S', datum: datumFromText(text) };
  }

  /**
   * Describe the CRS of a GeoTIFF from geotiff.js `image.getGeoKeys()`.
   */
  function describe(keys) {
    keys = keys || {};
    const model = keys.GTModelTypeGeoKey;
    const pcs = keys.ProjectedCSTypeGeoKey;
    const gcs = keys.GeographicTypeGeoKey;
    const citation = [keys.PCSCitationGeoKey, keys.GTCitationGeoKey, keys.GeogCitationGeoKey]
      .filter(Boolean).join(' | ');
    const vertUnits = UNIT_CODES[keys.VerticalUnitsGeoKey] || null;
    const linUnits = UNIT_CODES[keys.ProjLinearUnitsGeoKey] || null;

    const base = { epsg: null, citation, vertUnits };

    if (model !== 2) {
      const utm = (pcs && pcs !== 32767 ? utmFromEpsg(pcs) : null) ||
                  (!pcs || pcs === 32767 ? utmFromCitation(citation) : null);
      if (utm) {
        const epsg = pcs && pcs !== 32767 ? pcs : null;
        const label = `${utm.datum === 'WGS84' ? 'WGS 84' : utm.datum} / UTM zone ${utm.zone}${utm.south ? 'S' : 'N'}` +
                      (epsg ? ` (EPSG:${epsg})` : '');
        if (utm.datum === 'NAD27') {
          return { ...base, kind: 'unsupported', epsg, label, zone: utm.zone, south: utm.south,
                   reason: 'NAD27 needs a datum grid shift that the browser cannot apply (errors of ~100 m).' };
        }
        return { ...base, kind: 'utm', epsg, ...utm, horizUnits: 'm', label };
      }
      if (pcs && pcs !== 32767) {
        return { ...base, kind: 'projected', epsg: pcs, horizUnits: linUnits || 'm',
                 label: (keys.PCSCitationGeoKey || keys.GTCitationGeoKey || 'Projected CRS') + ` (EPSG:${pcs})` };
      }
      if (pcs === 32767) {
        return { ...base, kind: 'unsupported', label: citation || 'User-defined projection',
                 reason: 'The file uses a custom (non-EPSG) projection.' };
      }
    }

    if (model === 2 || gcs) {
      if (gcs === 4267 || datumFromText(citation) === 'NAD27') {
        return { ...base, kind: 'unsupported', epsg: gcs || null, label: 'NAD27 geographic',
                 reason: 'NAD27 needs a datum grid shift that the browser cannot apply (errors of ~100 m).' };
      }
      return { ...base, kind: 'geographic', epsg: gcs && gcs !== 32767 ? gcs : null, horizUnits: 'deg',
               label: (keys.GeogCitationGeoKey || 'Geographic') + ' lat/long' + (gcs && gcs !== 32767 ? ` (EPSG:${gcs})` : '') };
    }

    return { ...base, kind: 'unsupported', label: 'No coordinate system in file',
             reason: 'The GeoTIFF has no georeferencing keys.' };
  }

  /** Default vertical units: the file's own tag, else the horizontal units, else meters. */
  function guessVerticalUnits(info) {
    if (info.vertUnits) return { units: info.vertUnits, source: 'file' };
    if (info.horizUnits === 'ft' || info.horizUnits === 'usft') return { units: info.horizUnits, source: 'assumed' };
    return { units: 'm', source: 'assumed' };
  }

  /**
   * Resolve a proj4 definition string for the DEM's CRS. Fetches from
   * epsg.io for projected codes that are not built in, caching the result.
   */
  async function resolveDef(info) {
    if (info.kind === 'utm') return Projection.utmDef(info.zone, info.south, info.datum);
    if (info.kind === 'geographic') return null;
    if (info.kind !== 'projected') throw new Error(info.reason || 'Unsupported coordinate system');

    const code = info.epsg;
    if (BUILTIN_DEFS[code]) return BUILTIN_DEFS[code];
    try {
      const cached = localStorage.getItem(DEF_CACHE_PREFIX + code);
      if (cached) return cached;
    } catch (e) {}

    let def;
    try {
      const resp = await fetch(`https://epsg.io/${code}.proj4`, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      def = (await resp.text()).trim();
    } catch (e) {
      throw new Error(`Could not look up EPSG:${code} on epsg.io (${e.message}).`);
    }
    if (!def.startsWith('+proj=')) throw new Error(`epsg.io has no proj4 definition for EPSG:${code}.`);
    if (/\+nadgrids=(?!@null)/.test(def)) throw new Error(`EPSG:${code} needs a datum grid shift the browser cannot apply.`);
    try { localStorage.setItem(DEF_CACHE_PREFIX + code, def); } catch (e) {}
    return def;
  }

  /**
   * Build forward/inverse transforms between the DEM's CRS and WGS84.
   * Returns { toWgs84([x,y]) -> [lng,lat], fromWgs84([lng,lat]) -> [x,y] }.
   */
  async function makeTransformer(info) {
    if (info.kind === 'geographic') {
      return { toWgs84: (p) => [p[0], p[1]], fromWgs84: (p) => [p[0], p[1]] };
    }
    const def = await resolveDef(info);
    const conv = proj4('EPSG:4326', def);
    return {
      toWgs84: (p) => conv.inverse([p[0], p[1]]),
      fromWgs84: (p) => conv.forward([p[0], p[1]])
    };
  }

  /**
   * Command a user can run to convert an unsupported DEM to UTM. Uses the
   * DEM's own UTM zone when known, else the zone at (lng, lat).
   */
  function gdalwarpHint(info, lng, lat) {
    let zone = info && info.zone, south = info && info.south;
    if (!zone && isFinite(lng) && isFinite(lat)) ({ zone, south } = Projection.zoneForLngLat(lng, lat));
    const code = !zone ? 'EPSG:326<zone>'
               : !south && zone <= 23 ? 'EPSG:' + (26900 + zone)
               : 'EPSG:' + ((south ? 32700 : 32600) + zone);
    return `gdalwarp -t_srs ${code} -r bilinear input.tif output_utm.tif`;
  }

  /**
   * Nodata test in the DEM's native units. Besides the file's declared value,
   * treats NaN, huge float sentinels, and anything below -1000 (no dry land is
   * that low in meters or feet) as missing.
   */
  function makeNodataTest(declared) {
    const nd = declared != null && isFinite(declared) ? Math.fround(declared) : null;
    return (v) => v !== v || v < -1000 || v > 1e20 || (nd !== null && v === nd);
  }

  return {
    describe, guessVerticalUnits, resolveDef, makeTransformer, gdalwarpHint, makeNodataTest,
    UNIT_TO_M, UNIT_LABEL
  };
})();
