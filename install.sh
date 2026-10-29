#!/bin/sh
# xfer installer — auditable, idempotent, versioned, reversible.
#
#   install.sh --version 0.3.0 [--sha256 HEX] [--base URL]
#   install.sh --rollback
#   install.sh --check --version 0.3.0
#
# Design rules:
#   * no `curl | sh`: the file is downloaded, checksum-verified, then moved
#   * versions are kept side by side; ~/.local/bin/xfer is only a symlink
#   * a failed verification never touches the working install
#   * no sudo, nothing outside ~/.local
set -eu

REPO="${XFER_REPO:-xylipei/xfer}"
VERSION=""
SHA256=""
BASE=""
MODE="install"
DRY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --sha256)  SHA256="${2:-}";  shift 2 ;;
    --base)    BASE="${2:-}";    shift 2 ;;
    --check)   MODE="check"; shift ;;
    --rollback) MODE="rollback"; shift ;;
    --dry-run) DRY="1"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

HOME_DIR="${HOME:?}"
ROOT="$HOME_DIR/.local/xfer"
BIN="$HOME_DIR/.local/bin"
LINK="$BIN/xfer"
CUR="$ROOT/current"
PREV="$ROOT/previous"

case "$MODE" in
  check)
    [ -n "$VERSION" ] || { echo "--check needs --version" >&2; exit 2; }
    if [ -f "$CUR" ] && [ "$(cat "$CUR")" = "$VERSION" ] && [ -e "$LINK" ]; then
      echo "up-to-date: $VERSION"; exit 0
    fi
    echo "needs-update: installed=$([ -f "$CUR" ] && cat "$CUR" || echo none) wanted=$VERSION"
    exit 1
    ;;
  rollback)
    [ -f "$PREV" ] || { echo "nothing to roll back to" >&2; exit 1; }
    target="$ROOT/versions/xfer-$(cat "$PREV").mjs"
    [ -f "$target" ] || { echo "previous version file missing: $target" >&2; exit 1; }
    ln -sfn "$target" "$LINK"
    cur=$([ -f "$CUR" ] && cat "$CUR" || echo none)
    printf '%s' "$cur" > "$PREV"
    printf '%s' "$(basename "$target" | sed 's/^xfer-//; s/\.mjs$//')" > "$CUR"
    echo "rolled back to $(cat "$CUR")"
    exit 0
    ;;
esac

[ -n "$VERSION" ] || { echo "--version is required (e.g. --version 0.3.0)" >&2; exit 2; }
[ -n "$BASE" ] || BASE="https://cdn.jsdelivr.net/gh/$REPO@v$VERSION"
URL="$BASE/xfer.mjs"
ROOT="${ROOT%/}"
DEST="$ROOT/versions/xfer-$VERSION.mjs"

mkdir -p "$ROOT/versions" "$BIN"
TMP="$(mktemp "${TMPDIR:-/tmp}/xfer.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

echo "fetching $URL"
if ! curl -fsSL --max-time 60 -o "$TMP" "$URL"; then
  echo "download failed: $URL" >&2
  echo "hint: try --base https://raw.githubusercontent.com/$REPO/v$VERSION" >&2
  exit 1
fi

if [ -n "$SHA256" ]; then
  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$TMP" | cut -d' ' -f1)
  else
    actual=$(sha256sum "$TMP" | cut -d' ' -f1)
  fi
  if [ "$actual" != "$SHA256" ]; then
    echo "checksum mismatch: expected $SHA256 got $actual — nothing installed" >&2
    exit 1
  fi
  echo "checksum ok"
else
  echo "warning: no --sha256 given; installing unverified bytes" >&2
fi

[ -n "$DRY" ] && { echo "dry-run: would install $DEST"; exit 0; }

if [ -e "$LINK" ] && [ -f "$CUR" ]; then
  printf '%s' "$(cat "$CUR")" > "$PREV"
fi

mv "$TMP" "$DEST"
chmod +x "$DEST"
ln -sfn "$DEST" "$LINK"
printf '%s' "$VERSION" > "$CUR"
echo "installed $VERSION -> $LINK"
"$LINK" -V
