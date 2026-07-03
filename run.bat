@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "BASEPY="
where python >nul 2>nul && set "BASEPY=python"
if not defined BASEPY ( where py >nul 2>nul && set "BASEPY=py" )
if not defined BASEPY (
  echo Python 3.10+ was not found on PATH. Please install Python and try again.
  pause & exit /b 1
)

echo === AIVideoBuilder: first-run setup check (this can take a while the first time) ===
"%BASEPY%" backend\bootstrap.py
if errorlevel 1 (
  echo.
  echo Setup failed. See the messages above.
  pause & exit /b 1
)

set "ENGINEPY=%BASEPY%"
if exist engine\python_path.txt set /p ENGINEPY=<engine\python_path.txt

echo === Launching AIVideoBuilder ===
"%ENGINEPY%" backend\launcher.py

endlocal
