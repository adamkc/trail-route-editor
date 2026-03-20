/**
 * comparison-chart.js — Overlay original + optimized elevation profiles
 */
const ComparisonChart = (() => {
  let chart = null;
  let onHoverCallback = null;
  let onClickCallback = null;
  let currentOrigSegments = [];
  let currentOrigCoords = [];

  const crosshairPlugin = {
    id: 'crosshairComparison',
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
    onClickCallback = clickCb;

    function handleHover(evt, elements, chart) {
      if (!onHoverCallback || elements.length === 0) return;
      const dist = elements[0].element.$context.parsed.x;
      const coord = coordAtDistance(dist);
      if (coord) onHoverCallback(coord);
    }

    function handleClick(evt, elements, chart) {
      if (!onClickCallback || elements.length === 0) return;
      const dist = elements[0].element.$context.parsed.x;
      const coord = coordAtDistance(dist);
      if (coord) onClickCallback(coord);
    }

    const ctx = document.getElementById('comparison-chart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'scatter',
      plugins: [crosshairPlugin],
      data: {
        datasets: [
          {
            label: 'Original',
            data: [],
            borderColor: 'rgba(78, 205, 196, 0.6)',
            backgroundColor: 'rgba(78, 205, 196, 0.08)',
            fill: true,
            showLine: true,
            borderWidth: 1.5,
            borderDash: [5, 3],
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.3
          },
          {
            label: 'Optimized',
            data: [],
            borderColor: '#e94560',
            backgroundColor: 'rgba(233, 69, 96, 0.08)',
            fill: true,
            showLine: true,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: { mode: 'index', intersect: false },
        onHover: handleHover,
        onClick: handleClick,
        plugins: {
          legend: {
            display: true,
            labels: { color: '#aaa', font: { size: 11 }, boxWidth: 20 }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) : '?'}m`
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            ticks: { color: '#888', font: { size: 10 } },
            grid: { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: 'Distance (m)', color: '#888', font: { size: 10 } }
          },
          y: {
            ticks: { color: '#888', font: { size: 10 } },
            grid: { color: 'rgba(255,255,255,0.08)' },
            title: { display: true, text: 'Elevation (m)', color: '#888', font: { size: 10 } }
          }
        }
      }
    });

    chart.canvas.addEventListener('mouseleave', () => {
      if (onHoverCallback) onHoverCallback(null);
    });
  }

  function coordAtDistance(targetDist) {
    if (currentOrigSegments.length === 0 || currentOrigCoords.length < 2) return null;
    for (const seg of currentOrigSegments) {
      if (targetDist <= seg.distEnd || seg === currentOrigSegments[currentOrigSegments.length - 1]) {
        const segFrac = seg.length > 0
          ? Math.max(0, Math.min(1, (targetDist - seg.distStart) / seg.length))
          : 0;
        const i = seg.index;
        if (i + 1 >= currentOrigCoords.length) return currentOrigCoords[currentOrigCoords.length - 1];
        const c0 = currentOrigCoords[i];
        const c1 = currentOrigCoords[i + 1];
        return [
          c0[0] + (c1[0] - c0[0]) * segFrac,
          c0[1] + (c1[1] - c0[1]) * segFrac
        ];
      }
    }
    return null;
  }

  function update(origSegments, origCoords, optSegments, optCoords) {
    if (!chart) return;
    currentOrigSegments = origSegments;
    currentOrigCoords = origCoords;

    // Original elevation: {x: distance, y: elevation}
    const origData = [];
    if (origSegments.length > 0) {
      origData.push({ x: 0, y: origSegments[0].elevStart });
      for (const seg of origSegments) {
        origData.push({ x: seg.distEnd, y: seg.elevEnd });
      }
    }

    // Optimized elevation: {x: distance, y: elevation}
    const optData = [];
    if (optSegments.length > 0) {
      optData.push({ x: 0, y: optSegments[0].elevStart });
      for (const seg of optSegments) {
        optData.push({ x: seg.distEnd, y: seg.elevEnd });
      }
    }

    chart.data.datasets[0].data = origData;
    chart.data.datasets[1].data = optData;
    chart.update('none');
  }

  function clear() {
    if (!chart) return;
    currentOrigSegments = [];
    currentOrigCoords = [];
    chart.data.datasets[0].data = [];
    chart.data.datasets[1].data = [];
    chart.update('none');
  }

  function resize() {
    if (chart) chart.resize();
  }

  return { init, update, clear, resize };
})();
