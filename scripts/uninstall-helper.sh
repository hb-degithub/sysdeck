#!/usr/bin/env bash
# 卸载 panel-helper（等价于 scripts/install-helper.sh --uninstall）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/install-helper.sh" --uninstall "$@"
