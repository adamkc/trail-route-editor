/**
 * dem-panel.js — "DEM setup" panel shown after a user picks a DEM.
 *
 * Shows what was detected (CRS, resolution, units, trail overlap) and lets
 * the user confirm elevation units and the processing area before the
 * pipeline runs.
 */
const DemPanel = (() => {
  let handlers = null;
  let current = null;
  let busy = false;

  const $ = (id) => document.getElementById(id);

  function fmtMB(bytes) {
    return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB';
  }

  function show(opts, h) {
    current = opts;
    handlers = h;
    busy = false;
    const { fileName, info } = opts;

    $('dem-panel-file').textContent = fileName;

    // Coordinate system
    $('dem-crs').textContent = info.crs.label;
    const crsNote = $('dem-crs-note');
    crsNote.className = 'dem-note';
    if (info.error) {
      crsNote.classList.add('dem-note-error');
      crsNote.textContent = "Can't use this DEM: " + info.error;
    } else if (info.needsReprojection && info.extent) {
      const e = info.extent;
      const { zone, south } = Projection.zoneForLngLat((e.west + e.east) / 2, (e.south + e.north) / 2);
      crsNote.textContent = `Will be reprojected to UTM zone ${zone}${south ? 'S' : 'N'} while processing.`;
    } else {
      crsNote.textContent = 'Used as-is.';
    }

    const hint = $('dem-gdal-hint');
    if (info.error) {
      const e = info.extent;
      hint.textContent = 'Convert it with GDAL, then load the new file:\n' +
        DemCrs.gdalwarpHint(info.crs, e ? (e.west + e.east) / 2 : NaN, e ? (e.south + e.north) / 2 : NaN);
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }

    // Size / resolution
    const res = info.pixelSizeM ? `~${info.pixelSizeM < 10 ? info.pixelSizeM.toFixed(2) : Math.round(info.pixelSizeM)} m pixels · ` : '';
    $('dem-size').textContent = `${res}${info.width.toLocaleString()} × ${info.height.toLocaleString()} · ${fmtMB(info.uncompressedBytes)} uncompressed`;

    // Elevation units
    $('dem-units').value = info.units.units;
    $('dem-units-hint').textContent = info.units.source === 'file'
      ? '(from file)'
      : '(assumed — no units tag in file; check this)';

    updateTrails(opts.trailCounts);
    setMessage('');
    $('pp-progress').classList.add('hidden');
    $('dem-panel').classList.remove('hidden');
    syncButtons();
  }

  function updateTrails(counts) {
    if (!current) return;
    current.trailCounts = counts;
    const { info } = current;
    const tr = $('dem-area-trails'), full = $('dem-area-full');
    const trHint = $('dem-area-trails-hint'), fullHint = $('dem-area-full-hint');

    if (counts.inside > 0) {
      tr.disabled = false;
      trHint.textContent = `${counts.inside} of ${counts.total} loaded trail${counts.total === 1 ? '' : 's'} inside this DEM`;
    } else {
      tr.disabled = true;
      trHint.textContent = counts.total > 0
        ? `none of the ${counts.total} loaded trails are inside this DEM — load trails for this area`
        : 'load trails first';
    }
    fullHint.textContent = info.isLarge
      ? `${fmtMB(info.uncompressedBytes)} — slow and memory-heavy in a browser`
      : fmtMB(info.uncompressedBytes);

    // Default: around trails for large DEMs when possible, else full extent
    if (!tr.disabled && (info.isLarge || tr.checked)) tr.checked = true;
    else full.checked = true;
    syncButtons();
  }

  function syncButtons() {
    const blocked = busy || !current || !!current.info.error;
    $('btn-dem-process').disabled = blocked;
    $('btn-dem-cancel').disabled = busy;
    $('dem-units').disabled = busy;
    for (const el of document.querySelectorAll('input[name="dem-area"]')) {
      el.disabled = busy || (el.id === 'dem-area-trails' && (!current || current.trailCounts.inside === 0));
    }
  }

  function setMessage(msg, level) {
    const el = $('dem-panel-msg');
    el.textContent = msg || '';
    el.className = 'dem-panel-msg' + (level ? ' dem-note-' + level : '');
  }

  function setBusy(b, msg) {
    busy = b;
    if (msg != null) setMessage(msg);
    if (b) $('pp-progress').classList.remove('hidden');
    syncButtons();
  }

  function progress(cur, total, label) {
    $('pp-progress').classList.remove('hidden');
    $('pp-progress-fill').style.width = Math.round(cur / total * 100) + '%';
    $('pp-progress-text').textContent = `${label ? label + ': ' : ''}${cur} / ${total}`;
  }

  function settings() {
    const area = document.querySelector('input[name="dem-area"]:checked');
    return { units: $('dem-units').value, area: area ? area.value : 'full' };
  }

  function hide() {
    $('dem-panel').classList.add('hidden');
    current = null;
    busy = false;
  }

  function isOpen() { return current !== null; }

  function init() {
    $('btn-dem-process').addEventListener('click', () => {
      if (handlers && current && !busy) handlers.onProcess(settings());
    });
    $('btn-dem-cancel').addEventListener('click', () => {
      if (handlers && !busy) { const h = handlers; hide(); h.onCancel(); }
    });
  }

  return { init, show, updateTrails, setBusy, setMessage, progress, hide, isOpen };
})();
