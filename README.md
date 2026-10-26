# Trail Route Editor

A browser tool for designing trails on real terrain: load or draw routes, see elevation and grade profiles, edit vertices, and run a spring-mass optimizer that reshapes a trail toward a target grade.

## Live site

**[https://adamkc.github.io/trail-route-editor/](https://adamkc.github.io/trail-route-editor/)**

Nothing to install. The site opens on a demo (the JC Trail network near Hayfork, California). Click **New** in the Project group to start empty, then bring in terrain and trails as described below. Everything runs in your browser; see [What leaves your browser](#what-leaves-your-browser).

## Getting terrain in

You need elevation data before grades, profiles, and the optimizer work. Two ways:

### Get Terrain (United States)
Click **Get Terrain** to download elevation from the USGS 3D Elevation Program for your trails (plus a 500 m buffer) or, with no trails loaded, for the area on screen. 3DEP gives 1 m lidar where it exists and about 10 m elsewhere. The dialog shows the area, a resolution choice, and the download size. USGS serves roughly 0.2 to 0.7 MB per second, so a 3 × 3 km area at 1 m takes a minute or two; 2 m is four times smaller.

### Load DEM (any GeoTIFF)
Click **Load DEM** and pick a GeoTIFF. A setup panel shows what was detected before anything is processed:

- **Coordinate system.** UTM in any zone (NAD83, NAD83(2011), WGS84) is used as-is. Lat/long DEMs (for example USGS 1/3 arc-second downloads) and other EPSG projections such as State Plane or California Albers are reprojected to UTM while processing. NAD27 and custom projections are refused, with a `gdalwarp` command to convert them.
- **Elevation units.** Read from the file when it says; otherwise assumed from the horizontal units (State Plane feet means feet). Check this: a feet DEM processed as meters makes every grade 3.28 times too steep. The app warns if the highest point comes out implausibly high.
- **Processing area.** "Around trails" processes only the area around trails that fall inside the DEM (500 m buffer), which keeps big lidar files manageable. "Full DEM" processes everything.

Large files are fine: only the header and the processed area are read from disk (a 1.1 GB, 17,000 × 15,000 lidar tile opens in under a second). Nodata cells, including USGS's -999999, are treated as gaps rather than 0 m.

If trails fall outside the processed terrain, a notice on the map lists them and outlines the processed area.

## Getting trails in

**Load Trails** reads:

- **GPX**: GPS units, phone apps (Gaia, Avenza, Strava exports), and the Trail Router mobile app
- **GeoJSON**: lat/long, or a projected CRS if the file has a `crs` member
- **KML / KMZ**: Google Earth
- **Zipped shapefile**: a `.zip` containing `.shp`, `.dbf`, and `.prj` (reprojected from the `.prj`)
- **GeoPackage**: local server only (needs GDAL)

On import, multi-part lines whose parts touch are joined; parts with gaps become separate trails ("Name (part 2)") instead of being joined by a straight jump. Polygons are skipped, duplicate names are made unique, and names are found in common attribute fields (`Name`, `TRAIL_NAME`, `title`, ...). A notice lists anything that was changed. Tick **Add to the trails already loaded** to merge files instead of replacing.

Points in an imported file become waypoints. You can also draw new routes with **New Route**.

## Saving your work

- **Autosave.** Trails, waypoints, frozen vertices, the selected trail, and the terrain in use are saved in the browser a few seconds after each change, and restored when you come back. If the terrain is still in browser storage, it comes back too.
- **Project files.** **Save** downloads a `.trailproject.json` file; **Open** loads one. Use these to move work between computers or share it. A project file references its DEM by name; if that terrain isn't in the other browser's storage, load the DEM again.
- **Exports.** GeoJSON (with elevations as Z values and per-trail length, gain/loss, and grade stats), KML, and GPX (with elevation per point). Files are named after the project.

## Features

### Map
- Hillshade, 2 m and 10 m contours, and 3D terrain generated from the DEM (right-click and drag to tilt)
- Satellite basemap toggle
- Trail segments colored by grade when a trail is selected: green through red uphill, blue-green through magenta downhill
- **Units** button switches between meters/kilometers and feet/miles for the stats, charts, tooltips, and scale bar

### Trail editing
- Drag vertices; right-click a segment to add a vertex, right-click a vertex to delete it
- Undo with Ctrl+Z (there is no redo)
- **Densify** adds evenly spaced vertices

### Freeze vertices
Frozen vertices stay fixed during optimization:
- **Shift+click** a vertex to toggle it (blue)
- **Ctrl+Shift+click** two vertices to freeze the range between them
- **Freeze Flat** (in the optimizer) freezes vertices on segments below a grade threshold, such as road sections

### Route optimizer
Spring-mass simulation that reshapes a trail toward a target grade:
- **Target Grade**: the average grade to aim for (default 7%)
- **Max Segment Grade**: cap on individual segments (default 15%), enforced in a second pass that moves vertices sideways along the contours
- Animates live on the map and adds the result as "Name - Optimized" for comparison
- Frozen vertices stay put; target elevations are interpolated between them
- Advanced parameters (vertex spacing, drift, forces, separation, iterations) sit behind a collapsible panel

### Charts and stats
- Elevation and slope profiles; click a chart to zoom the map there
- Comparison chart of original vs. optimized profiles
- Statistics table across all trails: length, elevation range, gain/loss, average and maximum grade, percent over 8% and 12%

### Storage
Processed terrain is cached in the browser so a DEM loads instantly next time. **Storage** lists the cached DEMs with their sizes and lets you delete them. If the browser's storage is full, the DEM still works for the current session and a notice says it won't be kept.

## Controls

| Action | How |
|--------|-----|
| Pan map | Click and drag |
| Zoom | Scroll wheel |
| Tilt map (3D) | Right-click and drag |
| Move vertex | Click and drag a vertex circle |
| Add vertex | Right-click on a trail segment |
| Delete vertex | Right-click on a vertex |
| Freeze/unfreeze vertex | Shift+click a vertex |
| Freeze range | Ctrl+Shift+click vertex A, then vertex B |
| Undo | Ctrl+Z |
| Zoom to chart location | Click the elevation or slope chart |

## What leaves your browser

Your trails and DEM files are never uploaded. The page does make these requests:

- **USGS** (`elevation.nationalmap.gov`): the bounding box of the area, only when you use Get Terrain
- **epsg.io**: an EPSG code, only when a DEM or GeoJSON uses a projection the app doesn't have built in (State Plane, for example); the answer is remembered in the browser
- **Esri World Imagery** tiles, only when Satellite is on
- **CDNs** for the map, chart, projection, GeoTIFF, shapefile, and zip libraries
- **GoatCounter** page-view analytics (no cookies; skipped on localhost)

## Local development (with Python server)

The local server adds GeoPackage support and lists project files in the pickers. The app detects whether a server is present and works either way.

**Windows:** double-click `start.bat` (finds Python in QGIS installs first, then system Python). To force a specific Python, edit `start.bat` and uncomment the two lines near the top.

**Mac / Linux:**
```bash
chmod +x start.sh
./start.sh
```

The app opens at http://localhost:8080 (or the next free port up to 8089).

To test exactly what the hosted site does (no server API), serve the folder statically, for example `python -m http.server 8766 --directory trail-route-editor`.

### Requirements for the local server
- Python 3.8+ (bundled with QGIS, or from python.org)
- GDAL/OGR tools (`ogrinfo`, `ogr2ogr`) for GeoPackage support only: QGIS or OSGeo4W on Windows, `brew install gdal` on macOS, `sudo apt install gdal-bin` on Linux

## Files

| Path | Contents |
|------|----------|
| `demo/demo_dem.tif` | Demo DEM: the JC Trail area at 1.5 m (8.7 MB, compressed) |
| `data/trails.geojson` | Demo trails |
| `data/` | Other sample data; the full-resolution DEMs are not in the repo |

```
trail-route-editor/
  index.html              Page and toolbar
  css/style.css           Styles
  serve.py                Optional local server (file listing, GeoPackage conversion)
  js/
    app.js                App flow: loading, projects/autosave, terrain, dialogs
    projection.js         WGS84 <-> working UTM zone (follows the DEM)
    dem-crs.js            GeoTIFF CRS/units detection, proj4 definitions, nodata
    dem-sampler.js        GeoTIFF access (lazy reads from files)
    dem-preprocessor.js   Processing pipeline: area, reprojection, tiles, cache
    dem-panel.js          DEM setup panel
    terrain-fetch.js      USGS 3DEP download
    roi-sampler.js        Elevation sampling from processed terrain
    cache-store.js        IndexedDB cache of processed terrain
    session-store.js      Autosave storage
    trail-import.js       Trail file reading and clean-up
    gpx-utils.js          GPX read/write
    kml-utils.js          KML read/write
    export.js             GeoJSON / KML / GPX export
    map.js                MapLibre map, layers, terrain, hillshade
    vertex-editor.js      Vertex editing, freezing, undo
    spring-mass.js        Spring-mass optimizer (ported from R)
    optimizer-ui.js       Optimizer dialog
    profile-charts.js     Elevation and slope charts
    comparison-chart.js   Original vs. optimized chart
    stats-panel.js        Statistics table
    trail-metrics.js      Grade, distance, and elevation computation
    units.js              Metric / US display units
    notice.js             Messages over the map
```

## Troubleshooting

- **"None of the loaded trails are inside the processed terrain."** The DEM and trails are for different places, or the processing area missed them. The dashed outline shows what was processed.
- **"Can't use this DEM."** It's NAD27 or a custom projection. Run the `gdalwarp` command shown in the panel, then load the new file.
- **Grades look about three times too steep.** The DEM is in feet but was processed as meters. Load it again, click Reprocess if asked, and pick feet.
- **Terrain isn't kept between visits.** The browser's storage is full or blocked (some private windows). Open **Storage** to free space.
- **GeoPackage files:** need the local server with GDAL. On the hosted site, export to GeoJSON or a zipped shapefile instead.
- **Optimizer explodes:** reduce Step Size or increase Max Iterations; it retries with smaller steps automatically.
- **Map stuck in 3D:** click **Recenter**.
- **Port in use (local server):** it tries 8080 to 8089, or run `python serve.py 9000`.
