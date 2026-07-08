# CHNMagicAI launcher (PowerShell). First run installs everything automatically.
Set-Location -Path $PSScriptRoot

$basePy = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $basePy) { $basePy = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $basePy) { Write-Error "Python 3.10+ not found on PATH."; exit 1 }

Write-Host "=== CHNMagicAI: first-run setup check ===" -ForegroundColor Cyan
& $basePy (Join-Path $PSScriptRoot "backend\bootstrap.py")
if ($LASTEXITCODE -ne 0) { Write-Error "Setup failed."; exit 1 }

$enginePy = $basePy
$pyPathFile = Join-Path $PSScriptRoot "engine\python_path.txt"
if (Test-Path $pyPathFile) { $enginePy = (Get-Content $pyPathFile -First 1).Trim() }

Write-Host "=== Launching CHNMagicAI ===" -ForegroundColor Cyan
& $enginePy (Join-Path $PSScriptRoot "backend\launcher.py")
