/**
 * stats-panel.js — Comparison table of stats across all trails
 */
const StatsPanel = (() => {
  // Store metrics for all trails so the comparison table can be rebuilt
  let allMetrics = {}; // { trailName: summary }
  let selectedTrail = null;

  const STAT_ROWS = [
    { key: 'length_m',          label: 'Length',          fmt: v => `${v.toFixed(0)} m` },
    { key: 'elev_min_m',        label: 'Elev Min',        fmt: v => `${v.toFixed(1)} m` },
    { key: 'elev_max_m',        label: 'Elev Max',        fmt: v => `${v.toFixed(1)} m` },
    { key: 'elev_gain_m',       label: 'Gain',            fmt: v => `${v.toFixed(1)} m` },
    { key: 'elev_loss_m',       label: 'Loss',            fmt: v => `${v.toFixed(1)} m` },
    { key: 'avg_grade_pct',     label: 'Avg Grade',       fmt: v => `${v.toFixed(1)}%` },
    { key: 'max_grade_pct',     label: 'Max Grade',       fmt: v => `${v.toFixed(1)}%` },
    { key: 'pct_over_8',        label: '>8%',             fmt: v => `${v.toFixed(1)}%` },
    { key: 'pct_over_12',       label: '>12%',            fmt: v => `${v.toFixed(1)}%` },
    { key: 'reversals_per_100m',label: 'Reversals/100m',  fmt: v => `${v.toFixed(1)}` }
  ];

  function updateStats(summary, trailName) {
    if (trailName) {
      allMetrics[trailName] = summary;
      selectedTrail = trailName;
    }
    rebuildTable();
  }

  function rebuildTable() {
    const panel = document.getElementById('stats-panel');
    if (!panel) return;

    const names = Object.keys(allMetrics);
    if (names.length === 0) {
      panel.innerHTML = '<p style="color:#888;padding:10px;">No trail data</p>';
      return;
    }

    // Build comparison table: rows = stats, columns = trails
    let html = '<div style="overflow-x:auto;overflow-y:auto;flex:1;">';
    html += '<table class="stats-comparison-table"><thead><tr>';
    html += '<th class="stats-metric-col">Metric</th>';
    for (const name of names) {
      const isSelected = name === selectedTrail;
      const cls = isSelected ? ' class="stats-selected-col"' : '';
      // Truncate long names
      const shortName = name.length > 18 ? name.slice(0, 16) + '...' : name;
      html += `<th${cls} title="${name}">${shortName}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const row of STAT_ROWS) {
      html += '<tr>';
      html += `<td class="stats-metric-col">${row.label}</td>`;
      for (const name of names) {
        const summary = allMetrics[name];
        const val = summary[row.key];
        const isSelected = name === selectedTrail;
        const cls = isSelected ? ' class="stats-selected-col"' : '';
        html += `<td${cls}>${val != null ? row.fmt(val) : '—'}</td>`;
      }
      html += '</tr>';
    }

    html += '</tbody></table></div>';
    panel.innerHTML = html;
  }

  // Legacy compatibility — still called but now we use the comparison table
  function updateSegmentTable(segments) {
    // No-op — segment table removed in favor of comparison table
  }

  function removeTrail(trailName) {
    delete allMetrics[trailName];
    rebuildTable();
  }

  function clear() {
    // Don't clear allMetrics — just deselect
    selectedTrail = null;
    rebuildTable();
  }

  function clearAll() {
    allMetrics = {};
    selectedTrail = null;
    const panel = document.getElementById('stats-panel');
    if (panel) panel.innerHTML = '';
  }

  return { updateStats, updateSegmentTable, clear, clearAll, removeTrail };
})();
