/**
 * units.js — Display units: metric (m, km) or US (ft, mi).
 *
 * Everything is computed and stored in meters; this only converts for
 * display. Grades are unitless. The choice is remembered per browser.
 */
const Units = (() => {
  const KEY = 'trail-editor-units';
  const FT_PER_M = 3.28084;
  const M_PER_MI = 1609.344;
  let system = 'metric';
  try { if (localStorage.getItem(KEY) === 'imperial') system = 'imperial'; } catch (e) {}
  const listeners = [];

  const isImperial = () => system === 'imperial';

  function set(s) {
    system = s === 'imperial' ? 'imperial' : 'metric';
    try { localStorage.setItem(KEY, system); } catch (e) {}
    for (const f of listeners) f(system);
  }

  function onChange(fn) { listeners.push(fn); }

  // Chart axis values: distance in m or mi, elevation in m or ft
  const dist = (m) => isImperial() ? m / M_PER_MI : m;
  const distToM = (v) => isImperial() ? v * M_PER_MI : v;
  const distUnit = () => isImperial() ? 'mi' : 'm';
  const elev = (m) => isImperial() ? m * FT_PER_M : m;
  const elevUnit = () => isImperial() ? 'ft' : 'm';

  /** Trail length: "850 m" / "2.19 km", or "420 ft" / "1.36 mi". */
  function fmtLen(m) {
    if (m == null || !isFinite(m)) return '—';
    if (isImperial()) {
      const mi = m / M_PER_MI;
      return mi < 0.1 ? `${Math.round(m * FT_PER_M).toLocaleString()} ft` : `${mi.toFixed(2)} mi`;
    }
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  }

  /** Elevation or elevation change; feet are always whole numbers. */
  function fmtElev(m, metricDigits = 0) {
    if (m == null || !isFinite(m)) return '—';
    const digits = isImperial() ? 0 : metricDigits;
    return `${elev(m).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${elevUnit()}`;
  }

  return { isImperial, set, onChange, dist, distToM, distUnit, elev, elevUnit, fmtLen, fmtElev,
           get system() { return system; } };
})();
