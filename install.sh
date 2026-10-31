#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/pi-install.mjs" ]; then
	exec node "$SCRIPT_DIR/scripts/pi-install.mjs" install "$@"
fi

INSTALL_DIR="${UH_INSTALL_DIR:-$HOME/.local/share/uh}"
REPO_URL="${UH_REPO_URL:-https://github.com/mcpe500/uh.git}"
BRANCH="${UH_BRANCH:-main}"

mkdir -p "$(dirname "$INSTALL_DIR")"

if [ -d "$INSTALL_DIR/.git" ]; then
	git -C "$INSTALL_DIR" fetch --all --tags
	git -C "$INSTALL_DIR" checkout "$BRANCH"
	git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
elif [ -e "$INSTALL_DIR" ]; then
	echo "Install directory exists but is not a git repository: $INSTALL_DIR" >&2
	exit 1
else
	git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

exec node "$INSTALL_DIR/scripts/pi-install.mjs" install "$@"
