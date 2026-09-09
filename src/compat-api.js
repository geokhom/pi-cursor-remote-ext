/**
 * Hermes (and other completeSimple callers) dispatch via
 * `@earendil-works/pi-ai/compat`, which does not see ModelRuntime
 * `registerProvider`. This package is not a dependency of pi-cursor-remote,
 * so a bare `import("@earendil-works/pi-ai/compat")` from the extension
 * usually fails. Resolve every copy we can from the Pi host tree and call
 * `registerApiProvider` so they share the same apiProviderRegistry Map as
 * `completeSimple`.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CURSOR_REMOTE_API = "cursor-remote-bridge";

/**
 * @returns {string}
 */
export function piAgentNpmModules() {
  const agent =
    (typeof process.env.PI_AGENT_DIR === "string" && process.env.PI_AGENT_DIR.trim()) ||
    join(homedir(), ".pi", "agent");
  return join(agent, "npm", "node_modules");
}

/**
 * @param {string} startFile
 * @returns {string[]}
 */
export function walkNodeModulesForPiAi(startFile) {
  const roots = [];
  let dir = startFile;
  for (let i = 0; i < 12; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const pkg = join(dir, "node_modules", "@earendil-works", "pi-ai");
    if (existsSync(join(pkg, "package.json"))) roots.push(pkg);
  }
  return roots;
}

/**
 * Package roots that may own the compat registry Hermes already imported.
 * @param {{ argv1?: string, importMetaUrl?: string }} [opts]
 * @returns {string[]}
 */
export function piAiPackageRoots(opts = {}) {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    if (typeof p === "string" && p && !seen.has(p) && existsSync(join(p, "package.json"))) {
      seen.add(p);
      out.push(p);
    }
  };

  const npm = piAgentNpmModules();
  add(join(npm, "@earendil-works", "pi-ai"));
  add(join(npm, "pi-hermes-memory", "node_modules", "@earendil-works", "pi-ai"));
  add(
    join(
      npm,
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "@earendil-works",
      "pi-ai"
    )
  );

  const argv1 = opts.argv1 ?? process.argv[1];
  if (typeof argv1 === "string" && argv1) {
    for (const r of walkNodeModulesForPiAi(argv1)) add(r);
  }
  const meta = opts.importMetaUrl;
  if (typeof meta === "string" && meta.startsWith("file:")) {
    try {
      for (const r of walkNodeModulesForPiAi(fileURLToPath(meta))) add(r);
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * @param {string} pkgRoot
 * @returns {string[]}
 */
export function compatEntryFiles(pkgRoot) {
  const files = [
    join(pkgRoot, "dist", "compat.js"),
    join(pkgRoot, "compat.js"),
    join(pkgRoot, "dist", "src", "compat.js"),
  ];
  return files.filter((f) => existsSync(f));
}

/**
 * @param {unknown} mod
 * @param {Function} streamSimple
 * @returns {boolean}
 */
export function installCursorRemoteOnCompat(mod, streamSimple) {
  if (!mod || typeof streamSimple !== "function") return false;
  const target =
    typeof mod === "object" &&
    mod.default &&
    typeof mod.registerApiProvider !== "function" &&
    typeof mod.default.registerApiProvider === "function"
      ? mod.default
      : mod;
  if (!target || typeof target !== "object") return false;
  const reg = /** @type {{ registerApiProvider?: Function }} */ (target)
    .registerApiProvider;
  if (typeof reg !== "function") return false;
  try {
    reg(
      {
        api: CURSOR_REMOTE_API,
        stream: streamSimple,
        streamSimple,
      },
      "provider:cursor-remote"
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} spec
 * @param {string} [parentFile]
 */
async function loadModule(spec, parentFile) {
  if (typeof spec === "string" && (spec.startsWith("/") || spec.startsWith("file:"))) {
    const href = spec.startsWith("file:") ? spec : pathToFileURL(spec).href;
    return import(href);
  }
  if (parentFile) {
    try {
      const req = createRequire(parentFile);
      const resolved = req.resolve(String(spec));
      try {
        return req(String(spec));
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? /** @type {{ code?: string }} */ (err).code
            : "";
        if (code === "ERR_REQUIRE_ESM") {
          return import(pathToFileURL(resolved).href);
        }
        throw err;
      }
    } catch {
      // fall through to import()
    }
  }
  return import(String(spec));
}

/**
 * @param {Function} streamSimple
 * @param {{ argv1?: string, importMetaUrl?: string }} [opts]
 * @returns {Promise<number>} successful registry installs
 */
export async function registerCursorRemoteCompatApi(streamSimple, opts = {}) {
  let ok = 0;
  const parents = [];
  const argv1 = opts.argv1 ?? process.argv[1];
  if (typeof argv1 === "string" && argv1) parents.push(argv1);
  const npm = piAgentNpmModules();
  parents.push(join(npm, "pi-hermes-memory", "package.json"));
  parents.push(join(npm, "@earendil-works", "pi-coding-agent", "package.json"));

  const specs = ["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai"];
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    for (const spec of specs) {
      try {
        const mod = await loadModule(spec, parent);
        if (installCursorRemoteOnCompat(mod, streamSimple)) ok += 1;
      } catch {
        // next
      }
    }
  }

  try {
    const mod = await import("@earendil-works/pi-ai/compat");
    if (installCursorRemoteOnCompat(mod, streamSimple)) ok += 1;
  } catch {
    // extension usually cannot resolve this specifier
  }

  for (const root of piAiPackageRoots(opts)) {
    for (const file of compatEntryFiles(root)) {
      try {
        const mod = await loadModule(file);
        if (installCursorRemoteOnCompat(mod, streamSimple)) ok += 1;
      } catch {
        // next file
      }
    }
  }
  return ok;
}
