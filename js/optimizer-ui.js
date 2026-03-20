/**
 * optimizer-ui.js — UI for the spring-mass trail optimizer
 */
const OptimizerUI = (() => {

  let abortFlag = false;
  let running = false;

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
            <input type="range" id="opt-targetGrade" min="3" max="15" step="0.5" value="7">
            <span class="opt-val" id="opt-targetGrade-val">7%</span>
          </div>

          <div class="opt-param-row opt-target-row">
            <label for="opt-maxGrade">Max Segment Grade</label>
            <input type="range" id="opt-maxGrade" min="5" max="40" step="1" value="25">
            <span class="opt-val" id="opt-maxGrade-val">25%</span>
          </div>

          <div class="opt-freeze-section">
            <div class="opt-freeze-row">
              <span class="opt-freeze-label">Frozen vertices: <b id="opt-frozen-count">${VertexEditor.getFrozenCount(trailName)}</b></span>
              <button id="opt-freeze-flat" class="opt-btn opt-btn-sm" title="Freeze vertices where both adjacent segments have grade below threshold">Freeze Flat (&lt;5%)</button>
              <button id="opt-clear-frozen" class="opt-btn opt-btn-sm">Clear Frozen</button>
            </div>
            <div class="opt-freeze-hint">Shift+click vertices to freeze/unfreeze. Shift+click two vertices to freeze a range.</div>
          </div>

          <details class="opt-advanced">
            <summary>Advanced Parameters &mdash; &#x26A0;&#xFE0F; Warning: instability and explosions ahead</summary>
            <div class="opt-param-grid">
              ${paramRow('vertexSpacing', 'Vertex Spacing', 2, 20, 1, 10, 'm')}
              ${paramRow('maxDrift', 'Max Drift', 50, 500, 10, 200, 'm')}
              ${paramRow('stepSize', 'Step Size', 0.05, 1.0, 0.05, 0.3, '')}
              ${paramRow('wElev', 'Elevation Force', 1, 20, 0.5, 7.0, '')}
              ${paramRow('wAttract', 'Attraction', 0.5, 10, 0.5, 2.0, '')}
              ${paramRow('wSmooth', 'Smoothing', 0, 5, 0.5, 1.5, '')}
              ${paramRow('wRepel', 'Repulsion', 0, 3, 0.1, 0.5, '')}
              ${paramRow('wSlopeCap', 'Slope Cap Force', 0, 10, 0.5, 4.0, '')}
              ${paramRow('minSeparation', 'Min Separation', 10, 100, 5, 40, 'm')}
              ${paramRow('maxIter', 'Max Iterations', 100, 5000, 100, 2000, '')}
            </div>
          </details>

          <div class="opt-progress hidden" id="opt-progress">
            <div class="opt-progress-bar"><div class="opt-progress-fill" id="opt-progress-fill"></div></div>
            <div class="opt-progress-text" id="opt-progress-text"></div>
          </div>

          <div class="opt-actions">
            <button id="opt-run" class="opt-btn opt-btn-primary">Run</button>
            <button id="opt-cancel" class="opt-btn">Cancel</button>
          </div>
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

    // Run
    overlay.querySelector('#opt-run').addEventListener('click', () => {
      runOptimizer(overlay, trailName, trailCoords, trailElevs);
    });
  }

  function paramRow(id, label, min, max, step, defaultVal, unit) {
    return `
      <div class="opt-param-row">
        <label for="opt-${id}">${label}</label>
        <input type="range" id="opt-${id}" min="${min}" max="${max}" step="${step}" value="${defaultVal}" data-unit="${unit}">
        <span class="opt-val" id="opt-${id}-val">${defaultVal}${unit}</span>
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

    // Read params from sliders
    const readParam = (id) => parseFloat(overlay.querySelector(`#opt-${id}`).value);
    const params = {
      targetGrade:   readParam('targetGrade') / 100,
      maxGrade:      readParam('maxGrade') / 100,
      vertexSpacing: readParam('vertexSpacing'),
      maxDrift:      readParam('maxDrift'),
      stepSize:      readParam('stepSize'),
      wElev:         readParam('wElev'),
      wAttract:      readParam('wAttract'),
      wSmooth:       readParam('wSmooth'),
      wRepel:        readParam('wRepel'),
      wSlopeCap:     readParam('wSlopeCap'),
      minSeparation: readParam('minSeparation'),
      maxIter:       readParam('maxIter')
    };

    // Save original state for undo / abort revert
    const savedCoords = origCoords.map(c => [...c]);
    const savedElevs = [...origElevs];

    // Create a temporary "preview" trail for live animation
    const previewName = trailName + ' - Optimized';
    VertexEditor.addTrailFeature(previewName, savedCoords.map(c => [...c]));

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
    running = false;
  }

  return { show };
})();
