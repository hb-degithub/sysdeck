#!/usr/bin/env bash
# build-android.sh — 一条命令产出签名 release APK
#
#   bash scripts/build-android.sh            # 增量构建
#   bash scripts/build-android.sh --clean    # 先 clean 再构建
#
# 前置：已执行 bash scripts/setup-android.sh（用户态 JDK17 + Android SDK + Gradle）
# 产物：dist/server-panel-app-<versionName>.apk
# 签名：android/keystore/release.keystore（首次构建自动生成，密码见 ~/.config/server-panel/android-signing.txt）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLCHAIN="${PANEL_ANDROID_TOOLCHAIN:-$HOME/.cache/server-panel-android}"
ANDROID_DIR="$REPO_ROOT/android"
DIST_DIR="$REPO_ROOT/dist"
KEYSTORE_DIR="$ANDROID_DIR/keystore"
KEYSTORE="$KEYSTORE_DIR/release.keystore"
KEYSTORE_PROPS="$KEYSTORE_DIR/keystore.properties"
SIGNING_TXT="$HOME/.config/server-panel/android-signing.txt"
KEY_ALIAS="${KEY_ALIAS:-serverpanel}"

log()  { printf '\033[1;34m[build]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[build]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[build]\033[0m %s\n' "$*" >&2; exit 1; }

CLEAN=0
[ "${1:-}" = "--clean" ] && CLEAN=1

[ -f "$TOOLCHAIN/env.sh" ] || die "未找到工具链。先执行： bash scripts/setup-android.sh"
# shellcheck disable=SC1091
. "$TOOLCHAIN/env.sh"

[ -x "${JAVA_HOME:-}/bin/java" ] || die "JAVA_HOME 无效：${JAVA_HOME:-<empty>}"
[ -x "${GRADLE_BIN:-}" ]         || die "GRADLE_BIN 无效，请重跑 setup-android.sh"
[ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/platforms/android-35" ] \
  || die "Android SDK platform 35 缺失，请重跑 setup-android.sh"

BUILD_TOOLS="$ANDROID_HOME/build-tools/35.0.0"
APKSIGNER="$BUILD_TOOLS/apksigner"
AAPT2="$BUILD_TOOLS/aapt2"
ZIPALIGN="$BUILD_TOOLS/zipalign"
[ -x "$APKSIGNER" ] && [ -x "$AAPT2" ] || die "build-tools 35.0.0 不完整"

# ---------------------------------------------------------------- 签名材料
log "== 检查签名材料 =="
mkdir -p "$KEYSTORE_DIR" "$DIST_DIR"
if [ ! -f "$KEYSTORE" ] || [ ! -f "$KEYSTORE_PROPS" ]; then
  log "生成 release keystore：$KEYSTORE"
  umask 077
  PASSWORD="$(openssl rand -hex 16)"
  "$JAVA_HOME/bin/keytool" -genkeypair -v \
    -keystore "$KEYSTORE" -storetype PKCS12 \
    -storepass "$PASSWORD" -keypass "$PASSWORD" \
    -alias "$KEY_ALIAS" -keyalg RSA -keysize 4096 -validity 10950 \
    -dname "CN=Server Panel, OU=android, O=hbmin, L=Local, ST=Local, C=CN" \
    >/dev/null 2>&1 || die "keystore 生成失败"

  cat > "$KEYSTORE_PROPS" <<EOF
storeFile=release.keystore
storePassword=$PASSWORD
keyAlias=$KEY_ALIAS
keyPassword=$PASSWORD
EOF
  chmod 600 "$KEYSTORE_PROPS" "$KEYSTORE"

  SHA256="$("$JAVA_HOME/bin/keytool" -list -v -keystore "$KEYSTORE" \
      -storepass "$PASSWORD" -alias "$KEY_ALIAS" 2>/dev/null \
      | awk -F': ' '/SHA256:/{print $2; exit}')"
  mkdir -p "$(dirname "$SIGNING_TXT")"
  cat > "$SIGNING_TXT" <<EOF
# 服务器面板 Android release 签名（请备份，丢失后无法覆盖安装升级）
# 生成时间: $(date '+%Y-%m-%d %H:%M:%S %z')
keystore: $KEYSTORE
alias: $KEY_ALIAS
storePassword: $PASSWORD
keyPassword: $PASSWORD
storeType: PKCS12
sha256: $SHA256

# 验证命令：
#   "$JAVA_HOME/bin/keytool" -list -v -keystore "$KEYSTORE" -alias "$KEY_ALIAS"
#   "$APKSIGNER" verify --print-certs <apk>
EOF
  chmod 600 "$SIGNING_TXT"
  log "签名密码已写入：$SIGNING_TXT (600)"
else
  log "复用已有 keystore：$KEYSTORE"
  if [ ! -f "$SIGNING_TXT" ]; then
    warn "keystore 存在但 $SIGNING_TXT 缺失，可从 $KEYSTORE_PROPS 找回"
  fi
fi
umask 022   # umask 077 仅用于签名材料，构建产物恢复常规权限

# ---------------------------------------------------------------- 图标
# 复用 frontend-dev 生成的 public/icons/icon-512.png（自适应图标前景）；
# 源图标不存在时保留 android 工程内已提交的 ic_launcher_art.png。
ICON_SRC="$REPO_ROOT/public/icons/icon-512.png"
ICON_DST="$ANDROID_DIR/app/src/main/res/drawable-nodpi/ic_launcher_art.png"
if [ -f "$ICON_SRC" ]; then
  mkdir -p "$(dirname "$ICON_DST")"
  cp -f "$ICON_SRC" "$ICON_DST"
  log "图标：复用 $ICON_SRC → ${ICON_DST#$REPO_ROOT/}"
else
  log "图标：未找到 public/icons/icon-512.png，使用工程内置 ic_launcher_art.png"
fi

# ---------------------------------------------------------------- 构建
echo "sdk.dir=$ANDROID_HOME" > "$ANDROID_DIR/local.properties"
[ -x "$ANDROID_DIR/gradlew" ] || warn "android/gradlew 缺失（setup-android.sh 会生成），本次用本地 Gradle 二进制"

START_EPOCH="$(date +%s)"
log "== 构建 release（JDK $( "$JAVA_HOME/bin/java" -version 2>&1 | head -1 | sed -E 's/.*"([^"]+)".*/\1/' ) / $( "$GRADLE_BIN" --version 2>/dev/null | awk '/^Gradle /{print $2; exit}' ) ）=="
(
  cd "$ANDROID_DIR"
  TASKS=()
  [ "$CLEAN" = 1 ] && TASKS+=("clean")
  TASKS+=("assembleRelease")
  "$GRADLE_BIN" --no-daemon --console=plain "${TASKS[@]}"
)
END_EPOCH="$(date +%s)"
BUILD_SECONDS=$((END_EPOCH - START_EPOCH))

BUILT_APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
[ -f "$BUILT_APK" ] || die "构建结束但未找到 APK：$BUILT_APK"

# ---------------------------------------------------------------- 产物与静态校验
VERSION_NAME="$("$AAPT2" dump badging "$BUILT_APK" | sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p")"
VERSION_NAME="${VERSION_NAME%%$'\n'*}"
[ -n "$VERSION_NAME" ] || die "无法从 APK 读取 versionName"
TARGET_APK="$DIST_DIR/server-panel-app-$VERSION_NAME.apk"
cp -f "$BUILT_APK" "$TARGET_APK"
chmod 644 "$TARGET_APK"

log "== 校验 =="
echo "--- apksigner verify ---"
"$APKSIGNER" verify --verbose --print-certs "$TARGET_APK" | sed -n '1,20p'

echo "--- zipalign -c 4 ---"
"$ZIPALIGN" -c -v 4 "$TARGET_APK" | tail -1

echo "--- aapt2 dump badging（摘要）---"
"$AAPT2" dump badging "$TARGET_APK" | grep -E "^(package|minSdkVersion|targetSdkVersion|application-label|application-icon|launchable-activity|uses-permission|native-code)" || true

APK_SIZE="$(du -h "$TARGET_APK" | cut -f1)"
APK_SHA="$(sha256sum "$TARGET_APK" | cut -d' ' -f1)"
log "== 完成 =="
log "APK   : $TARGET_APK"
log "大小  : $APK_SIZE"
log "SHA256: $APK_SHA"
log "耗时  : ${BUILD_SECONDS}s"
log "安装  : adb install -r \"$TARGET_APK\"   （或直接拷贝到手机点击安装）"
