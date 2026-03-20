@echo off
cd /d "%~dp0"

:: ── MANUAL OVERRIDE ──────────────────────────────────────────────
:: If auto-detect doesn't find your Python, uncomment these two lines
:: and set your path:
:: set "PYTHON=C:\Your\Path\To\python.exe"
:: goto :found
:: ────────────────────────────────────────────────────────────────

:: Auto-detect Python: try common QGIS locations, then system Python
set "PYTHON="

:: Check common QGIS install paths
for %%V in (3.42 3.40 3.38 3.36 3.34.15 3.34.14 3.34.13 3.34.12 3.34.11 3.34.10 3.34 3.32 3.30 3.28) do (
    if exist "C:\Program Files\QGIS %%V\apps\Python312\python.exe" (
        set "PYTHON=C:\Program Files\QGIS %%V\apps\Python312\python.exe"
        goto :found
    )
    if exist "C:\Program Files\QGIS %%V\apps\Python39\python.exe" (
        set "PYTHON=C:\Program Files\QGIS %%V\apps\Python39\python.exe"
        goto :found
    )
)

:: Check OSGeo4W
if exist "C:\OSGeo4W\apps\Python312\python.exe" (
    set "PYTHON=C:\OSGeo4W\apps\Python312\python.exe"
    goto :found
)
if exist "C:\OSGeo4W64\apps\Python312\python.exe" (
    set "PYTHON=C:\OSGeo4W64\apps\Python312\python.exe"
    goto :found
)

:: Fall back to system Python
where python >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "PYTHON=python"
    goto :found
)
where py >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "PYTHON=py"
    goto :found
)

echo.
echo ERROR: Python not found.
echo Install Python from https://www.python.org/downloads/
echo Or install QGIS which bundles Python + GDAL.
echo.
pause
exit /b 1

:found
echo Using Python: %PYTHON%
start http://localhost:8080
"%PYTHON%" serve.py
pause
