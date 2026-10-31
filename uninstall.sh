#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/pi-install.mjs" ]; then
	exec node "$SCRIPT_DIR/scripts/pi-install.mjs" uninstall "$@"
fi

INSTALL_DIR="${UH_INSTALL_DIR:-$HOME/.local/share/uh}"
BIN_DIR="${UH_BIN_DIR:-$HOME/.local/bin}"

if [ -f "$INSTALL_DIR/scripts/pi-install.mjs" ]; then
	exec node "$INSTALL_DIR/scripts/pi-install.mjs" uninstall "$@"
fi

rm -f "$BIN_DIR/pi"
echo "U-Harness uninstalled."
