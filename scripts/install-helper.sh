#!/usr/bin/env bash
# ------------------------------------------------------------------
# panel-helper 安装脚本（可重复执行；--uninstall 卸载）
#
#   sudo bash scripts/install-helper.sh            # 安装 / 升级 / 修复
#   sudo bash scripts/install-helper.sh --uninstall # 卸载
#
# 依赖：systemctl（必需）、node（必需）；ufw / apt-get / crontab 可选，
#       缺少时仅警告（对应特权操作会失败）。
# 安全：任何未知参数都只会打印用法并退出 2，不会修改系统。
# ------------------------------------------------------------------
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
HELPER_SRC="${REPO_DIR}/helper"
PANEL_USER="${PANEL_USER:-hb}"
INSTALL_DIR="/usr/local/lib/server-panel-helper"
ETC_DIR="/etc/server-panel"
SECRET_FILE="${ETC_DIR}/helper.secret"
UNIT_FILE="/etc/systemd/system/server-panel-helper.service"
LOG_FILE="/var/log/server-panel-helper.log"
SOCKET_DIR="/run/server-panel"

usage() {
  cat <<EOF
用法：sudo bash scripts/install-helper.sh [--uninstall|--help]

  （无参数）     安装 / 升级 panel-helper（幂等，可重复执行）
  --uninstall    停止并卸载 panel-helper，清理 unit/密钥/日志/运行目录
  --help         显示本帮助

环境变量：
  PANEL_USER     面板运行用户（默认 hb）
EOF
}

# ---- 参数解析：只接受明确参数，非法参数不做任何系统修改 ----
MODE="install"
if [ "$#" -gt 1 ]; then
  echo "错误：参数过多" >&2
  usage >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  case "$1" in
    --uninstall) MODE="uninstall" ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "错误：未知参数 '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
fi

log() { printf '[install-helper] %s\n' "$*"; }
die() { printf '[install-helper] 错误：%s\n' "$*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || die "需要 root 权限，请用 sudo bash $0"
}

check_deps() {
  local missing=0
  command -v systemctl >/dev/null 2>&1 || { echo "缺少必需依赖: systemctl" >&2; missing=1; }
  command -v node >/dev/null 2>&1 || { echo "缺少必需依赖: node" >&2; missing=1; }
  command -v ufw >/dev/null 2>&1 || log "警告：未找到 ufw，防火墙功能不可用"
  command -v apt-get >/dev/null 2>&1 || log "警告：未找到 apt-get，软件包功能不可用"
  command -v crontab >/dev/null 2>&1 || log "警告：未找到 crontab，定时任务功能不可用"
  [ "$missing" -eq 0 ] || die "缺少必需依赖，未做任何修改"
}

panel_uid() { id -u "${PANEL_USER}" 2>/dev/null || die "面板用户不存在: ${PANEL_USER}"; }
panel_gid() { id -g "${PANEL_USER}" 2>/dev/null || die "面板用户不存在: ${PANEL_USER}"; }

install_helper() {
  require_root
  check_deps
  local uid gid node_bin
  uid="$(panel_uid)"
  gid="$(panel_gid)"
  node_bin="$(command -v node)"

  for f in panel-helper.js validate.js protocol.js; do
    [ -f "${HELPER_SRC}/${f}" ] || die "helper 源码缺失: ${HELPER_SRC}/${f}"
  done

  log "安装 helper 到 ${INSTALL_DIR}"
  install -d -m 0755 -o root -g root "${INSTALL_DIR}"
  install -m 0644 -o root -g root "${HELPER_SRC}/panel-helper.js" "${INSTALL_DIR}/panel-helper.js"
  install -m 0644 -o root -g root "${HELPER_SRC}/validate.js" "${INSTALL_DIR}/validate.js"
  install -m 0644 -o root -g root "${HELPER_SRC}/protocol.js" "${INSTALL_DIR}/protocol.js"

  log "准备配置目录 ${ETC_DIR}（root:${PANEL_USER} 0750）"
  install -d -m 0750 -o root -g "${PANEL_USER}" "${ETC_DIR}"

  if [ ! -s "${SECRET_FILE}" ]; then
    log "生成 HMAC 密钥 ${SECRET_FILE}"
    umask 0077
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "${SECRET_FILE}"
    printf '\n' >> "${SECRET_FILE}"
  else
    log "复用已有密钥 ${SECRET_FILE}"
  fi
  chown "root:${PANEL_USER}" "${SECRET_FILE}"
  chmod 0640 "${SECRET_FILE}"

  log "准备日志 ${LOG_FILE}"
  install -m 0600 -o root -g root /dev/null "${LOG_FILE}"

  log "写入 systemd unit ${UNIT_FILE}"
  cat > "${UNIT_FILE}" <<UNIT
[Unit]
Description=Server Panel privileged helper (whitelisted root operations)
After=network.target

[Service]
Type=simple
UMask=0077
RuntimeDirectory=server-panel
RuntimeDirectoryMode=0750
ExecStart=${node_bin} ${INSTALL_DIR}/panel-helper.js
Environment=PANEL_HELPER_SOCKET=${SOCKET_DIR}/helper.sock
Environment=PANEL_HELPER_SECRET=${SECRET_FILE}
Environment=PANEL_HELPER_LOG=${LOG_FILE}
Environment=PANEL_HELPER_USER=${PANEL_USER}
Environment=PANEL_HELPER_GID=${gid}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

  log "启用并（重新）启动 server-panel-helper"
  systemctl daemon-reload
  systemctl enable server-panel-helper >/dev/null
  systemctl restart server-panel-helper
  sleep 1
  systemctl --no-pager --full status server-panel-helper 2>/dev/null | head -n 12 || true

  log "安装完成。socket=${SOCKET_DIR}/helper.sock，密钥=${SECRET_FILE}"
  log "验证：ls -l ${SOCKET_DIR}/helper.sock && sudo journalctl -u server-panel-helper -n 20"
}

uninstall_helper() {
  require_root
  log "停止并禁用 server-panel-helper"
  systemctl stop server-panel-helper 2>/dev/null || true
  systemctl disable server-panel-helper 2>/dev/null || true
  rm -f "${UNIT_FILE}"
  systemctl daemon-reload
  log "删除 helper 程序与运行目录"
  rm -rf "${INSTALL_DIR}" "${SOCKET_DIR}"
  log "删除密钥与日志"
  rm -f "${SECRET_FILE}" "${LOG_FILE}"
  rmdir "${ETC_DIR}" 2>/dev/null || true
  log "卸载完成（面板仍可运行，但特权运维接口会返回 helper_unavailable）"
}

case "${MODE}" in
  install) install_helper ;;
  uninstall) uninstall_helper ;;
esac
