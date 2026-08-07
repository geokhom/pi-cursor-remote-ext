# pi-cursor-remote

Level A **pi-package**: thin client from [pi](https://pi.dev) → contour `local-bridge` → VPS Cursor Agent. Tools run on the bridge, not in this package.

Public install artifact: [geokhom/pi-cursor-remote-ext](https://github.com/geokhom/pi-cursor-remote-ext).  
(Source of truth is a private monorepo; this public repo is the lean sync + Release tarballs.)

## Install

### A. From contour-bridge zip / local tree (no network)

```bash
pi install ./pi-cursor-remote
# or project settings (−l = project settings file, not “local path”):
pi install -l ./pi-cursor-remote
```

В `settings.json` попадёт локальный путь (не `npm:…`). Для единого стиля с другими пакетами предпочтителен путь **B**.

### B. Contour: curl GET → `~/.pi/agent/npm` (как `npm:…`)

Остальные пакеты вида `npm:<name>` лежат в `~/.pi/agent/npm/node_modules/<name>`. Тот же layout для этого расширения — без обращения к npm registry (только GET tarball через корп-прокси):

```bash
export http_proxy="${http_proxy:-http://proxy.example:3128}"
export https_proxy="${https_proxy:-$http_proxy}"

VER=0.1.19
TGZ="pi-cursor-remote-${VER}.tgz"
curl -fsSL -x "$http_proxy" -o "/tmp/${TGZ}" \
  "https://github.com/geokhom/pi-cursor-remote-ext/releases/download/v${VER}/${TGZ}"

mkdir -p ~/.pi/agent/npm
npm install --prefix ~/.pi/agent/npm "/tmp/${TGZ}"
# → ~/.pi/agent/npm/node_modules/pi-cursor-remote

pi remove package 2>/dev/null || true   # если раньше ставили из распакованного package/
pi install npm:pi-cursor-remote         # в settings → "npm:pi-cursor-remote"
```

Если `pi install npm:…` тянет registry (POST) — пакет уже на диске; достаточно вручную добавить в `~/.pi/agent/settings.json`:

```json
"packages": [
  "npm:pi-mcp-adapter",
  "npm:pi-cursor-remote"
]
```

Обновление: новый GET tarball → снова `npm install --prefix ~/.pi/agent/npm /tmp/….tgz` (перезапишет `node_modules/pi-cursor-remote`).

### C. npm registry (когда пакет опубликован и GET к registry разрешён)

Пакет пока `"private": true`. После publish:

```bash
export http_proxy=… https_proxy=…
pi install npm:pi-cursor-remote
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
