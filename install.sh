#!/usr/bin/env bash
# Install pi-cursor-remote into pi's user npm prefix (contour-friendly: HTTP GET only).
#
#   curl -fsSL -x "$http_proxy" \
#     https://raw.githubusercontent.com/geokhom/pi-cursor-remote-ext/main/install.sh | bash
#
# Env:
#   PI_CURSOR_REMOTE_VERSION  — pin (e.g. 0.1.19); default = latest GitHub Release, else 0.1.19
#   http_proxy / https_proxy  — corp proxy (curl picks these up; -x in the one-liner is optional)
#   PI_AGENT_DIR              — default ~/.pi/agent
set -euo pipefail

REPO="geokhom/pi-cursor-remote-ext"
PKG_NAME="pi-cursor-remote"
NPM_SPEC="npm:${PKG_NAME}"
DEFAULT_VERSION="0.1.41"
AGENT_DIR="${PI_AGENT_DIR:-${HOME}/.pi/agent}"
NPM_PREFIX="${AGENT_DIR}/npm"
SETTINGS="${AGENT_DIR}/settings.json"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: need '$1' on PATH" >&2
    exit 1
  }
}

need curl
need npm
need python3

resolve_version() {
  if [[ -n "${PI_CURSOR_REMOTE_VERSION:-}" ]]; then
    echo "${PI_CURSOR_REMOTE_VERSION#v}"
    return
  fi
  local json tag
  if json="$(curl -fsSL --max-time 30 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null)"; then
    tag="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name") or "")' 2>/dev/null || true)"
    if [[ -n "$tag" ]]; then
      echo "${tag#v}"
      return
    fi
  fi
  echo "$DEFAULT_VERSION"
}

VER="$(resolve_version)"
TGZ_NAME="${PKG_NAME}-${VER}.tgz"
TGZ_URL="https://github.com/${REPO}/releases/download/v${VER}/${TGZ_NAME}"
TMP_TGZ="$(mktemp "${TMPDIR:-/tmp}/${PKG_NAME}.XXXXXX.tgz")"
cleanup() { rm -f "$TMP_TGZ"; }
trap cleanup EXIT

echo "Installing ${NPM_SPEC}@${VER}"
echo "  tarball: ${TGZ_URL}"
echo "  prefix:  ${NPM_PREFIX}"

curl -fsSL --location --max-time 120 -o "$TMP_TGZ" "$TGZ_URL"
mkdir -p "$NPM_PREFIX"
npm install --prefix "$NPM_PREFIX" "$TMP_TGZ"

# Register in settings without calling `pi install npm:…` (may hit registry / POST).
python3 - "$SETTINGS" "$NPM_SPEC" <<'PY'
import json, sys
from pathlib import Path

settings_path = Path(sys.argv[1])
npm_spec = sys.argv[2]
legacy = {"package", "./package", "pi-cursor-remote", "./pi-cursor-remote"}

if settings_path.exists():
    data = json.loads(settings_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"ERROR: {settings_path} is not a JSON object")
else:
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    data = {}

pkgs = data.get("packages")
if pkgs is None:
    pkgs = []
elif not isinstance(pkgs, list):
    raise SystemExit("ERROR: settings.packages must be a list")

def source(entry):
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict) and isinstance(entry.get("source"), str):
        return entry["source"]
    return None

kept = []
seen_npm = False
for entry in pkgs:
    src = source(entry)
    if src in legacy:
        continue
    if src == npm_spec:
        seen_npm = True
    kept.append(entry)

if not seen_npm:
    kept.append(npm_spec)

data["packages"] = kept
settings_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Updated {settings_path} → packages includes {npm_spec!r}")
PY

MOD="${NPM_PREFIX}/node_modules/${PKG_NAME}"
if [[ ! -f "${MOD}/package.json" ]]; then
  echo "ERROR: missing ${MOD}/package.json after npm install" >&2
  exit 1
fi

echo "OK: ${NPM_SPEC} → ${MOD}"
echo "Restart pi (or /reload) and pick model \"Cursor Remote\"."
echo "Bridge config still needed: ~/.pi/agent/cursor-remote.json"
