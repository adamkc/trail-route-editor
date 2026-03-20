# Trail Editor

Interactive web-based tool for viewing and editing trail GPS data with elevation profiles, slope analysis, route optimization, and vertex editing.

## Quick Start

### Windows
Double-click **`start.bat`** — it auto-detects Python (checks QGIS installations first, then system Python).

To use a specific Python path, edit `start.bat` and uncomment the two lines near the top:
```bat
set "PYTHON=C:\Your\Path\To\python.exe"
goto :found
```

### Mac / Linux
```bash
chmod +x start.sh
./start.sh
```

The app opens at [http://localhost:8080](http://localhost:8080). If that port is busy, it auto-increments (8081, 8082, ...).

## Requirements

### Required
- **Python 3.8+** — comes bundled with QGIS, or install from [python.org](https://www.python.org/downloads/)

### Optional (for .gpkg file support)
- **GDAL/OGR tools** (`ogrinfo`, `ogr2ogr`) — needed only if you want to load GeoPackage files
  - **Windows:** Install [QGIS](https://qgis.org) (includes GDAL) or [OSGeo4W](https://trac.osgeo.org/osgeo4w/)
  - **macOS:** `brew install gdal`
  - **Linux:** `sudo apt install gdal-bin`

Without GDAL, you can still load `.geojson` files directly.

## Features

### Map & Basemap
- **Dynamic hillshade** rendered from the DEM via MapLibre's native hillshade layer (replaces static PNG)
- **Contour lines** at 2m (faint) and 10m intervals, auto-generated from the DEM
- **3D terrain** — right-click and drag to tilt the map; elevation is exaggerated from the DEM
- **Satellite toggle** — switch between hillshade and satellite basemap
- **Slope-colored trail segments** — when a trail is selected, segments are colored by grade:
  - **Uphill:** green (near 0%) through yellow to red (steep climb)
  - **Downhill:** blue-green (near 0%) through blue to bright magenta (steep descent)

### Trail Editing
- **Vertex dragging** — click and drag vertices to reshape a trail
- **Add vertices** — right-click a trail segment to insert a new vertex
- **Delete vertices** — right-click a vertex to remove it
- **Undo/Redo** — Ctrl+Z / Ctrl+Y for edit history
- **Nameless trail support** — trails without a `Name` property are auto-assigned names (e.g., "Trail 1", "Trail 2")

### Freeze Vertices
Freeze specific vertices so they stay fixed during optimization:
- **Shift+click** a vertex to toggle freeze on/off (shown as blue circles)
- **Shift+click two vertices** to freeze the entire range between them
- **Freeze Flat button** — auto-freezes vertices on segments below a grade threshold (e.g., road sections)
- **Clear Frozen button** — unfreeze all vertices on the selected trail

### Route Optimizer
Spring-mass physics simulation that reshapes a trail to meet a target grade:
- **Target Grade** — the average grade the trail aims for (default 7%)
- **Max Segment Grade** — hard cap on individual segment steepness (default 12%). The optimizer actively pushes vertices sideways along contours to prevent any segment from exceeding this limit.
- **Live animation** — watch the trail snake into shape on the map in real-time
- **Creates a new trail** — the optimized result is added as "TrailName - Optimized" for side-by-side comparison
- **Frozen vertices respected** — pinned sections (roads, fixed segments) stay in place; target elevations are computed piecewise between frozen anchor points

#### Advanced Optimizer Parameters
Hidden behind a collapsible panel ("Warning: instability and explosions ahead"):
- Vertex Spacing, Max Drift, Step Size
- Elevation Force, Attraction, Smoothing, Repulsion
- Slope Cap Force — controls how aggressively the max grade limit is enforced
- Min Separation, Max Iterations

### Charts & Stats
- **Elevation profile** and **slope graph** span the full width of the bottom panel
- **Click on charts** to zoom the map to that location
- **Stats panel** — total length, elevation gain/loss, average grade, max grade
- **Resizable bottom panel** — drag the top edge to make it taller or shorter

### Help Panel
A quick-reference guide is shown in the bottom-right corner with all keyboard shortcuts and mouse interactions.

### Caching
- **Contour cache** — generated contours are saved to `cache/` on the server; subsequent loads with the same DEM skip regeneration
- Cache persists between app restarts

### Export
- Export edited trails as GeoJSON

## Controls Reference

| Action | How |
|--------|-----|
| Pan map | Click and drag |
| Zoom | Scroll wheel |
| Tilt map (3D) | Right-click and drag |
| Move vertex | Click and drag a vertex circle |
| Add vertex | Right-click on a trail segment |
| Delete vertex | Right-click on a vertex |
| Freeze/unfreeze vertex | Shift+click a vertex |
| Freeze range | Shift+click vertex A, then Shift+click vertex B |
| Undo | Ctrl+Z |
| Redo | Ctrl+Y |
| Zoom to chart location | Click on the elevation or slope graph |

## Data Files

The `data/` folder contains sample data. You can also load files from anywhere in the project directory tree — the file browser scans all subfolders.

| File | Description |
|------|-------------|
| `data/trails.geojson` | Default trail geometries |
| `data/dem_cropped.tif` | Digital elevation model |
| `data/hillshade_bounds.json` | Geographic bounds for initial map centering |

## Project Structure

```
web-editor/
  index.html              Main page
  style.css               Styles
  serve.py                Python HTTP server with API endpoints
  start.bat               Windows launcher (auto-detects Python)
  start.sh                Mac/Linux launcher
  js/
    app.js                Main application logic, file loading, chart wiring
    map.js                MapLibre map setup, layers, 3D terrain, hillshade
    vertex-editor.js      Vertex drag/add/delete, freeze system, undo/redo
    spring-mass.js        Spring-mass route optimizer (ported from R)
    optimizer-ui.js       Optimizer modal dialog and parameter controls
    dem-sampler.js        GeoTIFF DEM loading and elevation sampling
    contour-generator.js  Marching-squares contour line generation
    projection.js         UTM/WGS84 coordinate projection
    export.js             GeoJSON export
  data/                   Sample trail and DEM data
  cache/                  Auto-generated contour cache (created on first run)
```

## Troubleshooting

- **Port in use:** The server auto-tries ports 8080-8089. Or specify one: `python serve.py 9000`
- **GPKG files not loading:** Install GDAL tools (see Requirements above)
- **Blank map:** Make sure a DEM is loaded — the hillshade is rendered dynamically from the DEM
- **Optimizer explodes:** Try reducing Step Size, or increase Max Iterations. The retry system automatically attempts smaller step sizes on failure.
- **Dark hillshade:** The native hillshade requires the DEM to be loaded first. Check that a `.tif` file is selected in the DEM dropdown.
