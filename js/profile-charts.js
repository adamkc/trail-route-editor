/**
 * profile-charts.js — Elevation and slope profile charts with map hover sync
 */
const ProfileCharts = (() => {
  let elevChart = null;
  let slopeChart = null;
  let currentSegments = [];
  let currentCoords = [];    // [lng, lat] for each vertex in the active trail
  let onHoverCallback = null; // (lngLat) => void, or null to clear
  let onClickCallback = null; // (lngLat) => void

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    interaction: {
      mode: 'index',
      intersect: false
    },
    plugins: {
      legend: { display: false },
    },
    scales: {
      x: {
        type: 'linear',
        ticks: { color: '#888', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.05)' }
      },
      y: {
        ticks: { color: '#888', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.08)' }
      }
    }
  };

  // Chart.js plugin: vertical crosshair line on hover
  const crosshairPlugin = {
    id: 'crosshair',
    afterDraw(chart) {
      if (chart.tooltip && chart.tooltip._active && chart.tooltip._active.length) {
        const x = chart.tooltip._active[0].element.x;
        const ctx = chart.ctx;
        const yAxis = chart.scales.y;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, yAxis.top);
        ctx.lineTo(x, yAxis.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(233, 69, 96, 0.5)';
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  function init(hoverCb, clickCb) {
    onHoverCallback = hoverCb;
    onClickCallback = clickCb || null;

    // Shared hover handler — reads the x value (distance) from parsed data
    function handleHover(evt, elements, chart) {
      if (!onHoverCallback) return;
      if (elements.length > 0) {
        const dist = elements[0].element.$context.parsed.x;
        const coord = coordAtDistance(dist);
        if (coord) onHoverCallback(coord);
      }
    }

    function handleClick(evt, elements, chart) {
      if (!onClickCallback) return;
      if (elements.length > 0) {
        const dist = elements[0].element.$context.parsed.x;
        const coord = coordAtDistance(dist);
        if (coord) onClickCallback(coord);
      }
    }

    function handleLeave() {
      if (onHoverCallback) onHoverCallback(null);
    }

    // Elevation profile — scatter with line (linear x-axis)
    const elevCtx = document.getElementById('elev-chart').getContext('2d');
    elevChart = new Chart(elevCtx, {
      type: 'scatter',
      plugins: [crosshairPlugin],
      data: {
        datasets: [{
          data: [],
          borderColor: '#4ecdc4',
          backgroundColor: 'rgba(78, 205, 196, 0.15)',
          fill: true,
          borderWidth: 1.5,
          showLine: true,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#e94560',
          tension: 0.3
        }]
      },
      options: {
        ...chartDefaults,
        onHover: handleHover,
        onClick: handleClick,
        scales: {
          ...chartDefaults.scales,
          x: {
            ...chartDefaults.scales.x,
            title: { display: true, text: 'Distance (m)', color: '#888', font: { size: 10 } }
          },
          y: {
            ...chartDefaults.scales.y,
            title: { display: true, text: 'Elevation (m)', color: '#888', font: { size: 10 } }
          }
        },
        plugins: {
          ...chartDefaults.plugins,
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) : '?'}m @ ${ctx.parsed.x.toFixed(0)}m`
            }
          }
        }
      }
    });

    // Register mouseleave on the canvas
    elevChart.canvas.addEventListener('mouseleave', handleLeave);

    // Slope profile — bar chart with linear x-axis
    const slopeCtx = document.getElementById('slope-chart').getContext('2d');
    // Plugin to draw * on bars that exceed ±30%
    const clippedBarPlugin = {
      id: 'clippedBars',
      afterDatasetsDraw(chart) {
        const clipped = chart._clippedBars;
        if (!clipped) return;
        const meta = chart.getDatasetMeta(0);
        const ctx = chart.ctx;
        ctx.save();
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        for (let i = 0; i < clipped.length; i++) {
          if (clipped[i] == null) continue;
          const bar = meta.data[i];
          if (!bar) continue;
          const y = clipped[i] > 0 ? bar.y - 3 : bar.y + 10;
          ctx.fillText('*', bar.x, y);
        }
        ctx.restore();
      }
    };

    slopeChart = new Chart(slopeCtx, {
      type: 'bar',
      plugins: [crosshairPlugin, clippedBarPlugin],
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: [],
          borderWidth: 0,
          barPercentage: 1.0,
          categoryPercentage: 1.0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: { mode: 'index', intersect: false },
        onHover: (evt, elements, chart) => {
          if (!onHoverCallback || elements.length === 0) return;
          const idx = elements[0].index;
          // Get distance from stored segment data
          if (idx < currentSegments.length) {
            const dist = currentSegments[idx].distStart + currentSegments[idx].length / 2;
            const coord = coordAtDistance(dist);
            if (coord) onHoverCallback(coord);
          }
        },
        onClick: (evt, elements, chart) => {
          if (!onClickCallback || elements.length === 0) return;
          const idx = elements[0].index;
          if (idx < currentSegments.length) {
            const dist = currentSegments[idx].distStart + currentSegments[idx].length / 2;
            const coord = coordAtDistance(dist);
            if (coord) onClickCallback(coord);
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                if (items.length === 0) return '';
                const idx = items[0].dataIndex;
                if (idx < currentSegments.length) {
                  return `${currentSegments[idx].distStart.toFixed(0)} – ${currentSegments[idx].distEnd.toFixed(0)} m`;
                }
                return '';
              },
              label: (ctx) => {
                const chart = ctx.chart;
                const realVal = chart._clippedBars && chart._clippedBars[ctx.dataIndex] != null
                  ? chart._clippedBars[ctx.dataIndex]
                  : ctx.parsed.y;
                return `${realVal != null ? realVal.toFixed(1) : '?'}% grade`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'category',
            ticks: { display: false, color: '#888', font: { size: 10 } },
            grid: { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: 'Distance (m)', color: '#888', font: { size: 10 } }
          },
          y: {
            min: -30,
            max: 30,
            ticks: { color: '#888', font: { size: 10 } },
            grid: { color: 'rgba(255,255,255,0.08)' },
            title: { display: true, text: 'Grade (%)', color: '#888', font: { size: 10 } }
          }
        }
      }
    });

    slopeChart.canvas.addEventListener('mouseleave', handleLeave);
  }

  /**
   * Find the [lng, lat] coordinate at a given cumulative distance along the trail.
   * Interpolates between vertices.
   */
  function coordAtDistance(targetDist) {
    if (currentSegments.length === 0 || currentCoords.length < 2) return null;

    // Walk through segments to find which one contains targetDist
    for (const seg of currentSegments) {
      if (targetDist <= seg.distEnd || seg === currentSegments[currentSegments.length - 1]) {
        // Interpolate within this segment
        const segFrac = seg.length > 0
          ? Math.max(0, Math.min(1, (targetDist - seg.distStart) / seg.length))
          : 0;
        const i = seg.index;
        if (i + 1 >= currentCoords.length) return currentCoords[currentCoords.length - 1];
        const c0 = currentCoords[i];
        const c1 = currentCoords[i + 1];
        return [
          c0[0] + (c1[0] - c0[0]) * segFrac,
          c0[1] + (c1[1] - c0[1]) * segFrac
        ];
      }
    }
    return null;
  }

  function update(segments, elevations, coords) {
    if (!elevChart || !slopeChart) return;

    currentSegments = segments;
    if (coords) currentCoords = coords;

    // Elevation profile — {x: distance, y: elevation} points
    const elevData = [];
    if (segments.length > 0) {
      elevData.push({ x: 0, y: segments[0].elevStart });
      for (const seg of segments) {
        elevData.push({ x: seg.distEnd, y: seg.elevEnd });
      }
    }
    elevChart.data.datasets[0].data = elevData;
    elevChart.update('none');

    // Slope profile — still categorical (bars need equal width visually)
    // but labels show actual distance values
    const SLOPE_CAP = 30;
    const slopeLabels = segments.map(s => Math.round(s.distStart));
    const rawSlope = segments.map(s => s.gradePct);
    const slopeData = rawSlope.map(v => Math.max(-SLOPE_CAP, Math.min(SLOPE_CAP, v)));
    const slopeColors = segments.map(s => s.gradeClass.color);
    // Track which bars are clipped so the plugin can annotate them
    slopeChart._clippedBars = rawSlope.map((v, i) => Math.abs(v) > SLOPE_CAP ? rawSlope[i] : null);
    slopeChart.data.labels = slopeLabels;
    slopeChart.data.datasets[0].data = slopeData;
    slopeChart.data.datasets[0].backgroundColor = slopeColors;
    slopeChart.update('none');
  }

  function clear() {
    currentSegments = [];
    currentCoords = [];
    if (elevChart) {
      elevChart.data.datasets[0].data = [];
      elevChart.update('none');
    }
    if (slopeChart) {
      slopeChart.data.labels = [];
      slopeChart.data.datasets[0].data = [];
      slopeChart.update('none');
    }
  }

  function resize() {
    if (elevChart) elevChart.resize();
    if (slopeChart) slopeChart.resize();
  }

  function getLastData() {
    return { segments: currentSegments, coords: currentCoords };
  }

  return { init, update, clear, resize, getLastData };
})();
