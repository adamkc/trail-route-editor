/**
 * stats-panel.js — Summary stats and segment table rendering
 */
const StatsPanel = (() => {

  function updateStats(summary) {
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set('stat-length',    `${summary.length_m.toFixed(0)} m`);
    set('stat-elev-min',  `${summary.elev_min_m.toFixed(1)} m`);
    set('stat-elev-max',  `${summary.elev_max_m.toFixed(1)} m`);
    set('stat-gain',      `${summary.elev_gain_m.toFixed(1)} m`);
    set('stat-loss',      `${summary.elev_loss_m.toFixed(1)} m`);
    set('stat-avg-grade', `${summary.avg_grade_pct.toFixed(1)}%`);
    set('stat-max-grade', `${summary.max_grade_pct.toFixed(1)}%`);
    set('stat-over8',     `${summary.pct_over_8.toFixed(1)}%`);
    set('stat-over12',    `${summary.pct_over_12.toFixed(1)}%`);
    set('stat-reversals', `${summary.reversals_per_100m.toFixed(1)}`);
  }

  function updateSegmentTable(segments) {
    const tbody = document.getElementById('segment-table-body');
    if (!tbody) return;

    // For large trail, limit visible rows and use virtual scrolling concept
    const maxRows = 300;
    const showSegments = segments.length > maxRows
      ? segments.slice(0, maxRows) : segments;

    const rows = showSegments.map((seg, i) => {
      const gc = seg.gradeClass;
      const dirClass = seg.direction === 'uphill' ? 'dir-up' : 'dir-down';
      const dirArrow = seg.direction === 'uphill' ? '&#x25B2;' : '&#x25BC;';

      return `<tr>
        <td>${i + 1}</td>
        <td>${seg.distStart.toFixed(0)}</td>
        <td>${seg.elevStart != null ? seg.elevStart.toFixed(1) : '—'}</td>
        <td class="grade-cell ${gc.cssClass}">${seg.gradePct.toFixed(1)}</td>
        <td class="${dirClass}">${dirArrow}</td>
      </tr>`;
    }).join('');

    tbody.innerHTML = rows;

    if (segments.length > maxRows) {
      tbody.innerHTML += `<tr><td colspan="5" style="text-align:center;color:#888">
        ... ${segments.length - maxRows} more segments</td></tr>`;
    }
  }

  function clear() {
    const ids = ['stat-length', 'stat-elev-min', 'stat-elev-max', 'stat-gain',
                 'stat-loss', 'stat-avg-grade', 'stat-max-grade', 'stat-over8',
                 'stat-over12', 'stat-reversals'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
    const tbody = document.getElementById('segment-table-body');
    if (tbody) tbody.innerHTML = '';
  }

  return { updateStats, updateSegmentTable, clear };
})();
