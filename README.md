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

### B. Contour: curl GET через корп-прокси (только HTTP GET)

В закрытом контуре POST/npm registry часто режутся, но **GET через proxy** обычно проходит. Канонический артефакт — GitHub Release на **public** repo:

```bash
export http_proxy="${http_proxy:-http://proxy.example:3128}"
export https_proxy="${https_proxy:-$http_proxy}"

VER=0.1.19
curl -fsSL -x "$http_proxy" -o pi-cursor-remote.tgz \
  "https://github.com/geokhom/pi-cursor-remote-ext/releases/download/v${VER}/pi-cursor-remote-${VER}.tgz"
tar -xzf pi-cursor-remote.tgz          # создаёт каталог package/
pi install ./package
```

`npm pack` кладёт файлы в префикс `package/` внутри архива — путь для `pi install` = `./package` после распаковки.

То же для обновлений: новый GET tarball → `pi remove` старого source при необходимости → `pi install ./package`.

### C. npm registry (когда пакет опубликован и GET к registry разрешён)

Пакет пока `"private": true`. После publish:

```bash
export http_proxy=… https_proxy=…
pi install npm:pi-cursor-remote
```

Если `pi install npm:…` всё же делает POST — используйте путь **B** (прямой GET tarball).

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
