/**
 * file-picker.js — Dual-mode file picker
 *
 * Server mode:  Uses /api/ endpoints to list and load project files (GPKG + GeoJSON + DEM)
 * Serverless mode:  Uses browser <input type="file"> for direct file selection
 *
 * Auto-detects which mode to use by probing /api/trails on first call.
 */
const FilePicker = (() => {
  const overlay = () => document.getElementById('modal-overlay');
  const title = () => document.getElementById('modal-title');
  const body = () => document.getElementById('modal-body');
  let initialized = false;
  let serverAvailable = null; // null = unknown, true/false after probe

  function ensureInit() {
    if (initialized) return;
    initialized = true;
    const closeBtn = document.getElementById('modal-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const ov = overlay();
    if (ov) {
      ov.addEventListener('click', (e) => {
        if (e.target === ov) close();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  function open(titleText) {
    ensureInit();
    title().textContent = titleText;
    body().innerHTML = '<div class="loading-spinner">Loading...</div>';
    overlay().classList.remove('hidden');
  }

  function close() {
    overlay().classList.add('hidden');
    body().innerHTML = '';
  }

  /** Probe once to check if the local server is running */
  async function checkServer() {
    if (serverAvailable !== null) return serverAvailable;
    try {
      const resp = await fetch('/api/trails', { signal: AbortSignal.timeout(1500) });
      serverAvailable = resp.ok;
    } catch (e) {
      serverAvailable = false;
    }
    console.log('[FilePicker] Server mode:', serverAvailable ? 'available' : 'not available (using browser file input)');
    return serverAvailable;
  }

  // ═══════════════════════════════════════════════
  //  TRAIL PICKER
  // ═══════════════════════════════════════════════

  /**
   * Show trail file picker.
   * Callback signatures:
   *   Server mode:    onSelect(gpkgPath, geojsonPath, layerName)
   *   Serverless mode: onSelect(null, null, null, geojsonData)  — 4th arg is parsed GeoJSON
   */
  async function showTrailPicker(onSelect) {
    const hasServer = await checkServer();
    if (hasServer) {
      showTrailPickerServer(onSelect);
    } else {
      showTrailPickerBrowser(onSelect);
    }
  }

  // ── Server mode trail picker ──
  async function showTrailPickerServer(onSelect) {
    open('Load Trails');

    try {
      const resp = await fetch('/api/trails');
      const data = await resp.json();

      let html = '';

      // GPKG files (need layer selection)
      if (data.gpkg.length > 0) {
        html += '<div class="file-group"><div class="file-group-label">GeoPackage Files</div>';
        for (const f of data.gpkg) {
          const fid = 'gpkg-' + f.path.replace(/[^a-zA-Z0-9]/g, '_');
          html += `<div class="file-item" data-type="gpkg" data-path="${f.path}" id="${fid}">
            <div>
              <div class="file-item-name">${f.name}</div>
              <div class="file-item-dir">${f.dir}</div>
            </div>
            <div class="file-item-meta">${f.size_mb} MB</div>
          </div>
          <div class="layer-list" id="${fid}-layers" style="display:none"></div>`;
        }
        html += '</div>';
      }

      // GeoJSON files (direct load)
      if (data.geojson.length > 0) {
        html += '<div class="file-group"><div class="file-group-label">GeoJSON Files</div>';
        for (const f of data.geojson) {
          html += `<div class="file-item" data-type="geojson" data-path="${f.path}">
            <div>
              <div class="file-item-name">${f.name}</div>
              <div class="file-item-dir">${f.dir}</div>
            </div>
            <div class="file-item-meta">${f.size_mb} MB</div>
          </div>`;
        }
        html += '</div>';
      }

      // KML files (convert to GeoJSON on load)
      if (data.kml && data.kml.length > 0) {
        html += '<div class="file-group"><div class="file-group-label">KML Files</div>';
        for (const f of data.kml) {
          html += `<div class="file-item" data-type="kml" data-path="${f.path}">
            <div>
              <div class="file-item-name">${f.name}</div>
              <div class="file-item-dir">${f.dir}</div>
            </div>
            <div class="file-item-meta">${f.size_mb} MB</div>
          </div>`;
        }
        html += '</div>';
      }

      body().innerHTML = html;

      // Wire up click handlers
      body().querySelectorAll('.file-item').forEach(el => {
        el.addEventListener('click', async () => {
          const type = el.dataset.type;
          const path = el.dataset.path;

          if (type === 'kml') {
            // Fetch KML, convert to GeoJSON client-side, pass as direct data
            try {
              el.style.opacity = '0.5';
              const resp = await fetch('/api/file?path=' + encodeURIComponent(path));
              const text = await resp.text();
              const geojson = KmlUtils.kmlToGeoJSON(text);
              console.log(`[KML] Converted ${path}: ${geojson.features.length} features`);
              close();
              onSelect(null, null, null, geojson);
            } catch (err) {
              el.style.opacity = '1';
              alert('Failed to load KML: ' + err.message);
            }
          } else if (type === 'geojson') {
            close();
            onSelect(null, path, null);
          } else if (type === 'gpkg') {
            const layerDiv = document.getElementById(el.id + '-layers');
            if (layerDiv.style.display !== 'none') {
              layerDiv.style.display = 'none';
              return;
            }
            layerDiv.style.display = 'block';
            layerDiv.innerHTML = '<div class="loading-spinner">Loading layers...</div>';

            const resp = await fetch('/api/gpkg-layers?path=' + encodeURIComponent(path));
            const layerData = await resp.json();

            if (layerData.layers.length === 0) {
              layerDiv.innerHTML = '<div class="loading-spinner">No layers found</div>';
              return;
            }

            layerDiv.innerHTML = layerData.layers.map(l =>
              `<div class="layer-item" data-gpkg="${path}" data-layer="${l.name}">
                <span class="layer-item-name">${l.name}</span>
                <span class="layer-item-type">${l.type}</span>
              </div>`
            ).join('');

            layerDiv.querySelectorAll('.layer-item').forEach(lel => {
              lel.addEventListener('click', (e) => {
                e.stopPropagation();
                close();
                onSelect(lel.dataset.gpkg, null, lel.dataset.layer);
              });
            });
          }
        });
      });

    } catch (err) {
      body().innerHTML = '<div class="loading-spinner">Error: ' + err.message + '</div>';
    }
  }

  // ── Serverless mode trail picker (browser file input) ──
  function showTrailPickerBrowser(onSelect) {
    open('Load Trails');
    body().innerHTML = `
      <div class="file-group">
        <div class="file-group-label">Select a trail file from your computer</div>
        <p style="color: #999; font-size: 13px; margin: 8px 0 16px;">
          Supported formats: GeoJSON (.geojson, .json) and KML (.kml)<br>
          GeoPackage (.gpkg) files require the local server.
        </p>
        <label class="file-upload-btn">
          <input type="file" accept=".geojson,.json,.kml" id="browser-trail-input" style="display:none">
          Choose Trail File
        </label>
      </div>`;

    const input = document.getElementById('browser-trail-input');
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        body().innerHTML = '<div class="loading-spinner">Reading ' + file.name + '...</div>';
        const text = await file.text();
        const ext = file.name.split('.').pop().toLowerCase();
        let data;

        if (ext === 'kml') {
          data = KmlUtils.kmlToGeoJSON(text);
          console.log(`[KML] Converted ${file.name}: ${data.features.length} features`);
        } else {
          data = JSON.parse(text);
        }

        if (!data.features || !Array.isArray(data.features)) {
          throw new Error('File does not contain valid features');
        }
        if (data.features.length === 0) {
          throw new Error('No features found in file');
        }
        close();
        onSelect(null, null, null, data);
      } catch (err) {
        body().innerHTML = '<div class="loading-spinner">Error: ' + err.message + '</div>';
      }
    });
  }

  // ═══════════════════════════════════════════════
  //  DEM PICKER
  // ═══════════════════════════════════════════════

  /**
   * Show DEM file picker.
   * Callback signatures:
   *   Server mode:    onSelect(url)         — URL string for fetch
   *   Serverless mode: onSelect(null, arrayBuffer, fileName)  — raw ArrayBuffer + name
   */
  async function showDemPicker(onSelect) {
    const hasServer = await checkServer();
    if (hasServer) {
      showDemPickerServer(onSelect);
    } else {
      showDemPickerBrowser(onSelect);
    }
  }

  // ── Server mode DEM picker ──
  async function showDemPickerServer(onSelect) {
    open('Load DEM');

    try {
      const resp = await fetch('/api/dems');
      const data = await resp.json();

      let html = '';

      if (data.dems.length > 0) {
        html += '<div class="file-group"><div class="file-group-label">DEM Rasters</div>';
        for (const f of data.dems) {
          html += `<div class="file-item" data-path="${f.path}">
            <div>
              <div class="file-item-name">${f.name}</div>
              <div class="file-item-dir">${f.dir}</div>
            </div>
            <div class="file-item-meta">${f.size_mb} MB</div>
          </div>`;
        }
        html += '</div>';
      }

      if (data.all.length > data.dems.length) {
        const others = data.all.filter(f =>
          !data.dems.find(d => d.path === f.path));
        if (others.length > 0) {
          html += '<div class="file-group"><div class="file-group-label">Other Rasters</div>';
          for (const f of others) {
            html += `<div class="file-item" data-path="${f.path}">
              <div>
                <div class="file-item-name">${f.name}</div>
                <div class="file-item-dir">${f.dir}</div>
              </div>
              <div class="file-item-meta">${f.size_mb} MB</div>
            </div>`;
          }
          html += '</div>';
        }
      }

      body().innerHTML = html;

      body().querySelectorAll('.file-item').forEach(el => {
        el.addEventListener('click', () => {
          close();
          onSelect('/api/file?path=' + encodeURIComponent(el.dataset.path));
        });
      });

    } catch (err) {
      body().innerHTML = '<div class="loading-spinner">Error: ' + err.message + '</div>';
    }
  }

  // ── Serverless mode DEM picker (browser file input) ──
  function showDemPickerBrowser(onSelect) {
    open('Load DEM');
    body().innerHTML = `
      <div class="file-group">
        <div class="file-group-label">Select a GeoTIFF DEM file from your computer</div>
        <p style="color: #999; font-size: 13px; margin: 8px 0 16px;">
          Select a .tif or .tiff elevation raster. Large files (50+ MB) may take a moment to load.
        </p>
        <label class="file-upload-btn">
          <input type="file" accept=".tif,.tiff" id="browser-dem-input" style="display:none">
          Choose GeoTIFF File
        </label>
      </div>`;

    const input = document.getElementById('browser-dem-input');
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        body().innerHTML = '<div class="loading-spinner">Reading ' + file.name +
          ' (' + (file.size / 1024 / 1024).toFixed(1) + ' MB)...</div>';
        const buffer = await file.arrayBuffer();
        close();
        // Pass ArrayBuffer as 2nd arg, filename as 3rd
        onSelect(null, buffer, file.name);
      } catch (err) {
        body().innerHTML = '<div class="loading-spinner">Error: ' + err.message + '</div>';
      }
    });
  }

  return { showTrailPicker, showDemPicker, close, checkServer };
})();
