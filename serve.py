"""HTTP server with file discovery API and Range request support."""
import http.server
import os
import sys
import json
import subprocess

# web-editor/ is the working directory; project root is one level up
os.chdir(os.path.dirname(os.path.abspath(__file__)))
PROJECT_ROOT = os.path.abspath('..')


def find_files(root, extensions):
    """Walk project tree and return files matching extensions."""
    results = []
    for dirpath, _, filenames in os.walk(root):
        # Skip hidden dirs, web-editor/data dir, .git
        rel = os.path.relpath(dirpath, root)
        if any(p.startswith('.') for p in rel.split(os.sep)):
            continue
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext in extensions:
                full = os.path.join(dirpath, fn)
                size = os.path.getsize(full)
                results.append({
                    'name': fn,
                    'path': os.path.relpath(full, root).replace('\\', '/'),
                    'size_mb': round(size / 1024 / 1024, 1),
                    'dir': os.path.relpath(dirpath, root).replace('\\', '/')
                })
    return results


def list_gpkg_layers(gpkg_path):
    """List layers in a gpkg file using ogrinfo."""
    full = os.path.join(PROJECT_ROOT, gpkg_path)
    if not os.path.isfile(full):
        return []
    try:
        result = subprocess.run(
            ['ogrinfo', full, '-so', '-q'],
            capture_output=True, text=True, timeout=10
        )
        layers = []
        for line in result.stdout.strip().split('\n'):
            line = line.strip()
            if not line:
                continue
            # Format: "1: layername (geometry type)"
            parts = line.split(':', 1)
            if len(parts) == 2:
                name_type = parts[1].strip()
                lname = name_type.split('(')[0].strip()
                gtype = ''
                if '(' in name_type and ')' in name_type:
                    gtype = name_type.split('(')[1].split(')')[0].strip()
                layers.append({'name': lname, 'type': gtype})
        return layers
    except Exception as e:
        print("ogrinfo error: %s" % e)
        return []


def gpkg_to_geojson(gpkg_path, layer_name):
    """Convert a gpkg layer to GeoJSON string using ogr2ogr, reprojecting to WGS84."""
    full = os.path.join(PROJECT_ROOT, gpkg_path)
    if not os.path.isfile(full):
        return None
    try:
        result = subprocess.run(
            ['ogr2ogr', '-f', 'GeoJSON', '-t_srs', 'EPSG:4326',
             '/vsistdout/', full, layer_name],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout
        print("ogr2ogr stderr: %s" % result.stderr)
        return None
    except Exception as e:
        print("ogr2ogr error: %s" % e)
        return None


class TrailEditorHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler with API endpoints for file discovery."""

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
        self.send_header('Access-Control-Expose-Headers',
                         'Content-Range, Content-Length, Accept-Ranges')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        # API: write to cache
        if self.path.startswith('/api/cache?'):
            from urllib.parse import parse_qs, urlparse
            params = parse_qs(urlparse(self.path).query)
            key = params.get('key', [''])[0]
            if not key or '..' in key or '/' in key or '\\' in key:
                self.send_error(400, 'Invalid cache key')
                return
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
            os.makedirs(cache_dir, exist_ok=True)
            cache_file = os.path.join(cache_dir, key)
            with open(cache_file, 'wb') as f:
                f.write(body)
            self.send_json({'ok': True, 'key': key, 'size': len(body)})
            return
        self.send_error(404, 'Not found')

    def do_GET(self):
        # API: list trail files (gpkg + geojson + kml)
        if self.path == '/api/trails':
            gpkg_files = find_files(PROJECT_ROOT, {'.gpkg'})
            geojson_files = find_files(PROJECT_ROOT, {'.geojson'})
            kml_files = find_files(PROJECT_ROOT, {'.kml'})
            self.send_json({'gpkg': gpkg_files, 'geojson': geojson_files, 'kml': kml_files})
            return

        # API: list DEM files (tif)
        if self.path == '/api/dems':
            tif_files = find_files(PROJECT_ROOT, {'.tif', '.tiff'})
            # Filter to likely DEMs (exclude hillshade, mask, etc)
            dems = [f for f in tif_files
                    if 'hillshade' not in f['name'].lower()
                    and 'mask' not in f['name'].lower()]
            hillshades = [f for f in tif_files
                          if 'hillshade' in f['name'].lower()]
            self.send_json({'dems': dems, 'hillshades': hillshades,
                            'all': tif_files})
            return

        # API: list layers in a gpkg
        if self.path.startswith('/api/gpkg-layers?'):
            from urllib.parse import parse_qs, urlparse
            params = parse_qs(urlparse(self.path).query)
            gpkg_path = params.get('path', [''])[0]
            layers = list_gpkg_layers(gpkg_path)
            self.send_json({'layers': layers, 'path': gpkg_path})
            return

        # API: convert gpkg layer to geojson on the fly
        if self.path.startswith('/api/gpkg-geojson?'):
            from urllib.parse import parse_qs, urlparse
            params = parse_qs(urlparse(self.path).query)
            gpkg_path = params.get('path', [''])[0]
            layer = params.get('layer', [''])[0]
            geojson = gpkg_to_geojson(gpkg_path, layer)
            if geojson:
                self.send_response(200)
                self.send_header('Content-Type', 'application/geo+json')
                self.end_headers()
                self.wfile.write(geojson.encode('utf-8'))
            else:
                self.send_error(500, 'Failed to convert layer')
            return

        # API: serve a project file by relative path (for DEM loading)
        if self.path.startswith('/api/file?'):
            from urllib.parse import parse_qs, urlparse
            params = parse_qs(urlparse(self.path).query)
            file_path = params.get('path', [''])[0]
            full = os.path.normpath(os.path.join(PROJECT_ROOT, file_path))
            # Security: ensure it's within project root
            if not full.startswith(os.path.normpath(PROJECT_ROOT)):
                self.send_error(403, 'Access denied')
                return
            if not os.path.isfile(full):
                self.send_error(404, 'File not found')
                return
            # Serve the file
            size = os.path.getsize(full)
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(size))
            self.end_headers()
            with open(full, 'rb') as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            return

        # API: read from cache
        if self.path.startswith('/api/cache?'):
            from urllib.parse import parse_qs, urlparse
            params = parse_qs(urlparse(self.path).query)
            key = params.get('key', [''])[0]
            if not key or '..' in key or '/' in key or '\\' in key:
                self.send_error(400, 'Invalid cache key')
                return
            cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
            cache_file = os.path.join(cache_dir, key)
            if not os.path.isfile(cache_file):
                self.send_error(404, 'Not cached')
                return
            size = os.path.getsize(cache_file)
            self.send_response(200)
            ct = 'application/json' if key.endswith('.json') else 'application/octet-stream'
            self.send_header('Content-Type', ct)
            self.send_header('Content-Length', str(size))
            self.end_headers()
            with open(cache_file, 'rb') as f:
                self.wfile.write(f.read())
            return

        # Range request handling for static files
        range_header = self.headers.get('Range')
        if range_header:
            self.handle_range(range_header)
            return

        return super().do_GET()

    def handle_range(self, range_header):
        try:
            path = self.translate_path(self.path)
            if not os.path.isfile(path):
                self.send_error(404)
                return

            file_size = os.path.getsize(path)
            range_spec = range_header.replace('bytes=', '')
            if ',' in range_spec:
                return super().do_GET()

            parts = range_spec.split('-')
            start = int(parts[0]) if parts[0] else 0
            end = int(parts[1]) if parts[1] else file_size - 1
            end = min(end, file_size - 1)

            if start >= file_size:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % file_size)
                self.end_headers()
                return

            content_length = end - start + 1
            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Length', str(content_length))
            self.send_header('Content-Range',
                             'bytes %d-%d/%d' % (start, end, file_size))
            self.end_headers()

            with open(path, 'rb') as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except Exception as e:
            print("Range error: %s" % e)
            self.send_error(500)

    def send_json(self, data):
        body = json.dumps(data, indent=2).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Log API calls and errors, skip static file noise
        if args and self.path.startswith('/api'):
            super().log_message(format, *args)
        elif args and '404' in str(args[0]):
            super().log_message(format, *args)


if __name__ == '__main__':
    preferred = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    port = preferred
    server = None
    # Try preferred port, then increment up to 10 times
    for attempt in range(10):
        try:
            server = http.server.HTTPServer(('localhost', port), TrailEditorHandler)
            break
        except OSError:
            if attempt == 0:
                print("Port %d in use, trying next..." % port)
            port += 1
    if server is None:
        print("ERROR: Could not find an open port (%d-%d)." % (preferred, port - 1))
        sys.exit(1)
    if port != preferred:
        print("Note: Port %d was busy, using %d instead." % (preferred, port))
    print("Trail Editor server at http://localhost:%d" % port)
    print("Project root: %s" % PROJECT_ROOT)
    print("Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
