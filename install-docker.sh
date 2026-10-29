#!/usr/bin/env bash
#
# 安装 Docker 并让面板获得管理权限
#
# 用法：
#   sudo ./install-docker.sh
#
# 这个脚本做的事：
#   1. 安装 docker.io（Ubuntu 官方源）
#   2. 启动并设置开机自启
#   3. 把当前用户加入 docker 组（免 sudo 使用 docker / 访问 socket）
#   4. 重启面板服务，使其立即获得 Docker 管理能力
#   5. 验证 socket 可达
#
# 卸载 Docker：sudo ./install-docker.sh --uninstall
#
set -euo pipefail

PANEL_USER="${SUDO_USER:-${USER}}"
PANEL_SERVICE="server-panel"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
blue()  { printf '\033[36m%s\033[0m\n' "$*"; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    red "需要 root 权限，请用 sudo 运行：sudo $0"
    exit 1
  fi
}

# ---------------- 卸载 ----------------
if [ "${1:-}" = "--uninstall" ]; then
  require_root
  yellow "即将卸载 Docker（容器与镜像数据保留在 /var/lib/docker）"
  read -r -p "确认？输入 yes 继续: " ans
  [ "$ans" = "yes" ] || { echo "已取消"; exit 0; }

  systemctl stop docker.socket docker 2>/dev/null || true
  systemctl disable docker.socket docker 2>/dev/null || true
  apt-get remove -y docker.io docker-compose-v2 containerd 2>/dev/null || true
  gpasswd -d "$PANEL_USER" docker 2>/dev/null || true
  green "✅ Docker 已卸载"
  exit 0
fi

require_root

blue "==============================================="
blue "  安装 Docker 并接入服务器控制面板"
blue "==============================================="
echo "  面板用户：$PANEL_USER"
echo "  项目目录：$PROJECT_DIR"
echo ""

# ---------------- 1. 安装 ----------------
blue "[1/5] 安装 docker.io…"
if command -v docker >/dev/null 2>&1; then
  green "  Docker 已安装：$(docker --version)"
else
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2
  green "  ✅ 安装完成：$(docker --version)"
fi

# ---------------- 2. 启动服务 ----------------
blue "[2/5] 启动 Docker 服务并设置开机自启…"
systemctl enable --now docker
sleep 2
if systemctl is-active --quiet docker; then
  green "  ✅ Docker 服务运行中"
else
  red "  ❌ Docker 服务启动失败，请检查：journalctl -u docker -n 50"
  exit 1
fi

# ---------------- 3. 加入 docker 组 ----------------
blue "[3/5] 将用户 $PANEL_USER 加入 docker 组…"
if id -nG "$PANEL_USER" | grep -qw docker; then
  green "  ✅ 已在 docker 组中"
else
  usermod -aG docker "$PANEL_USER"
  green "  ✅ 已加入 docker 组（需重新登录才对交互式 shell 生效）"
fi

# ---------------- 4. 验证 socket 权限 ----------------
blue "[4/5] 验证 socket 权限…"
if [ -S /var/run/docker.sock ]; then
  if sudo -u "$PANEL_USER" test -r /var/run/docker.sock 2>/dev/null; then
    green "  ✅ $PANEL_USER 可访问 /var/run/docker.sock"
  else
    yellow "  ⚠ 当前 shell 尚未应用新组，稍后重启面板服务即可（systemd 会重新加载凭据）"
  fi
else
  red "  ❌ /var/run/docker.sock 不存在"
  exit 1
fi

# ---------------- 5. 重启面板 ----------------
blue "[5/5] 重启面板服务…"
if systemctl --user --machine="${PANEL_USER}@.host" is-active --quiet "$PANEL_SERVICE" 2>/dev/null; then
  systemctl --user --machine="${PANEL_USER}@.host" restart "$PANEL_SERVICE"
  green "  ✅ 面板服务已重启"
elif runuser -u "$PANEL_USER" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$PANEL_USER")" \
     systemctl --user restart "$PANEL_SERVICE" 2>/dev/null; then
  green "  ✅ 面板服务已重启"
else
  yellow "  ⚠ 自动重启失败，请手动执行："
  echo "     systemctl --user restart $PANEL_SERVICE"
fi

sleep 3

# ---------------- 验证 ----------------
echo ""
blue "==============================================="
blue "  安装完成，验证中…"
blue "==============================================="

docker info --format '  Docker 版本：{{.ServerVersion}}' 2>/dev/null || true
docker info --format '  存储驱动：  {{.Driver}}' 2>/dev/null || true
docker info --format '  运行容器：  {{.ContainersRunning}}' 2>/dev/null || true

echo ""
if ss -tln 2>/dev/null | grep -q 3081; then
  green "✅ 面板运行中"
  echo "   打开 Docker 页面查看：http://$(hostname -I | awk '{print $1}'):3081"
else
  yellow "⚠ 面板未在 3081 监听，请手动启动：systemctl --user start $PANEL_SERVICE"
fi

echo ""
echo "提示：使用 Docker 面板功能前，请在浏览器里刷新页面（Ctrl+Shift+R）。"
echo "      如果页面仍显示「未检测到 Docker」，点页面上的「重新检测」按钮。"
