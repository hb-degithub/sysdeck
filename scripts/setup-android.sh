#!/usr/bin/env bash
# setup-android.sh — 用户态安装 Android 构建工具链（无 sudo / 无 apt）
#
# 安装内容（全部落在 $PANEL_ANDROID_TOOLCHAIN，默认 ~/.cache/server-panel-android）：
#   jdk-17/                Temurin JDK 17 (Adoptium)
#   gradle-8.9/            Gradle 8.9 发行版（同时用于生成 android/ 的 wrapper）
#   android-sdk/           Android cmdline-tools + platform-tools + platforms;android-35 + build-tools;35.0.0
#   env.sh                 供 scripts/build-android.sh source 的环境变量
#
# 可重放：已装好的步骤会跳过；重复执行安全。
# 用法： bash scripts/setup-android.sh [--force]
set -euo pipefail

ROOT="${PANEL_ANDROID_TOOLCHAIN:-$HOME/.cache/server-panel-android}"
DL="$ROOT/downloads"
JDK_DIR="$ROOT/jdk-17"
GRADLE_VERSION="${GRADLE_VERSION:-8.9}"
GRADLE_DIR="$ROOT/gradle-$GRADLE_VERSION"
SDK_DIR="$ROOT/android-sdk"
CMDLINE_TOOLS_VERSION="11076708"   # commandlinetools-linux-11076708_latest.zip
CMDLINE_TOOLS_ZIP="commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/${CMDLINE_TOOLS_ZIP}"
GRADLE_URL="https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip"
JDK_URL="https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
# android/ 工程目录（脚本位于 <repo>/scripts/）
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ANDROID="$REPO_ROOT/android"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[setup]\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令 $1（系统自带，不应需要安装）"; }
need tar; need unzip; need wget; need python3

mkdir -p "$ROOT" "$DL"

# wget 带重试的下载；已存在且非空则跳过
fetch() { # fetch <url> <dest-file>
  local url="$1" dest="$2"
  if [ -s "$dest" ] && [ "$FORCE" = 0 ]; then
    log "已存在，跳过下载：$(basename "$dest") ($(du -h "$dest" | cut -f1))"
    return 0
  fi
  log "下载 $(basename "$dest") ← $url"
  rm -f "$dest"
  wget --quiet --show-progress --tries=5 --timeout=60 --waitretry=5 \
       --user-agent="server-panel-android-setup/1.0" -O "$dest" "$url" \
    || die "下载失败：$url"
  [ -s "$dest" ] || die "下载结果为空：$url"
}

# ---------------------------------------------------------------- 1. JDK 17
log "== JDK 17 =="
if [ -x "$JDK_DIR/bin/java" ] && [ "$FORCE" = 0 ]; then
  log "已安装：$("$JDK_DIR/bin/java" -version 2>&1 | head -1)"
else
  JDK_TGZ="$DL/temurin17-jdk-linux-x64.tar.gz"
  fetch "$JDK_URL" "$JDK_TGZ"
  log "解压 JDK…"
  rm -rf "$ROOT/.tmp-jdk" "$JDK_DIR"
  mkdir -p "$ROOT/.tmp-jdk"
  tar -xzf "$JDK_TGZ" -C "$ROOT/.tmp-jdk"
  inner="$(find "$ROOT/.tmp-jdk" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -n "$inner" ] || die "JDK 解压目录为空"
  mv "$inner" "$JDK_DIR"
  rm -rf "$ROOT/.tmp-jdk"
  "$JDK_DIR/bin/java" -version >/dev/null 2>&1 || die "JDK 不可用：$JDK_DIR"
  log "JDK 就绪：$("$JDK_DIR/bin/java" -version 2>&1 | head -1)"
fi
export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"

# ---------------------------------------------------------------- 2. Gradle
log "== Gradle $GRADLE_VERSION =="
if [ -x "$GRADLE_DIR/bin/gradle" ] && [ "$FORCE" = 0 ]; then
  log "已安装：$("$GRADLE_DIR/bin/gradle" --version 2>/dev/null | awk '/^Gradle /{print; exit}')"
else
  GRADLE_ZIP="$DL/gradle-${GRADLE_VERSION}-bin.zip"
  fetch "$GRADLE_URL" "$GRADLE_ZIP"
  log "解压 Gradle…"
  rm -rf "$ROOT/.tmp-gradle" "$GRADLE_DIR"
  mkdir -p "$ROOT/.tmp-gradle"
  unzip -q "$GRADLE_ZIP" -d "$ROOT/.tmp-gradle"
  inner="$(find "$ROOT/.tmp-gradle" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -n "$inner" ] || die "Gradle 解压目录为空"
  mv "$inner" "$GRADLE_DIR"
  rm -rf "$ROOT/.tmp-gradle"
  log "Gradle 就绪：$("$GRADLE_DIR/bin/gradle" --version 2>/dev/null | awk '/^Gradle /{print; exit}')"
fi

# ---------------------------------------------------------------- 3. Android SDK
log "== Android commandline-tools =="
SDKMANAGER="$SDK_DIR/cmdline-tools/latest/bin/sdkmanager"
if [ -x "$SDKMANAGER" ] && [ "$FORCE" = 0 ]; then
  log "已安装：$SDKMANAGER"
else
  CT_ZIP="$DL/$CMDLINE_TOOLS_ZIP"
  fetch "$CMDLINE_TOOLS_URL" "$CT_ZIP"
  log "解压 commandline-tools…"
  rm -rf "$ROOT/.tmp-cmdline" "$SDK_DIR"
  mkdir -p "$ROOT/.tmp-cmdline" "$SDK_DIR/cmdline-tools"
  unzip -q "$CT_ZIP" -d "$ROOT/.tmp-cmdline"
  mv "$ROOT/.tmp-cmdline/cmdline-tools" "$SDK_DIR/cmdline-tools/latest"
  rm -rf "$ROOT/.tmp-cmdline"
  [ -x "$SDKMANAGER" ] || die "sdkmanager 不存在：$SDKMANAGER"
fi
export ANDROID_HOME="$SDK_DIR"
export ANDROID_SDK_ROOT="$SDK_DIR"

# 接受 license（yes 管道；pipefail 下忽略 yes 的 SIGPIPE 退出码）
log "== 接受 SDK licenses =="
set +o pipefail
yes 2>/dev/null | "$SDKMANAGER" --sdk_root="$SDK_DIR" --licenses >/dev/null 2>&1 || true
set -o pipefail
[ -d "$SDK_DIR/licenses" ] && log "licenses 目录：$(ls "$SDK_DIR/licenses" | tr '\n' ' ')"

# 安装所需组件（幂等：已安装会输出 already installed）
log "== 安装 platform-tools / platforms;android-35 / build-tools;35.0.0 =="
"$SDKMANAGER" --sdk_root="$SDK_DIR" --install \
  "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
  2>&1 | grep -v '^\[=' || true

[ -f "$SDK_DIR/platforms/android-35/android.jar" ] || die "platforms;android-35 安装失败"
[ -x "$SDK_DIR/build-tools/35.0.0/aapt2" ]        || die "build-tools;35.0.0 安装失败"
log "SDK 组件就绪："
log "  android.jar   : $SDK_DIR/platforms/android-35/android.jar"
log "  build-tools   : $SDK_DIR/build-tools/35.0.0"
log "  platform-tools: $SDK_DIR/platform-tools"

# ---------------------------------------------------------------- 4. env.sh
cat > "$ROOT/env.sh" <<EOF
# 由 scripts/setup-android.sh 生成，供 scripts/build-android.sh source
export PANEL_ANDROID_TOOLCHAIN="$ROOT"
export JAVA_HOME="$JDK_DIR"
export ANDROID_HOME="$SDK_DIR"
export ANDROID_SDK_ROOT="$SDK_DIR"
export GRADLE_BIN="$GRADLE_DIR/bin/gradle"
export PATH="\$JAVA_HOME/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/build-tools/35.0.0:\$PATH"
EOF
chmod 644 "$ROOT/env.sh"
log "环境文件：$ROOT/env.sh"

# ---------------------------------------------------------------- 5. Gradle wrapper
# 在临时空工程里生成 wrapper，避免配置 android/ 工程时提前触发 AGP/SDK 校验
if [ -f "$PROJECT_ANDROID/gradlew" ] && [ -f "$PROJECT_ANDROID/gradle/wrapper/gradle-wrapper.jar" ] && [ "$FORCE" = 0 ]; then
  log "wrapper 已存在，跳过生成：$PROJECT_ANDROID/gradlew"
else
  log "== 生成 Gradle wrapper（$GRADLE_VERSION, bin）=="
  TMP_WRAP="$(mktemp -d)"
  : > "$TMP_WRAP/settings.gradle"
  ( cd "$TMP_WRAP" && "$GRADLE_DIR/bin/gradle" --quiet wrapper --gradle-version "$GRADLE_VERSION" --distribution-type bin >/dev/null )
  mkdir -p "$PROJECT_ANDROID/gradle/wrapper"
  cp "$TMP_WRAP/gradlew" "$PROJECT_ANDROID/gradlew"
  cp "$TMP_WRAP/gradlew.bat" "$PROJECT_ANDROID/gradlew.bat"
  cp "$TMP_WRAP/gradle/wrapper/gradle-wrapper.jar" "$PROJECT_ANDROID/gradle/wrapper/gradle-wrapper.jar"
  cp "$TMP_WRAP/gradle/wrapper/gradle-wrapper.properties" "$PROJECT_ANDROID/gradle/wrapper/gradle-wrapper.properties"
  chmod +x "$PROJECT_ANDROID/gradlew"
  rm -rf "$TMP_WRAP"
  log "wrapper：$(cat "$PROJECT_ANDROID/gradle/wrapper/gradle-wrapper.properties" | grep distributionUrl)"
fi

# ---------------------------------------------------------------- 汇总
log "== 完成 =="
log "JDK   : $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"
log "Gradle: $("$GRADLE_DIR/bin/gradle" --version 2>/dev/null | awk '/^Gradle /{print; exit}')  ($GRADLE_DIR)"
log "SDK   : $SDK_DIR"
log "用法  : source $ROOT/env.sh && bash scripts/build-android.sh"
