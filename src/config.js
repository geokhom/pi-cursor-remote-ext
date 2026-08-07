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
  return {
    relayUrl: String(raw.relayUrl || raw.relay_url || ""),
    bridgeToken: String(raw.bridgeToken || raw.bridge_token || ""),
    host,
    port,
    localToken: String(raw.localToken || raw.local_token || ""),
    grants,
    httpProxy: String(proxy.http || raw.httpProxy || ""),
    httpsProxy: String(proxy.https || raw.httpsProxy || ""),
    noProxy: String(proxy.no || raw.noProxy || "127.0.0.1,localhost"),
    baseUrl: `http://${host}:${port}`,
    path: cfgPath,
  };
}

/**
 * Resolve bridge client options: env wins, then shared JSON.
 * @returns {{ baseUrl?: string, token?: string, unixPath?: string, grants: string[] }}
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
  // env grants still applied via grantsFromEnv in runPromptViaBridge
  return { baseUrl, token, unixPath, grants, configPath: cfg?.path };
}
