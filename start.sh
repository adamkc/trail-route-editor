#!/usr/bin/env bash
# Start the Trail Editor server (Mac/Linux)
cd "$(dirname "$0")"

# Find Python 3
if command -v python3 &>/dev/null; then
    PY=python3
elif command -v python &>/dev/null; then
    PY=python
else
    echo "ERROR: Python 3 not found."
    echo "Install it via your package manager:"
    echo "  macOS:  brew install python"
    echo "  Ubuntu: sudo apt install python3"
    exit 1
fi

echo "Using Python: $PY"

# Check for GDAL tools (optional, needed for .gpkg files)
if ! command -v ogrinfo &>/dev/null; then
    echo "WARNING: GDAL tools (ogrinfo/ogr2ogr) not found."
    echo "  .gpkg file support will be unavailable."
    echo "  Install via: brew install gdal  OR  sudo apt install gdal-bin"
    echo ""
fi

PORT=8080
echo "Opening http://localhost:$PORT"

# Try to open browser
if command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:$PORT" &
elif command -v open &>/dev/null; then
    open "http://localhost:$PORT" &
fi

$PY serve.py "$PORT"
