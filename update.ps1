$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
if ($ScriptDir -and (Test-Path (Join-Path $ScriptDir "scripts\pi-install.mjs"))) {
	node (Join-Path $ScriptDir "scripts\pi-install.mjs") update @args
	exit $LASTEXITCODE
}

$InstallDir = if ($env:UH_INSTALL_DIR) { $env:UH_INSTALL_DIR } else { Join-Path $HOME ".local\share\uh" }
$Core = Join-Path $InstallDir "scripts\pi-install.mjs"
if (-not (Test-Path $Core)) {
	throw "U-Harness is not installed: $InstallDir"
}

node $Core update @args
exit $LASTEXITCODE
