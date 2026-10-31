$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
if ($ScriptDir -and (Test-Path (Join-Path $ScriptDir "scripts\pi-install.mjs"))) {
	node (Join-Path $ScriptDir "scripts\pi-install.mjs") uninstall @args
	exit $LASTEXITCODE
}

$InstallDir = if ($env:UH_INSTALL_DIR) { $env:UH_INSTALL_DIR } else { Join-Path $HOME ".local\share\uh" }
$BinDir = if ($env:UH_BIN_DIR) { $env:UH_BIN_DIR } else { Join-Path $HOME ".local\bin" }
$Core = Join-Path $InstallDir "scripts\pi-install.mjs"

if (Test-Path $Core) {
	node $Core uninstall @args
	exit $LASTEXITCODE
}

$Wrapper = Join-Path $BinDir "pi.cmd"
if (Test-Path $Wrapper) { Remove-Item -Force $Wrapper }
Write-Host "U-Harness uninstalled."
