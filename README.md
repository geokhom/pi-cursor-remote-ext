# pi-cursor-remote

Level A **pi-package**: thin client from [pi](https://pi.dev) → contour `local-bridge` → VPS Cursor Agent. Tools run on the bridge, not in this package.

Public install artifact: [geokhom/pi-cursor-remote-ext](https://github.com/geokhom/pi-cursor-remote-ext).  
(Source of truth is a private monorepo; this public repo is the lean sync + Release tarballs.)

## Install

### Contour (recommended): one-liner GET via corp proxy

```bash
export http_proxy="${http_proxy:-http://proxy.example:3128}"
export https_proxy="${https_proxy:-$http_proxy}"

curl -fsSL -x "$http_proxy" \
  https://raw.githubusercontent.com/geokhom/pi-cursor-remote-ext/main/install.sh | bash
```

Скрипт: GET Release `.tgz` → `npm install --prefix ~/.pi/agent/npm` → в `settings.json` пишет `"npm:pi-cursor-remote"` (без `pi install npm:…`, чтобы не ходить в registry).  
Путь на диске: `~/.pi/agent/npm/node_modules/pi-cursor-remote`.

Опции:

```bash
PI_CURSOR_REMOTE_VERSION=0.17.0 bash  # пин версии (иначе latest Release, fallback 0.17.0)
# http_proxy / https_proxy — как обычно для curl
```

Обновление: тот же one-liner (или с новым `PI_CURSOR_REMOTE_VERSION`).

**0.17:** обновить также contour bridge и VPS relay до 0.17.x. Resumable upload
продолжает тот же run после сбоя и меняет представление блокируемого пакета,
не повторяя prompt или выполненный tool. Одного обновления Pi-пакета недостаточно.

### A. From contour-bridge zip / local tree (no network)

```bash
pi install ./pi-cursor-remote
# or project settings (−l = project settings file, not “local path”):
pi install -l ./pi-cursor-remote
```

В `settings.json` попадёт локальный путь (не `npm:…`).

### B. Manual: curl tarball + npm prefix

То же, что делает `install.sh`:

```bash
VER=0.17.0
TGZ="pi-cursor-remote-${VER}.tgz"
curl -fsSL -x "$http_proxy" -o "/tmp/${TGZ}" \
  "https://github.com/geokhom/pi-cursor-remote-ext/releases/download/v${VER}/${TGZ}"
mkdir -p ~/.pi/agent/npm
npm install --prefix ~/.pi/agent/npm "/tmp/${TGZ}"
# затем добавить "npm:pi-cursor-remote" в ~/.pi/agent/settings.json
```

### C. npm registry (когда пакет опубликован и GET к registry разрешён)

Пакет пока `"private": true`. После publish:

```bash
export http_proxy=… https_proxy=…
pi install npm:pi-cursor-remote
pi update npm:pi-cursor-remote   # обычные обновления через registry
```

### D. git clone (публичный lean repo)

```bash
git clone https://github.com/geokhom/pi-cursor-remote-ext.git
cd pi-cursor-remote-ext
pi install .
```

## Bridge

Also needed: running bridge + `~/.pi/agent/cursor-remote.json` (see contour-bridge pack README).

```bash
./run_bridge.sh   # or: python -m pi_cursor_local --from-config
pi                # select model "Cursor Remote"
# ESC or /stop / /cancel stops the Cursor run on the VPS (not only TUI output)
```

### Connection recovery

SSE drops and transient HTTP 5xx/429 responses reconnect without sending the
prompt again or cancelling the VPS run. Reconnect continues beyond the initial
eight attempts while the bridge reports active work; a temporarily unreachable
bridge remains subject to the idle deadline. The terminal is read from replay
even if the run finishes during the outage. Authentication failures stay visible.

With bridge **0.16.15+**, an ambiguous upload blocks only further uploads while
text/heartbeat/terminal continue on the existing sid. The `[wire]` receive-only
notice is not a run error. New prompts/tools are blocked because tool results and
cancel cannot be uploaded; a tool on the VPS may time out. Real run errors,
session loss and loss of liveness still end the turn. Update both the contour
bridge and this Pi package for the complete behavior; no VPS update is required.
