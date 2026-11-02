#!/usr/bin/env bash
# DeltaDeck installer for macOS and Linux. Downloads the desktop app from GitHub Releases
# (or builds it from source with --build) and installs it for the current user only.
#
#   curl -fsSL https://raw.githubusercontent.com/dharmen8980/deltadeck/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --build | --version vX.Y.Z | --uninstall | --help
#
# Environment (mostly for testing): DELTADECK_REPO (owner/name), DELTADECK_RELEASE_BASE (base
# URL holding the release assets), DELTADECK_PREFIX (install dir instead of ~/Applications or
# ~/.local), DELTADECK_SRC (clone dir for --build), DELTADECK_NO_OPEN=1 (do not launch the app).
# Everything runs inside main(), so a partly downloaded script never runs.
set -euo pipefail

REPO="${DELTADECK_REPO:-dharmen8980/deltadeck}"
BUNDLE_ID="io.github.dharmen8980.deltadeck"
APP_NAME="DeltaDeck"
NODE_MIN_MAJOR=23
NODE_MIN_MINOR=6

TMP_DIR=""
MOUNT_POINT=""

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<EOF
Install the DeltaDeck desktop app (macOS, Linux x86_64) for the current user.

Usage:
  install.sh                    download the latest release and install it
  install.sh --version vX.Y.Z   download a given release (v0.2.0 or later)
  install.sh --build            build from source (needs git, node >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}, npm, uv)
  install.sh --uninstall        remove the installed app (your data is kept)
  install.sh --help             show this help

From the web:
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --build

Installs to:
  macOS  ~/Applications/${APP_NAME}.app
  Linux  ~/.local/bin/deltadeck and ~/.local/share/applications/deltadeck.desktop
Set DELTADECK_PREFIX to install somewhere else.

The browser version runs on macOS and Linux (Windows: use WSL): uvx deltadeck --root .
More: https://github.com/${REPO}/blob/main/docs/install.md
EOF
}

cleanup() {
  if [ -n "$MOUNT_POINT" ]; then
    hdiutil detach -quiet "$MOUNT_POINT" 2>/dev/null || hdiutil detach -quiet -force "$MOUNT_POINT" 2>/dev/null || true
    MOUNT_POINT=""
  fi
  if [ -n "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
    TMP_DIR=""
  fi
}

# Sets OS (mac | linux) and ARCH (the artifact's arch: arm64 | x64 on macOS, x86_64 on Linux).
detect_platform() {
  local os machine
  os="$(uname -s)"
  machine="$(uname -m)"
  case "$os" in
    Darwin)
      OS=mac
      # A shell under Rosetta reports x86_64 on Apple Silicon: install the native build anyway.
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then machine=arm64; fi
      case "$machine" in
        arm64) ARCH=arm64 ;;
        x86_64) ARCH=x64 ;;
        *) die "unsupported Mac architecture: $machine (supported: Apple Silicon, Intel)" ;;
      esac
      ;;
    Linux)
      OS=linux
      case "$machine" in
        x86_64 | amd64) ARCH=x86_64 ;;
        *) die "no Linux build for $machine yet (only x86_64). Use the browser version: uvx deltadeck --root ." ;;
      esac
      ;;
    MINGW* | MSYS* | CYGWIN*)
      die "Windows is not supported. Use WSL and run the installer there, or the browser version in WSL: uvx deltadeck --root ."
      ;;
    *) die "unsupported OS: $os (supported: macOS, Linux)" ;;
  esac
}

# The asset name in a release, e.g. deltadeck-0.1.0-mac-arm64.dmg.
asset_suffix() {
  if [ "$OS" = mac ]; then printf -- '-mac-%s.dmg' "$ARCH"; else printf -- '-linux-%s.AppImage' "$ARCH"; fi
}

# A tag as given (v0.1.0 or 0.1.0) -> v0.1.0.
normalize_tag() {
  case "$1" in
    v*) printf '%s' "$1" ;;
    *) printf 'v%s' "$1" ;;
  esac
}

# Sets BASE, the URL of the release assets. Without --version, use GitHub's latest/download
# redirect: it points at the latest published release (drafts and pre-releases are never
# "latest"), needs no API call and so no API rate limit. A 404 there means no release yet.
release_base() {
  local tag="$1"
  if [ -n "${DELTADECK_RELEASE_BASE:-}" ]; then
    BASE="${DELTADECK_RELEASE_BASE%/}"
  elif [ -z "$tag" ]; then
    BASE="https://github.com/${REPO}/releases/latest/download"
  else
    BASE="https://github.com/${REPO}/releases/download/${tag}"
  fi
}

no_release() {
  die "no published release found for ${REPO}${1:+ ($1)}.
  Build it from source instead:
    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --build
  or check https://github.com/${REPO}/releases"
}

download() {
  curl -fL --retry 3 --progress-bar -o "$2" "$1"
}

sha256_of() {
  if have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  elif have sha256sum; then sha256sum "$1" | awk '{print $1}'
  else die "need shasum or sha256sum to verify the download"
  fi
}

# Downloads SHA256SUMS.txt and the asset for this platform into TMP_DIR, checks the checksum and
# sets ASSET to the file's path.
fetch_release() {
  local tag="$1" base suffix name expected actual
  release_base "$tag"
  base="$BASE"
  suffix="$(asset_suffix)"
  say "Downloading from ${base}"
  if ! curl -fsL --retry 3 -o "$TMP_DIR/SHA256SUMS.txt" "$base/SHA256SUMS.txt"; then
    no_release "$tag"
  fi
  # Lines are "<sha256>  <name>" (sha256sum; a leading * marks binary mode).
  name="$(awk -v s="$suffix" '{n=$2; sub(/^\*/, "", n); if (substr(n, length(n) - length(s) + 1) == s && n ~ /^deltadeck-/) print n}' "$TMP_DIR/SHA256SUMS.txt" | head -n 1)"
  [ -n "$name" ] || die "this release has no deltadeck-*${suffix} (--version works for v0.2.0 and later; see https://github.com/${REPO}/releases)"
  expected="$(awk -v n="$name" '{m=$2; sub(/^\*/, "", m); if (m == n) print $1}' "$TMP_DIR/SHA256SUMS.txt" | head -n 1)"
  [ -n "$expected" ] || die "no checksum for ${name} in SHA256SUMS.txt"
  say "Downloading ${name}"
  download "$base/$name" "$TMP_DIR/$name" || die "download failed: $base/$name"
  actual="$(sha256_of "$TMP_DIR/$name")"
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for ${name}
  expected ${expected}
  got      ${actual}
  The download is corrupt or was changed. Nothing was installed."
  fi
  say "Checksum OK"
  ASSET="$TMP_DIR/$name"
}

# --- macOS --------------------------------------------------------------------------------------

mac_app_path() { printf '%s/%s.app' "${DELTADECK_PREFIX:-$HOME/Applications}" "$APP_NAME"; }

# The bundle id of an .app (falls back to DeltaDeck's own).
bundle_id_of() {
  local id=""
  if [ -f "$1/Contents/Info.plist" ]; then
    id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true)"
  fi
  printf '%s' "${id:-$BUNDLE_ID}"
}

mac_is_running() {
  [ "$(osascript -e "application id \"$1\" is running" 2>/dev/null || echo false)" = "true" ]
}

# Quits a running copy (it would keep the old files open) and waits up to 15 s for it to exit.
mac_quit() {
  local id="$1" i=0
  mac_is_running "$id" || return 0
  say "Quitting the running ${APP_NAME}"
  osascript -e "tell application id \"$id\" to quit" >/dev/null 2>&1 || true
  while mac_is_running "$id"; do
    i=$((i + 1))
    [ "$i" -le 30 ] || die "${APP_NAME} is still running. Quit it and run the installer again."
    sleep 0.5
  done
}

# Other copies the installer does not manage: one dragged into /Applications from a DMG, or the
# app under its former name (another bundle id, so it is a separate app to macOS).
mac_note_other_copies() {
  local dest="$1" other
  for other in "/Applications/${APP_NAME}.app" "/Applications/Local Docs Viewer.app" "$HOME/Applications/Local Docs Viewer.app"; do
    [ -d "$other" ] && [ "$other" != "$dest" ] || continue
    warn "another copy is at ${other}; this installer does not update it. Remove it to avoid opening the old one."
  done
}

mac_install_dmg() {
  local dmg="$1" dest src id
  dest="$(mac_app_path)"
  MOUNT_POINT="$TMP_DIR/mount"
  mkdir -p "$MOUNT_POINT"
  hdiutil attach -nobrowse -noautoopen -readonly -quiet -mountpoint "$MOUNT_POINT" "$dmg" \
    || { MOUNT_POINT=""; die "could not open ${dmg##*/}"; }
  src="$MOUNT_POINT/${APP_NAME}.app"
  [ -d "$src" ] || die "${APP_NAME}.app not found in ${dmg##*/}"
  id="$(bundle_id_of "$src")"
  mac_quit "$id"
  mkdir -p "${dest%/*}"
  # Copy next to the target first, then swap, so a failed copy leaves the old app in place.
  rm -rf "$dest.new"
  ditto "$src" "$dest.new" || { rm -rf "$dest.new"; die "could not copy ${APP_NAME}.app to ${dest%/*}"; }
  hdiutil detach -quiet "$MOUNT_POINT" 2>/dev/null || hdiutil detach -quiet -force "$MOUNT_POINT" 2>/dev/null || true
  MOUNT_POINT=""
  rm -rf "$dest"
  mv "$dest.new" "$dest"
  # curl downloads are not quarantined, but a DMG from elsewhere may be: the app is unsigned.
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  say "Installed ${dest}"
  mac_note_other_copies "$dest"
  if [ "${DELTADECK_NO_OPEN:-}" = "1" ]; then return; fi
  open "$dest" || warn "could not start ${APP_NAME}; open ${dest} yourself"
}

mac_uninstall() {
  local dest
  dest="$(mac_app_path)"
  if [ -d "$dest" ]; then
    mac_quit "$(bundle_id_of "$dest")"
    rm -rf "$dest"
    say "Removed ${dest}"
  else
    say "${APP_NAME} is not installed at ${dest}"
  fi
  say "Your settings and data are kept in ~/Library/Application Support/${APP_NAME} (delete that folder to remove them)."
}

# --- Linux --------------------------------------------------------------------------------------

linux_prefix() { printf '%s' "${DELTADECK_PREFIX:-$HOME/.local}"; }

has_fuse2() {
  local ldc
  for ldc in ldconfig /sbin/ldconfig /usr/sbin/ldconfig; do
    if command -v "$ldc" >/dev/null 2>&1; then
      "$ldc" -p 2>/dev/null | grep -q 'libfuse\.so\.2' && return 0
      return 1
    fi
  done
  return 0 # cannot tell: do not warn
}

linux_install_appimage() {
  local appimage="$1" prefix bin apps icons icon_line=""
  prefix="$(linux_prefix)"
  bin="$prefix/bin/deltadeck"
  apps="$prefix/share/applications"
  icons="$prefix/share/icons/hicolor/512x512/apps"
  mkdir -p "$prefix/bin" "$apps"
  # Replace through a temp name: a running AppImage cannot be overwritten in place ("text file busy").
  cp "$appimage" "$bin.new"
  chmod 755 "$bin.new"
  mv -f "$bin.new" "$bin"
  # The icon from inside the AppImage (no FUSE needed to extract); optional.
  if (cd "$TMP_DIR" && "$bin" --appimage-extract 'deltadeck.png' >/dev/null 2>&1) && [ -f "$TMP_DIR/squashfs-root/deltadeck.png" ]; then
    mkdir -p "$icons"
    cp "$TMP_DIR/squashfs-root/deltadeck.png" "$icons/deltadeck.png"
    icon_line="Icon=$icons/deltadeck.png"
  fi
  {
    printf '%s\n' "[Desktop Entry]" "Type=Application" "Name=${APP_NAME}" \
      "Comment=Local-only viewer for a folder of docs and code" \
      "Exec=\"$bin\" %U" "Terminal=false" "Categories=Utility;" "StartupWMClass=deltadeck"
    [ -z "$icon_line" ] || printf '%s\n' "$icon_line"
  } >"$apps/deltadeck.desktop"
  have update-desktop-database && update-desktop-database "$apps" >/dev/null 2>&1 || true
  say "Installed ${bin}"
  say "Menu entry: ${apps}/deltadeck.desktop"
  case ":${PATH}:" in
    *":$prefix/bin:"*) ;;
    *) warn "$prefix/bin is not on your PATH; add it to run 'deltadeck' from a terminal" ;;
  esac
  if ! has_fuse2; then
    warn "AppImages need FUSE 2: sudo apt install libfuse2 (Ubuntu 24.04+: libfuse2t64)"
  fi
  say "On Ubuntu 24.04+ AppArmor may block the AppImage's sandbox; the .deb from Releases avoids that."
  say "Start it from the app menu or run: deltadeck"
}

linux_uninstall() {
  local prefix f removed=0
  prefix="$(linux_prefix)"
  for f in "$prefix/bin/deltadeck" "$prefix/share/applications/deltadeck.desktop" \
    "$prefix/share/icons/hicolor/512x512/apps/deltadeck.png"; do
    if [ -e "$f" ]; then
      rm -f "$f"
      say "Removed $f"
      removed=1
    fi
  done
  [ "$removed" = 1 ] || say "${APP_NAME} is not installed under ${prefix}"
  say "Your settings and data are kept in ~/.config/${APP_NAME} (delete that folder to remove them)."
  say "If you installed the .deb, remove it with: sudo apt remove deltadeck-desktop"
}

# --- build from source --------------------------------------------------------------------------

check_build_tools() {
  local missing=0 major minor
  if ! have git; then
    warn "git is missing: macOS 'xcode-select --install'; Linux 'sudo apt install git' (or your package manager)"
    missing=1
  fi
  if ! have node || ! have npm; then
    warn "Node.js ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+ with npm is missing: https://nodejs.org/ (or 'brew install node', or nvm: 'nvm install 24')"
    missing=1
  else
    major="$(node -p 'process.versions.node.split(".")[0]')"
    minor="$(node -p 'process.versions.node.split(".")[1]')"
    if [ "$major" -lt "$NODE_MIN_MAJOR" ] || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -lt "$NODE_MIN_MINOR" ]; }; then
      warn "Node.js $(node -v) is too old: need ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+ (24 is what CI uses): https://nodejs.org/"
      missing=1
    fi
  fi
  if ! have uv; then
    warn "uv is missing: curl -LsSf https://astral.sh/uv/install.sh | sh   (https://docs.astral.sh/uv/)"
    missing=1
  fi
  [ "$missing" = 0 ] || die "install the tools above, then run the installer again with --build"
}

# Clones (or updates) the source and builds the app for this machine; sets ASSET to the result.
build_from_source() {
  local tag="$1" src release branch found="" f
  src="${DELTADECK_SRC:-$HOME/.deltadeck/src}"
  check_build_tools
  if [ -d "$src/.git" ]; then
    say "Updating ${src}"
    git -C "$src" fetch --tags origin || die "could not fetch ${REPO} into ${src}"
  else
    say "Cloning ${REPO} into ${src}"
    mkdir -p "${src%/*}"
    git clone "https://github.com/${REPO}.git" "$src" || die "could not clone ${REPO}"
  fi
  if [ -n "$tag" ]; then
    git -C "$src" rev-parse -q --verify "refs/tags/${tag}" >/dev/null || die "tag ${tag} not found in ${REPO}"
    git -C "$src" checkout -q --detach "$tag" || die "could not switch ${src} to ${tag} (local changes?)"
  else
    # Back on the default branch if an earlier --version left the clone detached.
    branch="$(git -C "$src" rev-parse --abbrev-ref origin/HEAD 2>/dev/null || true)"
    branch="${branch#origin/}"
    git -C "$src" checkout -q "${branch:-main}" || die "could not switch ${src} to ${branch:-main} (local changes?)"
    git -C "$src" pull -q --ff-only || die "could not update ${src} (local changes?). Remove it to start fresh."
  fi
  if [ "$OS" = mac ]; then
    # dist.mjs builds for the arch Node runs as: x64 under Rosetta, even on Apple Silicon.
    case "$(node -p process.arch)" in
      arm64) ARCH=arm64 ;;
      x64) ARCH=x64 ;;
      *) die "unsupported Node architecture: $(node -p process.arch)" ;;
    esac
    [ "$ARCH" = arm64 ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" != "1" ] \
      || warn "Node runs under Rosetta, so this builds the Intel (x64) app; use an arm64 Node for the native one"
  fi
  release="$src/desktop/release"
  # Old artifacts from an earlier build must not be picked up instead of this one.
  rm -f "$release"/deltadeck-*"$(asset_suffix)"
  say "Building ${APP_NAME} (web UI, frozen server, Electron package); this takes a few minutes"
  (cd "$src/desktop" && npm ci && npm run "dist:${OS}") || die "the build failed (output above)"
  for f in "$release"/deltadeck-*"$(asset_suffix)"; do
    if [ -f "$f" ]; then found="$f"; fi
  done
  [ -n "$found" ] || die "the build finished but no deltadeck-*$(asset_suffix) is in ${release}"
  ASSET="$found"
}

# --- main ---------------------------------------------------------------------------------------

main() {
  local mode=download tag=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --build) mode=build ;;
      --uninstall) mode=uninstall ;;
      --version)
        [ "$#" -ge 2 ] && [ -n "$2" ] || die "--version needs a tag, e.g. --version v0.2.0"
        tag="$(normalize_tag "$2")"
        shift
        ;;
      --version=*) tag="$(normalize_tag "${1#--version=}")" ;;
      -h | --help) usage; return 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done

  # Nothing below reads the terminal; keep npm and friends from eating a piped script.
  exec </dev/null
  detect_platform

  if [ "$mode" = uninstall ]; then
    if [ "$OS" = mac ]; then mac_uninstall; else linux_uninstall; fi
    return 0
  fi

  have curl || [ "$mode" = build ] || die "curl is required"
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deltadeck-install.XXXXXX")"
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  ASSET=""
  if [ "$mode" = build ]; then build_from_source "$tag"; else fetch_release "$tag"; fi
  if [ "$OS" = mac ]; then mac_install_dmg "$ASSET"; else linux_install_appimage "$ASSET"; fi
}

main "$@"
