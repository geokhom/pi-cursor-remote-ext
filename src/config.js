/**
 * Load ~/.pi/agent/cursor-remote.json (shared with local-bridge).
 * Env CURSOR_REMOTE_CONFIG overrides path; BRIDGE_* env overrides fields.
 */

import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_PORT = 18765;
export const DEFAULT_HOST = "127.0.0.1";
export const CONFIG_NAME = "cursor-remote.json";

/** @type {ReadonlySet<string>} */
export const THINKING_DISPLAY_VALUES = new Set(["off", "indicator", "full"]);
export const THINKING_DISPLAY_DEFAULT = "indicator";

/** @type {ReadonlySet<string>} */
export const WIRE_STATS_VALUES = new Set(["session", "request"]);
export const WIRE_STATS_DEFAULT = "session";

/** Cursor SDK model ids (static allowlist; mirrors pi_cursor_wire.constants). */
export const DEFAULT_MODEL = "composer-2.5";
export const MODEL_VALUES = Object.freeze(["composer-2.5", "auto"]);
/** @type {ReadonlySet<string>} */
export const MODEL_VALUE_SET = new Set(MODEL_VALUES);

/** @type {Record<string, string>} */
export const MODEL_DISPLAY_NAMES = {
  "composer-2.5": "Composer 2.5",
  auto: "Auto",
};

/**
 * @param {unknown} raw
 * @returns {"off"|"indicator"|"full"}
 */
export function coerceThinkingDisplay(raw) {
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (THINKING_DISPLAY_VALUES.has(v)) {
      return /** @type {"off"|"indicator"|"full"} */ (v);
    }
  }
  return THINKING_DISPLAY_DEFAULT;
}

/**
 * @param {unknown} raw
 * @returns {"session"|"request"}
 */
export function coerceWireStats(raw) {
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (WIRE_STATS_VALUES.has(v)) {
      return /** @type {"session"|"request"} */ (v);
    }
    if (v === "run" || v === "turn" || v === "prompt") return "request";
    if (v === "total" || v === "cumulative" || v === "cum") return "session";
  }
  return WIRE_STATS_DEFAULT;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function coerceModel(raw) {
  if (typeof raw === "string") {
    const v = raw.trim();
    if (MODEL_VALUE_SET.has(v)) return v;
    const low = v.toLowerCase();
    for (const m of MODEL_VALUES) {
      if (m.toLowerCase() === low) return m;
    }
  }
  return DEFAULT_MODEL;
}

export function defaultConfigPath() {
  const override = process.env.CURSOR_REMOTE_CONFIG;
  if (override) return override;
  return join(homedir(), ".pi", "agent", CONFIG_NAME);
}

/**
 * @param {string} [path]
 * @returns {{
 *   relayUrl: string,
 *   bridgeToken: string,
 *   host: string,
 *   port: number,
 *   localToken: string,
 *   grants: string[],
 *   thinkingDisplay: "off"|"indicator"|"full",
 *   wireStats: "session"|"request",
 *   model: string,
 *   baseUrl: string,
 *   path: string,
 * } | null}
 */
export function loadConfig(path) {
  const cfgPath = path || defaultConfigPath();
  if (!existsSync(cfgPath)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {
    throw new Error(`invalid JSON config: ${cfgPath}`);
  }
  if (!raw || typeof raw !== "object") {
    throw new Error(`config must be a JSON object: ${cfgPath}`);
  }
  const proxy = raw.proxy && typeof raw.proxy === "object" ? raw.proxy : {};
  const host = String(raw.host || DEFAULT_HOST);
  const port = Number(raw.port || DEFAULT_PORT);
  const grants = Array.isArray(raw.grants)
    ? raw.grants.map(String).filter((g) => g === "write" || g === "shell")
    : [];
  const thinkingRaw =
    raw.thinkingDisplay !== undefined ? raw.thinkingDisplay : raw.thinking_display;
  const wireRaw = raw.wireStats !== undefined ? raw.wireStats : raw.wire_stats;
  return {
    relayUrl: String(raw.relayUrl || raw.relay_url || ""),
    bridgeToken: String(raw.bridgeToken || raw.bridge_token || ""),
    host,
    port,
    localToken: String(raw.localToken || raw.local_token || ""),
    grants,
    thinkingDisplay: coerceThinkingDisplay(thinkingRaw),
    wireStats: coerceWireStats(wireRaw),
    model: coerceModel(raw.model),
    httpProxy: String(proxy.http || raw.httpProxy || ""),
    httpsProxy: String(proxy.https || raw.httpsProxy || ""),
    noProxy: String(proxy.no || raw.noProxy || "127.0.0.1,localhost"),
    baseUrl: `http://${host}:${port}`,
    path: cfgPath,
  };
}

/**
 * Resolve bridge client options: env wins, then shared JSON.
 * @returns {{
 *   baseUrl?: string,
 *   token?: string,
 *   unixPath?: string,
 *   grants: string[],
 *   thinkingDisplay: "off"|"indicator"|"full",
 *   wireStats: "session"|"request",
 *   configPath?: string,
 * }}
 */
export function resolveBridgeConnection() {
  const cfg = loadConfig();
  const unixPath = process.env.BRIDGE_UNIX_PATH || undefined;
  const baseUrl =
    process.env.BRIDGE_URL ||
    (unixPath ? undefined : cfg?.baseUrl) ||
    undefined;
  const token =
    process.env.BRIDGE_LOCAL_TOKEN ||
    (unixPath ? undefined : cfg?.localToken) ||
    undefined;
  const grants = [];
  if (cfg?.grants?.length) grants.push(...cfg.grants);
  const thinkingDisplay = coerceThinkingDisplay(
    process.env.BRIDGE_THINKING_DISPLAY || cfg?.thinkingDisplay
  );
  const wireStats = coerceWireStats(
    process.env.BRIDGE_WIRE_STATS || cfg?.wireStats
  );
  // env grants still applied via grantsFromEnv in runPromptViaBridge
  return {
    baseUrl,
    token,
    unixPath,
    grants,
    thinkingDisplay,
    wireStats,
    configPath: cfg?.path,
  };
}
