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
   * Callback: onSelect(gpkgPath, geojsonPath, layerName, directData, opts)
   *   Server mode:     paths for GeoPackage / GeoJSON, or directData for KML/GPX
   *   Serverless mode: directData = parsed (not yet normalized) GeoJSON
   *   opts: { append, fileName }
   */
  async function showTrailPicker(onSelect, { hasTrails } = {}) {
    const hasServer = await checkServer();
    if (hasServer) {
      showTrailPickerServer(onSelect, hasTrails);
    } else {
      showTrailPickerBrowser(onSelect, hasTrails);
    }
  }

  function appendOptionHtml(hasTrails) {
    return hasTrails ? `
      <label class="splash-checkbox" style="margin: 0 0 12px;">
        <input type="checkbox" id="trail-append"> Add to the trails already loaded (instead of replacing them)
      </label>` : '';
  }

  function appendChecked() {
    const el = document.getElementById('trail-append');
    return !!(el && el.checked);
  }

  // ── Server mode trail picker ──
  async function showTrailPickerServer(onSelect, hasTrails) {
    open('Load Trails');

    try {
      const resp = await fetch('/api/trails');
      const data = await resp.json();

      let html = appendOptionHtml(hasTrails);

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

      // KML and GPX files (converted to GeoJSON client-side)
      for (const [key, label] of [['kml', 'KML Files'], ['gpx', 'GPX Files']]) {
        if (!data[key] || data[key].length === 0) continue;
        html += `<div class="file-group"><div class="file-group-label">${label}</div>`;
        for (const f of data[key]) {
          html += `<div class="file-item" data-type="${key}" data-path="${f.path}">
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
          const opts = { append: appendChecked(), fileName: path.split('/').pop() };

          if (type === 'kml' || type === 'gpx') {
            try {
              el.style.opacity = '0.5';
              const resp = await fetch('/api/file?path=' + encodeURIComponent(path));
              const geojson = TrailImport.parseText(await resp.text(), type);
              close();
              onSelect(null, null, null, geojson, opts);
            } catch (err) {
              el.style.opacity = '1';
              alert('Failed to load ' + type.toUpperCase() + ': ' + err.message);
            }
          } else if (type === 'geojson') {
            close();
            onSelect(null, path, null, null, opts);
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
                const opts = { append: appendChecked(), fileName: lel.dataset.layer };
                close();
                onSelect(lel.dataset.gpkg, null, lel.dataset.layer, null, opts);
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
  function showTrailPickerBrowser(onSelect, hasTrails) {
    open('Load Trails');
    body().innerHTML = `
      <div class="file-group">
        <div class="file-group-label">Select a trail file from your computer</div>
        <p style="color: #999; font-size: 13px; margin: 8px 0 16px;">
          GPX (GPS units, phone apps, Trail Router mobile), GeoJSON, KML/KMZ,
          or a zipped shapefile (.zip containing .shp, .dbf, and .prj).<br>
          GeoPackage (.gpkg) files need the local server; export them to GeoJSON instead.
        </p>
        ${appendOptionHtml(hasTrails)}
        <label class="file-upload-btn">
          <input type="file" accept="${TrailImport.ACCEPT}" id="browser-trail-input" style="display:none">
          Choose Trail File
        </label>
      </div>`;

    const input = document.getElementById('browser-trail-input');
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const opts = { append: appendChecked(), fileName: file.name };
      try {
        body().innerHTML = '<div class="loading-spinner">Reading ' + file.name + '...</div>';
        const data = await TrailImport.parseFile(file);
        close();
        onSelect(null, null, null, data, opts);
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
          html += `<div class="file-item" data-path="${f.path}" data-name="${f.name}" data-size="${f.size_mb}">
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
            html += `<div class="file-item" data-path="${f.path}" data-name="${f.name}" data-size="${f.size_mb}">
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
          const url = '/api/file?path=' + encodeURIComponent(el.dataset.path);
          const fileName = el.dataset.name || el.dataset.path.split('/').pop();
          const fileSizeBytes = parseFloat(el.dataset.size || '0') * 1024 * 1024;
          onSelect(url, null, fileName, fileSizeBytes);
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
          Select a .tif or .tiff elevation raster in UTM, lat/long, or another EPSG
          projection (State Plane, Albers, ...). Only the parts you process are read,
          so large lidar files are fine.
        </p>
        <label class="file-upload-btn">
          <input type="file" accept=".tif,.tiff" id="browser-dem-input" style="display:none">
          Choose GeoTIFF File
        </label>
      </div>`;

    const input = document.getElementById('browser-dem-input');
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      close();
      // Pass the File itself (read lazily), filename, and size
      onSelect(null, file, file.name, file.size);
    });
  }

  return { showTrailPicker, showDemPicker, close, checkServer };
})();
