$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
if ($ScriptDir -and (Test-Path (Join-Path $ScriptDir "scripts\pi-install.mjs"))) {
	node (Join-Path $ScriptDir "scripts\pi-install.mjs") install @args
	exit $LASTEXITCODE
}

$InstallDir = if ($env:UH_INSTALL_DIR) { $env:UH_INSTALL_DIR } else { Join-Path $HOME ".local\share\uh" }
$RepoUrl = if ($env:UH_REPO_URL) { $env:UH_REPO_URL } else { "https://github.com/mcpe500/uh.git" }
$Branch = if ($env:UH_BRANCH) { $env:UH_BRANCH } else { "main" }

$Parent = Split-Path -Parent $InstallDir
New-Item -ItemType Directory -Force -Path $Parent | Out-Null

if (Test-Path (Join-Path $InstallDir ".git")) {
	git -C $InstallDir fetch --all --tags
	git -C $InstallDir checkout $Branch
	git -C $InstallDir pull --ff-only origin $Branch
} elseif (Test-Path $InstallDir) {
	throw "Install directory exists but is not a git repository: $InstallDir"
} else {
	git clone --branch $Branch --depth 1 $RepoUrl $InstallDir
}

node (Join-Path $InstallDir "scripts\pi-install.mjs") install @args
exit $LASTEXITCODE
