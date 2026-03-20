/**
 * optimizer-ui.js — UI for the spring-mass trail optimizer
 */
const OptimizerUI = (() => {

  let abortFlag = false;
  let running = false;

  // Persist last-used parameter values between sessions
  const lastParams = {};

  // Default values (must match paramRow defaults below)
  const PARAM_DEFAULTS = {
    targetGrade: 7,
    vertexSpacing: 10,
    maxDrift: 200,
    stepSize: 0.3,
    wElev: 7.0,
    wAttract: 2.0,
    wSmooth: 1.5,
    wRepel: 0.5,
    minSeparation: 40,
    maxIter: 2000,
    maxGrade: 15,
    gradeWindow: 40,
    gradePasses: 30,
    gradeStepSize: 0.4
  };

  function show(trailName, trailCoords, trailElevs, metrics) {
    if (running) return;

    const elevChange = Math.abs(trailElevs[trailElevs.length - 1] - trailElevs[0]);
    const origLen = metrics && metrics.summary ? metrics.summary.length_m : 0;
    const origGrade = origLen > 0 ? (elevChange / origLen * 100).toFixed(1) : '?';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay optimizer-modal-overlay';
    overlay.id = 'optimizer-modal-overlay';

    overlay.innerHTML = `
      <div class="modal optimizer-modal">
        <div class="modal-header">
          <h3>Optimize Route — ${trailName}</h3>
          <button class="modal-close-btn" id="opt-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="opt-summary">
            <span>Length: <b>${origLen.toFixed(0)}m</b></span>
            <span>Elev change: <b>${elevChange.toFixed(0)}m</b></span>
            <span>Current grade: <b>${origGrade}%</b></span>
          </div>

          <div class="opt-param-row opt-target-row">
            <label for="opt-targetGrade">Target Grade</label>
            <input type="range" id="opt-targetGrade" min="3" max="15" step="0.5" value="${lastParams.targetGrade || 7}">
            <span class="opt-val" id="opt-targetGrade-val">${lastParams.targetGrade || 7}%</span>
          </div>

          <div class="opt-freeze-section">
            <div class="opt-freeze-row">
              <span class="opt-freeze-label">Frozen vertices: <b id="opt-frozen-count">${VertexEditor.getFrozenCount(trailName)}</b></span>
              <button id="opt-freeze-flat" class="opt-btn opt-btn-sm" title="Freeze vertices where both adjacent segments have grade below threshold">Freeze Flat (&lt;5%)</button>
              <button id="opt-clear-frozen" class="opt-btn opt-btn-sm">Clear Frozen</button>
            </div>
            <div class="opt-freeze-hint">Shift+click to freeze/unfreeze individual vertices. Ctrl+Shift+click two vertices to freeze a range.</div>
          </div>

          <details class="opt-advanced">
            <summary>Phase 1 Advanced Parameters</summary>
            <div class="opt-param-grid">

              <div class="opt-group-header">Forces</div>
              ${paramRow('wElev', 'Elevation', 1, 20, 0.5, 7.0, '',
                'How strongly vertices are pushed toward their target elevation. Higher = more aggressive contouring, but can cause oscillation.')}
              ${paramRow('wAttract', 'Attraction', 0.5, 10, 0.5, 2.0, '',
                'Spring force pulling adjacent vertices together. Controls segment length uniformity. Scales dynamically with trail length ratio.')}
              ${paramRow('wSmooth', 'Smoothing', 0, 5, 0.5, 1.5, '',
                'Laplacian force pulling each vertex toward the midpoint of its neighbors. Reduces zigzag patterns and sharp corners.')}
              ${paramRow('wRepel', 'Repulsion', 0, 3, 0.1, 0.5, '',
                'Push force between non-adjacent segments. Prevents the trail from crossing over itself or bunching up in switchbacks.')}

              <div class="opt-group-header">Geometry</div>
              ${paramRow('vertexSpacing', 'Vertex Spacing', 2, 20, 1, 10, 'm',
                'Distance between densified vertices. Smaller = more vertices and finer control, but slower. 5-10m works for most trails.')}
              ${paramRow('maxDrift', 'Max Drift', 50, 500, 10, 200, 'm',
                'Maximum distance any vertex can move from its original position. Acts as a corridor constraint to keep the trail near its original alignment.')}
              ${paramRow('minSeparation', 'Min Separation', 10, 100, 5, 40, 'm',
                'Minimum allowed distance between non-adjacent segments. Prevents switchback legs from getting too close together.')}

              <div class="opt-group-header">Solver</div>
              ${paramRow('stepSize', 'Step Size', 0.05, 1.0, 0.05, 0.3, '',
                'How far vertices move each iteration. Larger = faster convergence but risk of instability/explosion. Reduce if the trail explodes.')}
              ${paramRow('maxIter', 'Max Iterations', 100, 5000, 100, 2000, '',
                'Maximum solver iterations before stopping. More iterations allow better convergence but take longer. The solver stops early if energy stabilizes.')}

              <div style="text-align:right; margin-top:6px;">
                <button id="opt-reset-defaults" class="opt-btn opt-btn-sm">Reset Defaults</button>
              </div>
            </div>
          </details>

          <div class="opt-progress hidden" id="opt-progress">
            <div class="opt-progress-bar"><div class="opt-progress-fill" id="opt-progress-fill"></div></div>
            <div class="opt-progress-text" id="opt-progress-text"></div>
          </div>

          <div class="opt-actions">
            <button id="opt-run" class="opt-btn opt-btn-primary">Phase 1: Shape</button>
            <button id="opt-phase2" class="opt-btn opt-btn-secondary" disabled title="Run after Phase 1 to smooth steep segments">Phase 2: Smooth Grades</button>
            <button id="opt-cancel" class="opt-btn">Cancel</button>
          </div>

          <details class="opt-phase2-params">
            <summary>Phase 2 Settings</summary>
            <div class="opt-param-grid">
              ${paramRow('maxGrade', 'Target Max Grade', 5, 30, 1, 15, '%',
                'Maximum grade allowed for any sustained section. Segments exceeding this will be redistributed. Per-segment spikes at switchbacks are tolerated via the rolling window.')}
              ${paramRow('gradeWindow', 'Window Length', 10, 100, 5, 40, 'm',
                'Rolling average window. Grade is measured over this distance, not per-segment. Allows short spikes at switchbacks while capping sustained grade.')}
              ${paramRow('gradePasses', 'Passes', 1, 60, 1, 30, '',
                'Number of redistribution passes. More passes = smoother result but diminishing returns.')}
              ${paramRow('gradeStepSize', 'Step Size', 0.05, 1.0, 0.05, 0.4, '',
                'How far vertices move per pass. Smaller = gentler adjustments that preserve trail shape. Use 0.1-0.2 with many passes for fine-tuning, 0.4+ for aggressive correction.')}
            </div>
          </details>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Wire slider value displays
    overlay.querySelectorAll('input[type="range"]').forEach(input => {
      const valSpan = overlay.querySelector(`#${input.id}-val`);
      if (valSpan) {
        input.addEventListener('input', () => {
          const suffix = input.dataset.unit || '';
          valSpan.textContent = input.value + suffix;
        });
      }
    });

    // Close
    overlay.querySelector('#opt-close').addEventListener('click', () => close(overlay));
    overlay.querySelector('#opt-cancel').addEventListener('click', () => {
      if (running) {
        abortFlag = true;
      } else {
        close(overlay);
      }
    });

    // Freeze flat segments button
    const frozenCountEl = overlay.querySelector('#opt-frozen-count');
    overlay.querySelector('#opt-freeze-flat').addEventListener('click', () => {
      const count = VertexEditor.freezeByGrade(trailName, 5);
      frozenCountEl.textContent = VertexEditor.getFrozenCount(trailName);
      if (count > 0) {
        frozenCountEl.style.color = '#2196F3';
      }
    });

    // Clear frozen button
    overlay.querySelector('#opt-clear-frozen').addEventListener('click', () => {
      VertexEditor.clearFrozen(trailName);
      frozenCountEl.textContent = '0';
      frozenCountEl.style.color = '';
    });

    // Reset defaults button
    overlay.querySelector('#opt-reset-defaults').addEventListener('click', () => {
      Object.keys(PARAM_DEFAULTS).forEach(k => {
        const el = overlay.querySelector(`#opt-${k}`);
        if (el) {
          el.value = PARAM_DEFAULTS[k];
          const valSpan = overlay.querySelector(`#opt-${k}-val`);
          if (valSpan) valSpan.textContent = PARAM_DEFAULTS[k] + (el.dataset.unit || '');
        }
      });
      // Clear persisted params
      Object.keys(lastParams).forEach(k => delete lastParams[k]);
    });

    // Phase 1: Run shape optimizer
    overlay.querySelector('#opt-run').addEventListener('click', () => {
      runOptimizer(overlay, trailName, trailCoords, trailElevs);
    });

    // Phase 2: Smooth grades (enabled after Phase 1 completes)
    overlay.querySelector('#opt-phase2').addEventListener('click', () => {
      runPhase2(overlay, trailName);
    });
  }

  function paramRow(id, label, min, max, step, defaultVal, unit, tooltip) {
    const val = lastParams[id] != null ? lastParams[id] : defaultVal;
    const tipAttr = tooltip ? ` title="${tooltip}"` : '';
    return `
      <div class="opt-param-row"${tipAttr}>
        <label for="opt-${id}">${label}${tooltip ? ' <span class="opt-tip">?</span>' : ''}</label>
        <input type="range" id="opt-${id}" min="${min}" max="${max}" step="${step}" value="${val}" data-unit="${unit}">
        <span class="opt-val" id="opt-${id}-val">${val}${unit}</span>
      </div>
    `;
  }

  function close(overlay) {
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    running = false;
    abortFlag = false;
  }

  async function runOptimizer(overlay, trailName, origCoords, origElevs) {
    running = true;
    abortFlag = false;

    const runBtn = overlay.querySelector('#opt-run');
    const cancelBtn = overlay.querySelector('#opt-cancel');
    const progressDiv = overlay.querySelector('#opt-progress');
    const progressFill = overlay.querySelector('#opt-progress-fill');
    const progressText = overlay.querySelector('#opt-progress-text');

    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    cancelBtn.textContent = 'Abort';
    progressDiv.classList.remove('hidden');

    // Read params from sliders (maxGrade is Phase 2 only, not sent to Phase 1)
    const readParam = (id) => parseFloat(overlay.querySelector(`#opt-${id}`).value);
    const params = {
      targetGrade:   readParam('targetGrade') / 100,
      vertexSpacing: readParam('vertexSpacing'),
      maxDrift:      readParam('maxDrift'),
      stepSize:      readParam('stepSize'),
      wElev:         readParam('wElev'),
      wAttract:      readParam('wAttract'),
      wSmooth:       readParam('wSmooth'),
      wRepel:        readParam('wRepel'),
      minSeparation: readParam('minSeparation'),
      maxIter:       readParam('maxIter')
    };

    // Persist all slider values for next time the modal opens
    const paramKeys = ['targetGrade','vertexSpacing','maxDrift','stepSize',
                       'wElev','wAttract','wSmooth','wRepel','minSeparation','maxIter',
                       'maxGrade','gradeWindow','gradePasses'];
    paramKeys.forEach(k => {
      const el = overlay.querySelector(`#opt-${k}`);
      if (el) lastParams[k] = parseFloat(el.value);
    });

    // Save original state for undo / abort revert
    const savedCoords = origCoords.map(c => [...c]);
    const savedElevs = [...origElevs];

    // Create a temporary "preview" trail for live animation
    // Remove any existing optimized trail first (from a previous "Run Again")
    const previewName = trailName + ' - Optimized';
    VertexEditor.removeTrailFeature(previewName);
    VertexEditor.addTrailFeature(previewName, savedCoords.map(c => [...c]));
    // Immediately select and highlight the new preview trail
    VertexEditor.selectTrail(previewName);
    TrailMap.highlightTrail(previewName);

    const callbacks = {
      onProgress(iter, total, mse, grade, length, maxSegGrade) {
        const pct = Math.min(100, (iter / total) * 100);
        progressFill.style.width = pct + '%';
        const maxGStr = maxSegGrade != null ? ` | max seg: ${(maxSegGrade * 100).toFixed(1)}%` : '';
        progressText.textContent =
          `iter ${iter}/${total} | MSE: ${mse.toFixed(1)} | grade: ${(grade * 100).toFixed(1)}% | length: ${length.toFixed(0)}m${maxGStr}`;
      },
      onFrame(wgs84Coords) {
        // Live-update the preview trail on the map
        VertexEditor.setTrailCoordsLive(previewName, wgs84Coords);
      },
      shouldAbort() {
        return abortFlag;
      }
    };

    // Get frozen flags for this trail
    const frozenArray = VertexEditor.getFrozenArray(trailName);

    try {
      const result = await SpringMass.optimize(origCoords, origElevs, params, callbacks, frozenArray);

      if (result.aborted) {
        // Remove the preview trail
        VertexEditor.removeTrailFeature(previewName);
        progressText.textContent = 'Aborted — preview removed';
      } else {
        // Finalize the optimized trail with proper coords + elevations
        VertexEditor.setTrailCoords(previewName, result.coords, result.elevations, false);
        // Notify app to update selector
        if (window._onOptimizerDone) window._onOptimizerDone(previewName);
        const s = result.stats;
        progressText.textContent =
          `Done: ${(s.grade * 100).toFixed(1)}% grade, ${s.length.toFixed(0)}m ` +
          `(was ${(s.origGrade * 100).toFixed(1)}%, ${s.origLength.toFixed(0)}m) — ${s.iterations} iterations`;
      }
    } catch (err) {
      console.error('[Optimizer]', err);
      VertexEditor.removeTrailFeature(previewName);
      progressText.textContent = 'Error: ' + err.message;
    }

    runBtn.disabled = false;
    runBtn.textContent = 'Run Again';
    cancelBtn.textContent = 'Close';
    // Enable Phase 2 button
    const phase2Btn = overlay.querySelector('#opt-phase2');
    if (phase2Btn) phase2Btn.disabled = false;
    running = false;
  }

  async function runPhase2(overlay, trailName) {
    running = true;
    abortFlag = false;

    const phase2Btn = overlay.querySelector('#opt-phase2');
    const runBtn = overlay.querySelector('#opt-run');
    const cancelBtn = overlay.querySelector('#opt-cancel');
    const progressDiv = overlay.querySelector('#opt-progress');
    const progressFill = overlay.querySelector('#opt-progress-fill');
    const progressText = overlay.querySelector('#opt-progress-text');

    phase2Btn.disabled = true;
    phase2Btn.textContent = 'Smoothing...';
    runBtn.disabled = true;
    cancelBtn.textContent = 'Abort';
    progressDiv.classList.remove('hidden');

    const readParam = (id) => {
      const el = overlay.querySelector(`#opt-${id}`);
      return el ? parseFloat(el.value) : null;
    };

    const params = {
      maxGrade:       readParam('maxGrade') / 100,
      gradeWindow:    readParam('gradeWindow'),
      gradePasses:    readParam('gradePasses'),
      gradeStepSize:  readParam('gradeStepSize')
    };

    // Persist
    ['maxGrade', 'gradeWindow', 'gradePasses', 'gradeStepSize'].forEach(k => {
      const el = overlay.querySelector(`#opt-${k}`);
      if (el) lastParams[k] = parseFloat(el.value);
    });

    // Get the optimized trail's current coords + elevations
    const optimizedName = trailName + ' - Optimized';
    const trailFeature = VertexEditor.getTrailFeature(optimizedName) || VertexEditor.getTrailFeature(trailName);
    if (!trailFeature) {
      progressText.textContent = 'Error: no trail found to smooth';
      running = false;
      phase2Btn.disabled = false;
      phase2Btn.textContent = 'Phase 2: Smooth Grades';
      runBtn.disabled = false;
      return;
    }

    const targetName = trailFeature.properties.Name || trailFeature.properties.name || optimizedName;
    const coords = trailFeature.geometry.coordinates.map(c => [c[0], c[1]]);
    const elevs = await Promise.all(coords.map(c => DemSampler.sampleAtLngLat(c[0], c[1])));

    const callbacks = {
      onProgress(pass, totalPasses, steepCount, maxSeg) {
        const pct = Math.min(100, (pass / totalPasses) * 100);
        progressFill.style.width = pct + '%';
        progressText.textContent =
          `Phase 2: pass ${pass}/${totalPasses} | ${steepCount} steep vertices | max seg: ${(maxSeg * 100).toFixed(1)}%`;
      },
      onFrame(wgs84Coords) {
        VertexEditor.setTrailCoordsLive(targetName, wgs84Coords);
      },
      shouldAbort() {
        return abortFlag;
      }
    };

    try {
      const result = await SpringMass.gradeRedistribute(coords, elevs, params, callbacks);

      // Update the trail with smoothed coords
      VertexEditor.setTrailCoords(targetName, result.coords, result.elevations, false);
      if (window._onOptimizerDone) window._onOptimizerDone(targetName);

      const s = result.stats;
      progressText.textContent =
        `Phase 2 done: max seg grade ${(s.maxSegGrade * 100).toFixed(1)}% | length: ${s.length.toFixed(0)}m`;
    } catch (err) {
      console.error('[Phase2]', err);
      progressText.textContent = 'Phase 2 error: ' + err.message;
    }

    phase2Btn.disabled = false;
    phase2Btn.textContent = 'Phase 2: Smooth Grades';
    runBtn.disabled = false;
    cancelBtn.textContent = 'Close';
    running = false;
  }

  return { show };
})();
