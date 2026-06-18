@echo off
echo ============================================
echo   色块暴走派对
echo ============================================
echo.

where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Starting server at http://localhost:8091
    echo Press Ctrl+C to stop.
    echo.
    start http://localhost:8091
    python -m http.server 8091
    goto :end
)

where python3 >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Starting server at http://localhost:8091
    echo Press Ctrl+C to stop.
    echo.
    start http://localhost:8091
    python3 -m http.server 8091
    goto :end
)

where npx >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Starting server at http://localhost:8091
    echo Press Ctrl+C to stop.
    echo.
    start http://localhost:8091
    npx serve -l 8091
    goto :end
)

echo ERROR: No Python or Node.js found.
pause

:end
