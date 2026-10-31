#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/pi-install.mjs" ]; then
	exec node "$SCRIPT_DIR/scripts/pi-install.mjs" update "$@"
fi

INSTALL_DIR="${UH_INSTALL_DIR:-$HOME/.local/share/uh}"
if [ ! -f "$INSTALL_DIR/scripts/pi-install.mjs" ]; then
	echo "U-Harness is not installed: $INSTALL_DIR" >&2
	exit 1
fi

exec node "$INSTALL_DIR/scripts/pi-install.mjs" update "$@"
