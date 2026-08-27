/**
 * Thin HTTP client for local-bridge (AGENTS.md §10).
 *
 * Default production path is Unix socket 0600; TCP + Bearer is the
 * test/fallback path when AF_UNIX bind is unavailable.
 *
 * Tool execution stays on the bridge — this client only posts prompts,
 * manages session grants, and streams SSE events.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import fs from "node:fs";
import { displayToolName } from "./tool-display.js";
import {
  stashToolResult,
  clearToolResults,
  trackCallId,
  setFollowUp,
} from "./result-stash.js";
import { coerceThinkingDisplay, THINKING_DISPLAY_DEFAULT, coerceWireStats, WIRE_STATS_DEFAULT, DEFAULT_MODEL } from "./config.js";
import {
  showThinkingIndicator,
  clearThinkingIndicator,
  setWireStatus,
  clearWireStatus,
} from "./thinking-indicator.js";
import { tryApplyWireUsage } from "./usage-accounting.js";
import { wrapToWidth, LINE_BREAK_RE } from "./tui-width.js";
import {
  clearLiveRun,
  getActiveLiveRun,
  hasActiveLiveRun,
  isPostToolBoundaryEvent,
  settleToolBatch,
  startLiveEventFeeder,
} from "./live-run.js";
import { recordDecodeSample } from "./generation-speed.js";

/**
 * True when a thinking-chunk boundary needs an inserted space.
 * Keeps dotted ASCII identifiers (`zbx.t_foo`) and `foo(` tight.
 * @param {string} left
 * @param {string} right
 */
export function thinkingJoinNeedsSpace(left, right) {
  if (!left || !right) return false;
  if (/\s$/.test(left) || /^\s/.test(right)) return false;
  if (/^[,.;:!?%)\]}…»]/.test(right)) return false;
  if (/^\(/.test(right)) return false;
  if (/[(\[{]$/.test(left)) return false;
  if (/_$/.test(left) || /^_/.test(right)) return false;
  // Dotted ident continuation (zbx.t_foo); still space before a new sentence (Message. Verifying).
  if (/\.$/.test(left) && /^[a-z0-9_]/.test(right)) return false;
  return (
    /[\p{L}\p{N}.,:;!?%…»"'\)\]—–/-]$/u.test(left) &&
    /^[\p{L}\p{N}«"'`—–/-]/u.test(right)
  );
}

/**
 * @param {string} buf
 * @param {string} suffix
 */
function joinThinkingBoundary(buf, suffix) {
  if (!suffix) return buf;
  const rest = suffix.replace(/^[ \t]+/, "");
  if (!rest) {
    if (/\s$/.test(buf)) return buf;
    return `${buf} `;
  }
  if (/^[ \t]/.test(suffix)) {
    if (/\s$/.test(buf)) return buf + rest;
    return `${buf} ${rest}`;
  }
  if (/\s$/.test(buf)) return buf + rest;
  if (thinkingJoinNeedsSpace(buf, rest)) return `${buf} ${rest}`;
  return buf + rest;
}

/**
 * Join thinking chunks into flowing prose (SDK often sends short lines / CR).
 * Incremental tokens, space-only chunks, and cumulative snapshots that omit
 * a space at the new boundary (`rules` + `rulesс` → `rules с`) are glued here.
 * @param {string} buf
 * @param {string} chunk
 */
export function joinThinkingChunk(buf, chunk) {
  if (!chunk) return buf || "";
  let c = String(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Soft line wraps → spaces; keep rare blank-line paragraph breaks
  c = c.replace(/([^\n])\n(?!\n)/g, "$1 ").replace(/\n{3,}/g, "\n\n");
  c = c.replace(/[ \t]{2,}/g, " ");
  if (!buf) return c.replace(/^[ \t]+/, "");
  if (c.startsWith(buf)) {
    return joinThinkingBoundary(buf, c.slice(buf.length));
  }
  const bufRtrim = buf.replace(/[ \t]+$/, "");
  if (bufRtrim && bufRtrim !== buf && c.startsWith(bufRtrim)) {
    return joinThinkingBoundary(bufRtrim, c.slice(bufRtrim.length));
  }
  if (c === buf || (c.length >= 4 && buf.endsWith(c))) return buf;
  return joinThinkingBoundary(buf, c);
}

/**
 * @typedef {object} BridgeClientOptions
 * @property {string} [baseUrl] TCP base, e.g. http://127.0.0.1:PORT
 * @property {string} [token] Bearer token (required for TCP mode)
 * @property {string} [unixPath] Absolute path to Unix socket (0600)
 */

/**
 * Fail-closed checks before connecting to a local-bridge Unix socket (STATUS P1d).
 * Owner must match process uid; mode must be exactly 0600; no symlinks.
 * @param {string} unixPath
 */
export function assertUnixSocketSafe(unixPath) {
  if (typeof unixPath !== "string" || !unixPath) {
    throw new Error("unixPath required");
  }
  let st;
  try {
    st = fs.lstatSync(unixPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`unix socket missing: ${unixPath} (${msg})`);
  }
  if (typeof st.isSymbolicLink === "function" && st.isSymbolicLink()) {
    throw new Error("unix socket must not be a symlink");
  }
  if (typeof st.isSocket === "function" && !st.isSocket()) {
    throw new Error(`path is not a unix socket: ${unixPath}`);
  }
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (typeof st.uid === "number" && st.uid !== uid) {
      throw new Error(
        `unix socket owner mismatch: uid=${st.uid} expected=${uid}`
      );
    }
  }
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `unix socket mode must be 0600, got ${mode.toString(8).padStart(3, "0")}`
    );
  }
}

/**
 * Parse BRIDGE_GRANTS / BRIDGE_GRANT_WRITE / BRIDGE_GRANT_SHELL into known tiers.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function grantsFromEnv(env = process.env) {
  const out = new Set();
  const raw = env.BRIDGE_GRANTS || "";
  for (const part of raw.split(/[,;]/)) {
    const t = part.trim();
    if (t === "write" || t === "shell") out.add(t);
  }
  const w = (env.BRIDGE_GRANT_WRITE || "").trim().toLowerCase();
  if (w === "1" || w === "true" || w === "yes") out.add("write");
  const s = (env.BRIDGE_GRANT_SHELL || "").trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes") out.add("shell");
  return [...out];
}

export class BridgeClient {
  /** @param {BridgeClientOptions} opts */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ? opts.baseUrl.replace(/\/$/, "") : null;
    this.token = opts.token || process.env.BRIDGE_LOCAL_TOKEN || null;
    this.unixPath = opts.unixPath || process.env.BRIDGE_UNIX_PATH || null;
    if (!this.baseUrl && !this.unixPath) {
      throw new Error("BridgeClient requires baseUrl (TCP) or unixPath");
    }
    if (this.baseUrl && !this.unixPath && !this.token) {
      throw new Error(
        "BRIDGE_LOCAL_TOKEN required for TCP (copy token from bridge stdout)"
      );
    }
  }

  /**
   * POST /prompt — enqueue user text on the bridge FIFO.
   * @param {string} text
   * @param {string} [requestId]
   * @param {{ model?: string | {id: string, params?: Array<{id:string,value:string}>} }} [opts]
   */
  async prompt(text, requestId, opts = {}) {
    const payload = {
      text,
      request_id: requestId || `req-${Date.now()}`,
    };
    if (typeof opts.model === "string" && opts.model) {
      payload.model = opts.model;
    } else if (opts.model && typeof opts.model === "object" && opts.model.id) {
      payload.model = opts.model;
    }
    if (opts.mode === "summarize") {
      payload.mode = "summarize";
    }
    const body = JSON.stringify(payload);
    const res = await this._request("POST", "/prompt", body, {
      "Content-Type": "application/json",
    });
    if (res.statusCode !== 200) {
      throw new Error(`prompt HTTP ${res.statusCode}: ${res.body}`);
    }
    const json = JSON.parse(res.body || "{}");
    if (!json.ok) {
      throw new Error(`prompt rejected: ${json.error || "unknown"}`);
    }
    return json;
  }

  /**
   * POST /session — set workspace cwd (handshake before open/hello when bridge
   * was started without --cwd).
   * @param {{ cwd: string }} body
   */
  async setSession(body) {
    const payload = JSON.stringify(body || {});
    const res = await this._request("POST", "/session", payload, {
      "Content-Type": "application/json",
    });
    if (res.statusCode !== 200) {
      throw new Error(`session POST HTTP ${res.statusCode}: ${res.body}`);
    }
    const json = JSON.parse(res.body || "{}");
    if (!json.ok) {
      throw new Error(`session set rejected: ${json.error || "unknown"}`);
    }
    return json;
  }

  /**
   * GET /session — current cwd + ready flag.
   */
  async getSession() {
    const res = await this._request("GET", "/session", null, {});
    if (res.statusCode !== 200) {
      throw new Error(`session GET HTTP ${res.statusCode}: ${res.body}`);
    }
    return JSON.parse(res.body || "{}");
  }

  /**
   * GET /models — cached VPS catalog snapshot.
   */
  async getModels() {
    const res = await this._request("GET", "/models", null, {});
    if (res.statusCode !== 200) {
      throw new Error(`models GET HTTP ${res.statusCode}: ${res.body}`);
    }
    return JSON.parse(res.body || "{}");
  }

  /**
   * POST /models/refresh — request fresh models_catalog from VPS.
   * @param {{ force?: boolean }} [opts]
   */
  async refreshModels(opts = {}) {
    const body = JSON.stringify({ force: Boolean(opts.force) });
    const res = await this._request("POST", "/models/refresh", body, {
      "Content-Type": "application/json",
    });
    if (res.statusCode !== 200) {
      throw new Error(`models refresh HTTP ${res.statusCode}: ${res.body}`);
    }
    return JSON.parse(res.body || "{}");
  }

  /**
   * GET /mcp/tools — MCP tools currently advertised in hello.
   */
  async getMcpTools() {
    const res = await this._request("GET", "/mcp/tools", null, {});
    if (res.statusCode !== 200) {
      throw new Error(`mcp tools GET HTTP ${res.statusCode}: ${res.body}`);
    }
    return JSON.parse(res.body || "{}");
  }

  /**
   * POST /mcp/refresh — reconnect MCP + reopen VPS session.
   * @param {Record<string, unknown>} [body]
   */
  async refreshMcp(body = {}) {
    const payload = JSON.stringify(body || {});
    const res = await this._request("POST", "/mcp/refresh", payload, {
      "Content-Type": "application/json",
    });
    if (res.statusCode !== 200) {
      throw new Error(`mcp refresh HTTP ${res.statusCode}: ${res.body}`);
    }
    const json = JSON.parse(res.body || "{}");
    if (!json.ok) {
      throw new Error(`mcp refresh rejected: ${json.error || "unknown"}`);
    }
    return json;
  }

  /**
   * GET /permissions — current session grants on the bridge.
   * @returns {Promise<{ok: boolean, grants: string[]}>}
   */
  async getPermissions() {
    const res = await this._request("GET", "/permissions", null, {});
    if (res.statusCode !== 200) {
      throw new Error(`permissions GET HTTP ${res.statusCode}: ${res.body}`);
    }
    const json = JSON.parse(res.body || "{}");
    if (!json.ok) {
      throw new Error(`permissions get rejected: ${json.error || "unknown"}`);
    }
    return json;
  }

  /**
   * POST /permissions — grant and/or revoke tiers (v1: write).
   * @param {{ grant?: string[], revoke?: string[] }} body
   * @returns {Promise<{ok: boolean, grants: string[]}>}
   */
  async setPermissions(body) {
    const payload = JSON.stringify(body || {});
    const res = await this._request("POST", "/permissions", payload, {
      "Content-Type": "application/json",
    });
    if (res.statusCode !== 200) {
      throw new Error(`permissions POST HTTP ${res.statusCode}: ${res.body}`);
    }
    const json = JSON.parse(res.body || "{}");
    if (!json.ok) {
      throw new Error(`permissions set rejected: ${json.error || "unknown"}`);
    }
    return json;
  }

  /**
   * POST /cancel — stop the in-flight VPS run (ESC / /stop). Idempotent.
   * @param {{ run_id?: string, request_id?: string }} [body]
   */
  async cancel(body = {}) {
    const payload = JSON.stringify(body || {});
    const res = await this._request("POST", "/cancel", payload, {
      "Content-Type": "application/json",
    });
    if (res.statusCode !== 200) {
      throw new Error(`cancel HTTP ${res.statusCode}: ${res.body}`);
    }
    const json = JSON.parse(res.body || "{}");
    if (!json.ok) {
      throw new Error(`cancel rejected: ${json.error || "unknown"}`);
    }
    return json;
  }

  /**
   * GET /events — async iterator of parsed SSE `data:` JSON objects.
   * @param {AbortSignal} [signal]
   */
  async *events(signal) {
    const stream = await this._openEventStream(signal);
    let buf = "";
    for await (const chunk of stream) {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) {
            yield JSON.parse(line.slice(6));
          }
        }
      }
    }
  }

  /**
   * Collect events until a terminal type or timeout.
   * @param {AbortSignal} [signal]
   * @param {number} [timeoutMs]
   * @param {(ev: object) => void} [onEvent] called as each SSE event arrives
   * @param {{
   *   isTerminal?: (ev: object, state: { awaitingToolExec: Set<string> }) => boolean,
   * }} [opts]
   */
  async collectUntilTerminal(signal, timeoutMs = 15000, onEvent, opts = {}) {
    const out = [];
    const awaitingToolExec = new Set();
    let sawRunFinished = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const defaultTerminal = (ev) => {
      const t = ev?.type;
      if (t === "run_error" || t === "session_end") return true;
      if (t === "run_finished") {
        sawRunFinished = true;
        return awaitingToolExec.size === 0;
      }
      // Late tool_executed after run_finished (upload race).
      if (sawRunFinished && awaitingToolExec.size === 0) return true;
      return false;
    };
    const isTerminal = opts.isTerminal || defaultTerminal;
    try {
      for await (const ev of this.events(ac.signal)) {
        out.push(ev);
        if (ev?.type === "tool_call") {
          const id = typeof ev.call_id === "string" ? ev.call_id : "";
          if (id) awaitingToolExec.add(id);
        } else if (ev?.type === "tool_executed") {
          const id = typeof ev.call_id === "string" ? ev.call_id : "";
          if (id) awaitingToolExec.delete(id);
        }
        if (typeof onEvent === "function") onEvent(ev);
        if (isTerminal(ev, { awaitingToolExec })) {
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    return out;
  }

  _headers(extra = {}) {
    const h = { ...extra };
    if (this.token && this.baseUrl) {
      h.Authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  _request(method, path, body, headers) {
    return new Promise((resolve, reject) => {
      const opts = {
        method,
        path,
        headers: this._headers({
          ...headers,
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        }),
      };
      /** @type {typeof httpRequest} */
      let reqFn;
      if (this.unixPath) {
        assertUnixSocketSafe(this.unixPath);
        opts.socketPath = this.unixPath;
        opts.host = "localhost";
        reqFn = httpRequest;
      } else {
        const u = new URL(this.baseUrl + path);
        opts.hostname = u.hostname;
        opts.port = u.port;
        opts.path = u.pathname + u.search;
        reqFn = u.protocol === "https:" ? httpsRequest : httpRequest;
      }
      const req = reqFn(opts, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  _openEventStream(signal) {
    return new Promise((resolve, reject) => {
      const opts = {
        method: "GET",
        path: "/events",
        headers: this._headers({ Accept: "text/event-stream" }),
      };
      let reqFn;
      if (this.unixPath) {
        assertUnixSocketSafe(this.unixPath);
        opts.socketPath = this.unixPath;
        opts.host = "localhost";
        reqFn = httpRequest;
      } else {
        const u = new URL(this.baseUrl + "/events");
        opts.hostname = u.hostname;
        opts.port = u.port;
        opts.path = u.pathname;
        reqFn = u.protocol === "https:" ? httpsRequest : httpRequest;
      }
      const req = reqFn(opts, (res) => {
        if ((res.statusCode || 0) >= 400) {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8").slice(0, 200);
            reject(
              new Error(
                `events HTTP ${res.statusCode}${body ? `: ${body}` : ""}` +
                  (res.statusCode === 401
                    ? " — check BRIDGE_LOCAL_TOKEN matches bridge stdout"
                    : "")
              )
            );
          });
          return;
        }
        resolve(res);
      });
      req.on("error", reject);
      if (signal) {
        if (signal.aborted) {
          req.destroy();
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            req.destroy();
          },
          { once: true }
        );
      }
      req.end();
    });
  }
}

/**
 * Resolve pi workspace cwd for bridge handshake.
 * @param {{ sessionManager?: { getCwd?: () => string } } | null | undefined} ctx
 * @returns {string}
 */
export function resolveWorkspaceCwd(ctx) {
  const fromSm =
    typeof ctx?.sessionManager?.getCwd === "function"
      ? ctx.sessionManager.getCwd()
      : null;
  if (typeof fromSm === "string" && fromSm.trim()) {
    return fromSm.trim();
  }
  return process.cwd();
}

/**
 * POST workspace cwd to local-bridge (open/hello metadata + tool root).
 * @param {BridgeClient} client
 * @param {{ sessionManager?: { getCwd?: () => string } } | null | undefined} ctx
 * @param {{ ui?: { notify?: (msg: string, level?: string) => void } } | null | undefined} [uiCtx]
 */
export async function handshakeWorkspaceCwd(client, ctx, uiCtx) {
  const cwd = resolveWorkspaceCwd(ctx);
  try {
    return await client.setSession({ cwd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (typeof uiCtx?.ui?.notify === "function") {
      uiCtx.ui.notify(`Workspace cwd handshake failed: ${msg}`, "warning");
    }
    throw err;
  }
}

/**
 * Apply env-derived grants on the bridge (fail closed).
 * @param {BridgeClient} client
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string[]>} grants after apply (empty if none requested)
 */
export async function applyEnvGrants(client, env = process.env) {
  const wanted = grantsFromEnv(env);
  if (!wanted.length) return [];
  const res = await client.setPermissions({ grant: wanted });
  return Array.isArray(res.grants) ? res.grants : wanted;
}

/** Max physical TUI lines for a tool_call header (then a "more" hint). */
export const TOOL_CALL_PREVIEW_LINES = 12;

/**
 * Unwrap SDK/MCP envelopes `{toolName, args:{…}}` without touching string whitespace.
 * @param {unknown} args
 * @returns {Record<string, unknown>}
 */
export function unwrapToolArgs(args) {
  let obj = args;
  if (obj == null) return {};
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (typeof obj !== "object" || Array.isArray(obj)) return {};
  const o = /** @type {Record<string, unknown>} */ (obj);
  const nested = o.args;
  const wrapper =
    "toolName" in o ||
    "tool_name" in o ||
    o.providerIdentifier === "custom-user-tools" ||
    o.provider_identifier === "custom-user-tools";
  if (wrapper && nested && typeof nested === "object" && !Array.isArray(nested)) {
    return /** @type {Record<string, unknown>} */ (nested);
  }
  if (wrapper && typeof nested === "string") {
    try {
      const parsed = JSON.parse(nested);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      return o;
    }
  }
  return o;
}

export { wrapToWidth };

/**
 * Map logical tool-panel lines → TUI rows: one array entry per painted row.
 * Empty heredoc lines become a single space so Box can fill toolSuccessBg.
 * @param {string | string[]} lines
 * @param {number} [width]
 * @param {{ maxLines?: number }} [opts]
 * @returns {string[]}
 */
export function layoutToolPanelLines(lines, width = 0, opts = {}) {
  const src = Array.isArray(lines) ? lines : [lines];
  /** @type {string[]} */
  const logical = [];
  for (const item of src) {
    for (const part of String(item ?? "").split(LINE_BREAK_RE)) {
      logical.push(part);
    }
  }
  const w = typeof width === "number" && width > 0 ? width : 0;
  /** @type {string[]} */
  const physical = [];
  for (const line of logical) {
    const chunks = w > 0 ? wrapToWidth(line, w) : [line];
    for (const chunk of chunks) {
      const clean = String(chunk).replace(/[\r\n]/g, "");
      physical.push(clean.length ? clean : " ");
    }
  }
  if (!physical.length) physical.push(" ");
  const maxLines = opts.maxLines;
  if (maxLines && physical.length > maxLines) {
    const skipped = physical.length - maxLines;
    const hint = `… (${skipped} more lines)`;
    const extra = w > 0 ? wrapToWidth(hint, w) : [hint];
    return [...physical.slice(0, maxLines), ...extra];
  }
  return physical;
}

/**
 * Format contour tool args for TUI (keep newlines; unwrap MCP envelopes).
 * @param {unknown} args
 */
export function formatToolArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const o = Array.isArray(args)
    ? /** @type {Record<string, unknown>} */ ({})
    : unwrapToolArgs(args);
  if (Array.isArray(args)) {
    try {
      const s = JSON.stringify(args);
      return s.length > 240 ? s.slice(0, 240) + "…" : s;
    } catch {
      return "";
    }
  }
  // contour__shell — show command like local bash UI
  if (typeof o.command === "string" && Object.keys(o).length <= 3) {
    return o.command;
  }
  // contour__grep — pattern [path]
  if (typeof o.pattern === "string") {
    const extra = typeof o.path === "string" && o.path ? ` ${o.path}` : "";
    return o.pattern + extra;
  }
  if (typeof o.path === "string" && Object.keys(o).length <= 3) {
    return o.path;
  }
  try {
    const s = JSON.stringify(o);
    return s.length > 240 ? s.slice(0, 240) + "…" : s;
  } catch {
    return "";
  }
}

/**
 * Multi-line tool_call header for pi TUI (sed scripts, write_file body).
 * Pass `width` from render() so long one-liners wrap instead of ending in `…`.
 * @param {string} displayName
 * @param {unknown} args
 * @param {{ maxLines?: number, width?: number }} [opts]
 * @returns {string[]}
 */
export function formatToolCallLines(displayName, args, opts = {}) {
  const maxLines = opts.maxLines ?? TOOL_CALL_PREVIEW_LINES;
  const width = opts.width;
  const o = unwrapToolArgs(args);
  const shell = displayName === "shell";
  const prefix = shell ? "$ " : `$ ${displayName} `;
  /** @type {string[]} */
  let logical = [];
  if (typeof o.command === "string") {
    const parts = o.command.split(LINE_BREAK_RE);
    logical = parts.map((p, i) => (i === 0 ? `${prefix}${p}` : p));
  } else if (typeof o.path === "string" && typeof o.old_string === "string") {
    const neu = typeof o.new_string === "string" ? o.new_string : "";
    const oldLines = o.old_string.split(LINE_BREAK_RE);
    const newLines = neu.split(LINE_BREAK_RE);
    logical = [
      `${prefix}${o.path}`,
      ...oldLines.map((p, i) => (i === 0 ? `- ${p}` : p)),
      ...newLines.map((p, i) => (i === 0 ? `+ ${p}` : p)),
    ];
  } else if (typeof o.path === "string" && typeof o.content === "string") {
    logical = [`${prefix}${o.path}`, ...o.content.split(LINE_BREAK_RE)];
  } else {
    const raw = formatToolArgs(args);
    if (!raw) logical = [`$ ${displayName}`];
    else {
      const parts = String(raw).split(LINE_BREAK_RE);
      logical = parts.map((p, i) => (i === 0 ? `${prefix}${p}` : p));
    }
  }
  if (!logical.length) logical.push(`$ ${displayName}`);
  return layoutToolPanelLines(logical, width, { maxLines });
}

/**
 * Format tool result preview for TUI.
 * Unwraps common {output|stdout|content|text|result|message} shapes.
 * @param {unknown} content
 * @param {boolean} [ok]
 */
export function formatToolResult(content, ok = true) {
  let body = "";
  if (typeof content === "string") {
    body = content;
  } else if (Array.isArray(content)) {
    body = content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && typeof b.text === "string") return b.text;
        try {
          return JSON.stringify(b);
        } catch {
          return String(b);
        }
      })
      .join("\n");
  } else if (content != null && typeof content === "object") {
    const o = /** @type {Record<string, unknown>} */ (content);
    for (const k of ["output", "stdout", "text", "message", "result", "content"]) {
      if (typeof o[k] === "string") {
        body = o[k];
        break;
      }
    }
    if (!body) {
      try {
        body = JSON.stringify(content, null, 0);
      } catch {
        body = String(content);
      }
    }
  } else if (content != null) {
    body = String(content);
  }
  if (body.length > 4000) body = body.slice(0, 4000) + "\n…";
  if (!ok && !body) body = "(failed)";
  return body;
}

/**
 * Empty Usage matching @earendil-works/pi-ai (footer requires usage.input / usage.cost.total).
 */
export function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Map bridge SSE events → pi-ai-like stream pushes (no pi-ai dependency).
 *
 * Like stock pi-cursor-sdk: end a stream turn at each tool batch (`done` /
 * `toolUse`) so pi paints ToolExecution panels immediately, keep SSE open,
 * then resume on the next `streamSimple` without a new prompt. Post-tool
 * thinking/text land in the following turn (below the tool panels).
 *
 * @param {BridgeClient} client
 * @param {string} text
 * @param {{
 *   signal?: AbortSignal,
 *   requestId?: string,
 *   onEvent?: (ev: object) => void,
 *   onStreamEvent?: (ev: object) => void,
 *   applyGrants?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   model?: { id?: string, api?: string, provider?: string, contextWindow?: number, maxTokens?: number },
 *   modelSelection?: { id: string, params?: Array<{id:string,value:string}> },
 *   thinkingDisplay?: "off"|"indicator"|"full",
 *   wireStats?: "session"|"request",
 *   onThinkingIndicator?: (active: boolean) => void,
 *   mode?: "summarize",
 *   rejectTools?: boolean,
 * }} [opts]
 */
export async function runPromptViaBridge(client, text, opts = {}) {
  clearToolResults();
  setFollowUp(null);
  clearThinkingIndicator();
  clearWireStatus();
  clearLiveRun();

  let grants = [];
  if (opts.applyGrants !== false) {
    grants = await applyEnvGrants(client, opts.env || process.env);
  }

  const session = startLiveEventFeeder(
    client,
    opts.signal,
    opts.timeoutMs ?? 600_000
  );
  await new Promise((r) => setTimeout(r, 30));
  const model = opts.model || {};
  const promptChars = typeof text === "string" ? text.length : 0;
  await client.prompt(text, opts.requestId, {
    model:
      opts.modelSelection ||
      (typeof model.id === "string" ? model.id : undefined),
    mode: opts.mode,
  });

  const result = await drainLiveRunTurn({
    ...opts,
    _promptChars: promptChars,
  });
  return { ...result, grants };
}

/**
 * Continue an open bridge SSE session (next pi agent turn after toolUse).
 * @param {Parameters<typeof runPromptViaBridge>[2]} [opts]
 */
export async function resumeBridgeLiveTurn(opts = {}) {
  if (!hasActiveLiveRun()) {
    throw new Error("no active bridge live run to resume");
  }
  return drainLiveRunTurn(opts);
}

/**
 * Drain until the live run is fully finished (for smokes / non-TUI callers).
 * @param {BridgeClient} client
 * @param {string} text
 * @param {Parameters<typeof runPromptViaBridge>[2]} [opts]
 */
export async function runPromptViaBridgeComplete(client, text, opts = {}) {
  let result = await runPromptViaBridge(client, text, opts);
  const allEvents = [...(result.events || [])];
  const grants = result.grants;
  while (hasActiveLiveRun()) {
    result = await resumeBridgeLiveTurn(opts);
    allEvents.push(...(result.events || []));
  }
  return { ...result, events: allEvents, grants };
}

export { hasActiveLiveRun, getActiveLiveRun, clearLiveRun };

/**
 * @param {Parameters<typeof runPromptViaBridge>[2] & { _promptChars?: number }} opts
 */
async function drainLiveRunTurn(opts = {}) {
  const session = getActiveLiveRun();
  if (!session) {
    throw new Error("no active bridge live run");
  }

  const onResumeAbort = () => {
    if (typeof session.requestCancel === "function") session.requestCancel();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onResumeAbort();
    else opts.signal.addEventListener("abort", onResumeAbort, { once: true });
  }

  const thinkingDisplay = coerceThinkingDisplay(
    opts.thinkingDisplay ?? THINKING_DISPLAY_DEFAULT
  );
  const wireStats = coerceWireStats(opts.wireStats ?? WIRE_STATS_DEFAULT);
  const notifyIndicator = (active) => {
    if (thinkingDisplay !== "indicator") return;
    if (typeof opts.onThinkingIndicator === "function") {
      opts.onThinkingIndicator(active);
    } else if (active) {
      showThinkingIndicator();
    } else {
      clearThinkingIndicator();
    }
  };

  const pushed = [];
  const stream = {
    push(ev) {
      pushed.push(ev);
      if (typeof opts.onStreamEvent === "function") opts.onStreamEvent(ev);
    },
    end() {
      pushed.push({ type: "_end" });
    },
    get events() {
      return pushed;
    },
  };

  const model = opts.model || {};
  const promptChars = Number(opts._promptChars) || 0;
  const output = {
    role: "assistant",
    content: [],
    api: model.api || "cursor-remote-bridge",
    provider: model.provider || "cursor-remote",
    model: model.id || DEFAULT_MODEL,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  output.usage.input = Math.max(1, Math.ceil(promptChars / 4) || 1);
  output.usage.totalTokens = output.usage.input;
  stream.push({ type: "start", partial: output });

  /** @type {number | null} */
  let textIndex = null;
  let textBuf = "";
  /** @type {number | null} */
  let thinkingIndex = null;
  let thinkingBuf = "";
  let toolsThisTurn = 0;
  /** @type {Set<string>} */
  const pendingExec = new Set();
  /** @type {number | null} */
  let firstOutAt = null;
  const turnRaw = [];
  let finished = false;
  /** @type {object[]} Post-tool events held while tool_executed still pending (run_finished race). */
  const deferredBoundary = [];

  const markOut = () => {
    if (firstOutAt == null) firstOutAt = Date.now();
    session.markFirstOut?.();
  };

  const maybeRecordDecodeSpeed = () => {
    if (session.decodeSampleRecorded) return;
    const start = session.firstOutAt;
    if (start == null) return;
    const tokens = Number(output.usage?.output) || 0;
    const decodeMs = Math.max(1, Date.now() - start);
    if (tokens <= 0) return;
    session.decodeSampleRecorded = true;
    recordDecodeSample(tokens, decodeMs);
  };

  const outChars = () =>
    thinkingBuf.length +
    textBuf.length +
    output.content.reduce((acc, c) => {
      if (c.type === "text") return acc + (c.text?.length || 0);
      if (c.type === "thinking") return acc + (c.thinking?.length || 0);
      return acc;
    }, 0);

  const bumpUsage = () => {
    const n = outChars();
    output.usage.output = Math.max(1, Math.ceil(n / 4));
    output.usage.totalTokens = output.usage.input + output.usage.output;
  };

  /** @param {object} ev */
  const applyWireStats = (ev) => {
    const useSession = wireStats === "session";
    const up = useSession
      ? Number(ev.proxy_up_total) || Number(ev.proxy_up_bytes) || 0
      : Number(ev.proxy_up_bytes) || 0;
    const down = useSession
      ? Number(ev.proxy_down_total) || Number(ev.proxy_down_bytes) || 0
      : Number(ev.proxy_down_bytes) || 0;
    const gets = useSession
      ? Number(ev.proxy_gets_total) || Number(ev.proxy_gets) || 0
      : Number(ev.proxy_gets) || 0;
    const durationMs = Number(ev.duration_ms) || 0;
    const chars = outChars();
    let cps = 0;
    if (firstOutAt != null) {
      const elapsed = Math.max(1, Date.now() - firstOutAt);
      cps = (chars * 1000) / elapsed;
    } else if (durationMs > 0 && chars > 0) {
      cps = (chars * 1000) / durationMs;
    }
    setWireStatus({
      scope: wireStats,
      proxy_up_bytes: up,
      proxy_down_bytes: down,
      proxy_gets: gets,
      chars_per_sec: cps,
      duration_ms: durationMs,
      out_chars: chars,
    });
  };

  const endThinkingBlock = () => {
    if (thinkingIndex == null) return;
    stream.push({
      type: "thinking_end",
      contentIndex: thinkingIndex,
      content: thinkingBuf,
      partial: output,
    });
    thinkingIndex = null;
    thinkingBuf = "";
  };

  const endTextBlock = () => {
    if (textIndex == null) return;
    stream.push({
      type: "text_end",
      contentIndex: textIndex,
      content: textBuf,
      partial: output,
    });
    textIndex = null;
    textBuf = "";
  };

  /** @param {string} chunk */
  const appendThinking = (chunk) => {
    if (!chunk || thinkingDisplay !== "full") return;
    if (thinkingIndex == null) {
      endTextBlock();
      thinkingIndex = output.content.length;
      thinkingBuf = "";
      output.content.push({ type: "thinking", thinking: "" });
      stream.push({
        type: "thinking_start",
        contentIndex: thinkingIndex,
        partial: output,
      });
    }
    const before = thinkingBuf;
    thinkingBuf = joinThinkingChunk(thinkingBuf, chunk);
    const delta = thinkingBuf.slice(before.length);
    if (!delta) return;
    output.content[thinkingIndex].thinking = thinkingBuf;
    markOut();
    bumpUsage();
    stream.push({
      type: "thinking_delta",
      contentIndex: thinkingIndex,
      delta,
      partial: output,
    });
  };

  /** @param {string} chunk */
  const appendText = (chunk) => {
    if (!chunk) return;
    endThinkingBlock();
    notifyIndicator(false);
    if (textIndex == null) {
      textIndex = output.content.length;
      textBuf = "";
      output.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
    }
    textBuf += chunk;
    output.content[textIndex].text = textBuf;
    markOut();
    bumpUsage();
    stream.push({
      type: "text_delta",
      contentIndex: textIndex,
      delta: chunk,
      partial: output,
    });
  };

  /** Visible cancel / service lines in the assistant transcript. */
  const appendStatusLine = (line) => {
    const chunk = `${textBuf && !textBuf.endsWith("\n") ? "\n" : ""}${line}\n`;
    appendText(chunk);
  };

  /**
   * @param {string} wireName
   * @param {string} callId
   * @param {Record<string, unknown>} args
   */
  const emitToolCall = (wireName, callId, args) => {
    endThinkingBlock();
    endTextBlock();
    notifyIndicator(false);
    markOut();
    const name = displayToolName(wireName);
    const id =
      (typeof callId === "string" && callId) ||
      `call-${Date.now().toString(36)}-${output.content.length}`;
    trackCallId(name, id);
    const contentIndex = output.content.length;
    const toolCall = {
      type: "toolCall",
      id,
      name,
      arguments: args && typeof args === "object" ? args : {},
    };
    output.content.push(toolCall);
    toolsThisTurn += 1;
    if (typeof callId === "string" && callId) pendingExec.add(callId);
    bumpUsage();
    stream.push({ type: "toolcall_start", contentIndex, partial: output });
    stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall,
      partial: output,
    });
  };

  /** @param {string} reason */
  const finishTurn = (reason) => {
    if (finished) return;
    finished = true;
    endThinkingBlock();
    endTextBlock();
    notifyIndicator(false);
    output.stopReason = reason;
    if (reason === "error" || reason === "aborted") {
      setFollowUp(null);
      clearLiveRun();
      stream.push({ type: "error", reason, error: output });
    } else {
      stream.push({ type: "done", reason, message: output });
      if (reason === "stop") {
        clearLiveRun();
      }
    }
    stream.end();
  };

  /**
   * After a tool batch is complete, end the turn so pi can execute shadows.
   * @returns {Promise<boolean>}
   */
  const flushDeferredBoundary = () => {
    for (let i = deferredBoundary.length - 1; i >= 0; i--) {
      session.unshift(deferredBoundary[i]);
    }
    deferredBoundary.length = 0;
  };

  const tryEndToolBatch = async () => {
    if (toolsThisTurn <= 0 || pendingExec.size > 0) return false;
    await settleToolBatch();
    while (session.peek()?.type === "tool_call") {
      const next = await session.nextEvent();
      if (!next) break;
      turnRaw.push(next);
      handleEvent(next);
    }
    if (pendingExec.size > 0) return false;
    flushDeferredBoundary();
    finishTurn("toolUse");
    return true;
  };

  /** @param {object} ev */
  function handleEvent(ev) {
    if (typeof opts.onEvent === "function") opts.onEvent(ev);
    if (ev.type === "thinking_start") {
      if (thinkingDisplay === "indicator") {
        notifyIndicator(true);
      } else if (thinkingDisplay === "full" && thinkingIndex == null) {
        endTextBlock();
        thinkingIndex = output.content.length;
        thinkingBuf = "";
        output.content.push({ type: "thinking", thinking: "" });
        stream.push({
          type: "thinking_start",
          contentIndex: thinkingIndex,
          partial: output,
        });
      }
    } else if (ev.type === "thinking_delta" && typeof ev.text === "string") {
      appendThinking(ev.text);
    } else if (ev.type === "thinking_end") {
      // Soft end — coalesce consecutive SDK thoughts into one block.
    } else if (ev.type === "assistant_delta" && typeof ev.text === "string") {
      appendText(ev.text);
    } else if (ev.type === "assistant_message" && typeof ev.text === "string") {
      if (!textBuf) {
        appendText(ev.text);
      } else if (!textBuf.includes(ev.text)) {
        appendText((textBuf.endsWith("\n") ? "" : "\n") + ev.text);
      }
    } else if (ev.type === "tool_call") {
      if (opts.rejectTools) {
        throw new Error("Summarization attempted to call a tool");
      }
      const wireName = typeof ev.name === "string" ? ev.name : "tool";
      const callId = typeof ev.call_id === "string" ? ev.call_id : "";
      const args =
        ev.arguments && typeof ev.arguments === "object" ? ev.arguments : {};
      emitToolCall(wireName, callId, /** @type {Record<string, unknown>} */ (args));
    } else if (ev.type === "tool_executed") {
      const callId = typeof ev.call_id === "string" ? ev.call_id : "";
      const wireName = typeof ev.name === "string" ? ev.name : "";
      const display = displayToolName(wireName || "tool");
      const id =
        callId ||
        `exec-${Date.now().toString(36)}-${output.content.filter((c) => c.type === "toolCall").length}`;
      trackCallId(display, id);
      if (callId) pendingExec.delete(callId);
      stashToolResult(id, {
        ok: ev.ok !== false,
        content: ev.content,
        name: wireName || undefined,
        displayName: display,
      });
    } else if (ev.type === "run_finished") {
      endThinkingBlock();
      notifyIndicator(false);
      if (!tryApplyWireUsage(output, ev.usage, model)) {
        bumpUsage();
      }
      applyWireStats(ev);
      maybeRecordDecodeSpeed();
    } else if (ev.type === "run_error") {
      endThinkingBlock();
      notifyIndicator(false);
      output.stopReason = "error";
      applyWireStats(ev);
      const kind = ev.kind || "run_error";
      if (kind === "policy") {
        const tn = ev.tool_name || "built-in/unknown";
        const hint = ev.message || ev.redirect_to;
        output.errorMessage = hint
          ? `policy: ${hint}`
          : `policy: blocked tool "${tn}" — use only contour__* tools ` +
            "(list_dir/read_file/write_file/str_replace/mkdir/delete_path/shell/ping)";
      } else if (kind === "cancelled") {
        appendStatusLine("[cancel] VPS confirmed — run stopped");
        output.stopReason = "aborted";
        output.errorMessage = "cancelled (VPS confirmed)";
      } else {
        output.errorMessage = ev.message ? `${kind}: ${ev.message}` : kind;
      }
    } else if (ev.type === "cancel_ack") {
      const phase = ev.phase || "";
      if (phase === "uplink_ok" || ev.uplink) {
        appendStatusLine("[cancel] sent to VPS");
      } else if (phase === "uplink_failed") {
        appendStatusLine(`[cancel] uplink failed (${ev.error || "error"})`);
      } else if (phase === "sent") {
        appendStatusLine("[cancel] sending…");
      }
    } else if (ev.type === "session_end") {
      endThinkingBlock();
      notifyIndicator(false);
      output.stopReason = "error";
      const detail = ev.detail ? `:${ev.detail}` : "";
      output.errorMessage = `session_end:${ev.reason || ""}${detail}`;
    }
  }

  try {
    while (!finished) {
      const ev = await session.nextEvent();
      if (!ev) {
        flushDeferredBoundary();
        if (toolsThisTurn > 0) {
          finishTurn("toolUse");
        } else if (session.error) {
          output.errorMessage = session.error.message;
          finishTurn("error");
        } else if (output.content.some((c) => c.type === "text" || c.type === "thinking")) {
          finishTurn("stop");
        } else {
          output.errorMessage = "stream ended without terminal";
          finishTurn("error");
        }
        break;
      }

      // Tool batch already emitted: post-tool thinking/text belong on the next turn.
      // If tool_executed is still pending (run_finished race), buffer until stash is ready.
      // Terminals (cancel / session_end) must not wait — local tools may never finish.
      if (
        toolsThisTurn > 0 &&
        isPostToolBoundaryEvent(ev) &&
        ev.type !== "run_error" &&
        ev.type !== "session_end"
      ) {
        if (pendingExec.size > 0) {
          deferredBoundary.push(ev);
          continue;
        }
        session.unshift(ev);
        flushDeferredBoundary();
        finishTurn("toolUse");
        break;
      }

      turnRaw.push(ev);
      handleEvent(ev);

      if (output.stopReason === "error" || output.stopReason === "aborted") {
        finishTurn(output.stopReason);
        break;
      }

      if (ev.type === "tool_call") {
        await settleToolBatch();
        while (session.peek()?.type === "tool_call") {
          const next = await session.nextEvent();
          if (!next) break;
          if (toolsThisTurn > 0 && isPostToolBoundaryEvent(next)) {
            if (pendingExec.size > 0) {
              deferredBoundary.push(next);
            } else {
              session.unshift(next);
              break;
            }
            break;
          }
          turnRaw.push(next);
          handleEvent(next);
        }
        if (await tryEndToolBatch()) break;
        continue;
      }

      if (ev.type === "tool_executed") {
        if (await tryEndToolBatch()) break;
        continue;
      }

      if (ev.type === "run_finished") {
        finishTurn(toolsThisTurn > 0 ? "toolUse" : "stop");
        break;
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      output.errorMessage = err instanceof Error ? err.message : String(err);
      finishTurn("aborted");
    } else {
      output.errorMessage = err instanceof Error ? err.message : String(err);
      finishTurn("error");
    }
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onResumeAbort);
  }

  return {
    stream,
    events: turnRaw,
    output,
    grants: [],
  };
}
