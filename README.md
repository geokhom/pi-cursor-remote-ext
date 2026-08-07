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
PI_CURSOR_REMOTE_VERSION=0.1.23 bash   # пин версии (иначе latest Release, fallback 0.1.23)
# http_proxy / https_proxy — как обычно для curl
```

Обновление: тот же one-liner (или с новым `PI_CURSOR_REMOTE_VERSION`).

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
VER=0.1.23
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
```
