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
  markToolCallStarted,
  trackCallId,
  setFollowUp,
} from "./result-stash.js";
import { coerceThinkingDisplay, THINKING_DISPLAY_DEFAULT, coerceWireStats, WIRE_STATS_DEFAULT, DEFAULT_MODEL } from "./config.js";
import {
  showThinkingIndicator,
  clearThinkingIndicator,
  setWireStatus,
  clearWireStatus,
  pokeUiKeepAlive,
} from "./thinking-indicator.js";
import {
  tryApplyWireUsage,
  formatRequestStatsLine,
  quoteRequestStatsLine,
} from "./usage-accounting.js";
import { wrapToWidth, LINE_BREAK_RE } from "./tui-width.js";
import {
  clearLiveRun,
  getActiveLiveRun,
  hasActiveLiveRun,
  isPostToolBoundaryEvent,
  sessionHasQueuedWork,
  setDrainBusy,
  settleToolBatch,
  startLiveEventFeeder,
  waitUntilDrainIdle,
  waitWhileSummarizeBusy,
  LIVE_RUN_IDLE_MS,
} from "./live-run.js";
import { recordDecodeSample } from "./generation-speed.js";
import { sleepAbortable } from "./sse-reconnect.js";

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
   * @param {{ run_id?: string, request_id?: string, mode?: "summarize" }} [body]
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
   * @param {{ after?: number, catchup?: boolean }} [opts] replay cursor; catchup replays buffer
   */
  async *events(signal, opts = {}) {
    const after = Number(opts.after) > 0 ? Math.floor(Number(opts.after)) : 0;
    const catchup = Boolean(opts.catchup) || after > 0;
    const stream = await this._openEventStream(signal, { after, catchup });
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

  _openEventStream(signal, opts = {}) {
    const after = Number(opts.after) > 0 ? Math.floor(Number(opts.after)) : 0;
    const catchup = Boolean(opts.catchup) || after > 0;
    const qs = [];
    if (after > 0) qs.push(`after=${after}`);
    if (catchup) qs.push("catchup=1");
    const eventsPath = qs.length ? `/events?${qs.join("&")}` : "/events";
    return new Promise((resolve, reject) => {
      const reqOpts = {
        method: "GET",
        path: eventsPath,
        headers: this._headers({ Accept: "text/event-stream" }),
      };
      let reqFn;
      if (this.unixPath) {
        assertUnixSocketSafe(this.unixPath);
        reqOpts.socketPath = this.unixPath;
        reqOpts.host = "localhost";
        reqFn = httpRequest;
      } else {
        const u = new URL(this.baseUrl + eventsPath);
        reqOpts.hostname = u.hostname;
        reqOpts.port = u.port;
        reqOpts.path = u.pathname + u.search;
        reqFn = u.protocol === "https:" ? httpsRequest : httpRequest;
      }
      const req = reqFn(reqOpts, (res) => {
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

/** Max physical TUI lines for a collapsed tool_call header (then a Ctrl+O hint). */
export const TOOL_CALL_PREVIEW_LINES = 20;
/** Max physical TUI lines after Ctrl+O expands the call header. */
export const TOOL_CALL_EXPAND_LINES = 200;

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

/** `-78 content` / `+78 content` / ` 75 content` (stock pi-cursor-sdk). */
const DIFF_NUMBERED_RE = /^([+\- ]\d+ )/;
/** Legacy `- content` / `+ content` from args preview. */
const DIFF_LEGACY_RE = /^([+\-] )/;

/**
 * Columns to hang-wrap so wrapped diff rows keep the +/- / line-number gutter.
 * @param {string} line
 * @returns {number}
 */
export function diffLineHangWidth(line) {
  const s = String(line ?? "");
  const m = DIFF_NUMBERED_RE.exec(s) || DIFF_LEGACY_RE.exec(s);
  return m ? m[1].length : 0;
}

/**
 * Map logical tool-panel lines → TUI rows: one array entry per painted row.
 * Empty heredoc lines become a single space so Box can fill toolSuccessBg.
 * Diff lines hang-wrap so continuation rows stay in the content column.
 * @param {string | string[]} lines
 * @param {number} [width]
 * @param {{ maxLines?: number, expandHint?: boolean }} [opts]
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
    const hang = w > 0 ? diffLineHangWidth(line) : 0;
    const chunks = w > 0 ? wrapToWidth(line, w, hang ? { hang } : undefined) : [line];
    for (const chunk of chunks) {
      const clean = String(chunk).replace(/[\r\n]/g, "");
      physical.push(clean.length ? clean : " ");
    }
  }
  if (!physical.length) physical.push(" ");
  const maxLines = opts.maxLines;
  if (maxLines && physical.length > maxLines) {
    const skipped = physical.length - maxLines;
    const hint = opts.expandHint
      ? `... (${skipped} more lines, Ctrl+O to expand)`
      : `… (${skipped} more lines)`;
    const extra = w > 0 ? wrapToWidth(hint, w) : [hint];
    return [...physical.slice(0, maxLines), ...extra];
  }
  return physical;
}

/**
 * @param {...unknown} vals
 * @returns {string}
 */
function firstNonEmptyString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/**
 * @param {string} p
 * @returns {string}
 */
function shortenHomePath(p) {
  if (typeof p !== "string" || !p) return p || "";
  const home = process.env.HOME;
  if (
    home &&
    (p === home || p.startsWith(`${home}/`) || p.startsWith(`${home}\\`))
  ) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

/**
 * @param {unknown} pattern
 * @returns {string}
 */
function formatRegexSlash(pattern) {
  return `/${String(pattern ?? "").replace(/\//g, "\\/")}/`;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isWebSearchName(name) {
  return /web_?search/i.test(name);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isWebFetchName(name) {
  return /web_?fetch/i.test(name);
}

/**
 * One grep/find hit as `path:line:text` (pi grep renderer).
 * @param {unknown} item
 * @returns {string}
 */
function formatMatchLine(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (item);
  const path = firstNonEmptyString(o.path, o.file, o.filename);
  const text =
    typeof o.text === "string"
      ? o.text
      : typeof o.content === "string"
        ? o.content
        : typeof o.line === "string"
          ? o.line
          : "";
  const lineNo =
    o.line_number ??
    o.lineNumber ??
    (typeof o.line === "number" ? o.line : undefined);
  if (path && text) {
    const loc = lineNo != null ? `${path}:${lineNo}:` : `${path}:`;
    return `${loc}${text}`;
  }
  if (path && lineNo != null) return `${path}:${lineNo}`;
  if (path) return path;
  if (text) return text;
  if (typeof o.name === "string") {
    return o.type === "dir" || o.type === "directory" ? `${o.name}/` : o.name;
  }
  return "";
}

/**
 * @param {unknown} item
 * @returns {string}
 */
function formatEntryLine(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (item);
  const name = firstNonEmptyString(o.name, o.path);
  if (!name) return formatMatchLine(item);
  const isDir =
    o.type === "dir" || o.type === "directory" || o.is_dir === true;
  return isDir ? `${name}/` : name;
}

/**
 * @param {unknown[]} arr
 * @returns {string}
 */
/**
 * MCP content blocks: text stays, images/audio become a short omitted note.
 * @param {unknown} item
 * @returns {string}
 */
function formatMcpContentEntry(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (item);
  const type = typeof o.type === "string" ? o.type : "";
  if (type === "image") {
    const mime = firstNonEmptyString(o.mimeType, o.mime, o.mediaType);
    return mime ? `[image ${mime} omitted]` : "[image omitted]";
  }
  if (type === "audio") return "[audio omitted]";
  if (type === "resource") return "[resource omitted]";
  if (typeof o.text === "string" && (type === "text" || (type === "" && Object.keys(o).length <= 2))) {
    return o.text;
  }
  return "";
}

function formatUnknownList(arr) {
  if (!Array.isArray(arr) || !arr.length) return "";
  return arr
    .map((item) => {
      if (typeof item === "string") return item;
      const mcp = formatMcpContentEntry(item);
      if (mcp) return mcp;
      const line = formatMatchLine(item);
      if (line) return line;
      try {
        return JSON.stringify(item, null, 2);
      } catch {
        return String(item);
      }
    })
    .join("\n");
}

/**
 * @param {unknown} item
 * @returns {string}
 */
function formatWebResultItem(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const r = /** @type {Record<string, unknown>} */ (item);
  const title = firstNonEmptyString(r.title, r.name);
  const url = firstNonEmptyString(r.url, r.href, r.link);
  const snippet = firstNonEmptyString(r.snippet, r.description, r.text);
  if (title && url) {
    return snippet ? `${title}\n${url}\n${snippet}` : `${title}\n${url}`;
  }
  if (url) return title ? `${title}\n${url}` : url;
  const line = formatMatchLine(item);
  if (line) return line;
  try {
    return JSON.stringify(item, null, 2);
  } catch {
    return String(item);
  }
}

/**
 * Native-style one-item-per-line bodies (pi grep/find/ls). Empty if not list-like.
 * @param {Record<string, unknown>} o
 * @returns {string}
 */
function formatListLikeToolResult(o) {
  if (Array.isArray(o.matches) && o.matches.length) {
    return formatUnknownList(o.matches);
  }
  if (Array.isArray(o.files) && o.files.length) {
    return formatUnknownList(o.files);
  }
  if (Array.isArray(o.paths) && o.paths.length) {
    return formatUnknownList(o.paths);
  }
  if (Array.isArray(o.entries) && o.entries.length) {
    return o.entries.map(formatEntryLine).filter(Boolean).join("\n");
  }
  if (Array.isArray(o.counts) && o.counts.length) {
    return o.counts
      .map((row) => {
        if (!row || typeof row !== "object") return "";
        const r = /** @type {Record<string, unknown>} */ (row);
        const path = firstNonEmptyString(r.path, r.file);
        const n = r.n ?? r.count;
        return path ? `${path}: ${n ?? 0}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(o.results) && o.results.length) {
    return o.results.map(formatWebResultItem).filter(Boolean).join("\n\n");
  }
  if (Array.isArray(o.output) && o.output.length) {
    return formatUnknownList(o.output);
  }
  if (
    (Array.isArray(o.matches) && o.matches.length === 0) ||
    (Array.isArray(o.files) && o.files.length === 0) ||
    (Array.isArray(o.paths) && o.paths.length === 0)
  ) {
    const count =
      typeof o.count === "number"
        ? o.count
        : typeof o.total === "number"
          ? o.total
          : 0;
    if (count === 0) return "(no matches)";
  }
  return "";
}

/**
 * @param {string} body
 * @param {Record<string, unknown>} o
 * @returns {string}
 */
function appendTruncatedHint(body, o) {
  if (o.truncated !== true) return body;
  const extra =
    typeof o.max_matches === "number"
      ? `… (truncated, max ${o.max_matches})`
      : typeof o.max_paths === "number"
        ? `… (truncated, max ${o.max_paths})`
        : typeof o.max_entries === "number"
          ? `… (truncated, max ${o.max_entries})`
          : "… (truncated)";
  return body ? `${body}\n${extra}` : extra;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Compact JSON strings (MCP/tool payloads that lost newlines) → list or indent-2.
 * @param {string} s
 * @returns {string}
 */
function maybeExpandJsonString(s, ok = true) {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if (t.length < 2) return s;
  const objLike =
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"));
  if (objLike) {
    try {
      const parsed = JSON.parse(t);
      return formatToolResult(parsed, ok, { expandJson: false });
    } catch {
      const salvaged = salvageTruncatedToolJson(s);
      if (salvaged) return salvaged;
      return s;
    }
  }
  if (!s.includes("\n") && (s.includes('"stdout":"') || s.includes('"content":"'))) {
    const salvaged = salvageTruncatedToolJson(s);
    if (salvaged) return salvaged;
  }
  return s;
}

/**
 * Recover file/shell text from a compact JSON blob truncated mid-string.
 * @param {string} s
 * @returns {string}
 */
function salvageTruncatedToolJson(s) {
  const stdout = extractJsonStringField(s, "stdout");
  if (stdout) {
    const stderr = extractJsonStringField(s, "stderr");
    return stderr ? `${stdout}\n${stderr}` : stdout;
  }
  return extractJsonStringField(s, "content");
}

/**
 * @param {string} s
 * @param {string} key
 * @returns {string}
 */
function extractJsonStringField(s, key) {
  const needle = `"${key}":"`;
  const i = s.indexOf(needle);
  if (i < 0) return "";
  let out = "";
  for (let j = i + needle.length; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\\" && j + 1 < s.length) {
      const n = s[j + 1];
      if (n === "n") {
        out += "\n";
        j += 1;
        continue;
      }
      if (n === "t") {
        out += "\t";
        j += 1;
        continue;
      }
      if (n === '"') {
        out += '"';
        j += 1;
        continue;
      }
      if (n === "\\") {
        out += "\\";
        j += 1;
        continue;
      }
      out += n;
      j += 1;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function truncateArgPreview(value, max = 80) {
  const t = String(value ?? "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const BLOCK_ARG_KEY_RE = /^(sql|query|statement|command|code|script|content|text|prompt|q)$/i;

/**
 * Long / SQL-like string args go on their own wrapped lines, not `key=80chars…`.
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
function shouldExpandArgValue(key, value) {
  if (typeof value !== "string") return false;
  if (LINE_BREAK_RE.test(value)) return true;
  if (BLOCK_ARG_KEY_RE.test(key)) return true;
  return value.length > 80;
}

/**
 * MCP / unknown-tool call: name + key=val (pi-cursor-sdk fallback), keep newlines.
 * SQL / long strings are full extra lines (wrap in layout), not a one-line preview.
 * @param {string} displayName
 * @param {Record<string, unknown>} o
 * @returns {string[]}
 */
function formatMcpToolCallLines(displayName, o) {
  const skip = new Set(["providerIdentifier", "provider_identifier", "toolName", "tool_name", "args"]);
  const entries = Object.entries(o).filter(([k]) => !skip.has(k));
  if (!entries.length) return [displayName];
  /** @type {string[]} */
  const shortParts = [];
  /** @type {string[]} */
  const extraLines = [];
  const shown = entries.slice(0, 8);
  for (const [key, value] of shown) {
    if (value == null) continue;
    if (shouldExpandArgValue(key, value)) {
      extraLines.push(`${key}:`, ...String(value).split(LINE_BREAK_RE));
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      shortParts.push(`${key}=${truncateArgPreview(value)}`);
    } else if (Array.isArray(value)) {
      shortParts.push(`${key}=[${value.length}]`);
    } else if (typeof value === "object") {
      extraLines.push(`${key}:`, ...prettyJson(value).split("\n"));
    }
  }
  const omitted =
    entries.length > 8 ? ` (+${entries.length - 8} more)` : "";
  const header = shortParts.length
    ? `${displayName} ${shortParts.join(", ")}${omitted}`
    : `${displayName}${omitted}`;
  return [header, ...extraLines];
}

/**
 * @param {number} n
 * @param {string} noun
 * @returns {string}
 */
function pluralizeCount(n, noun) {
  const c = Number(n) || 0;
  return `${c} ${noun}${c === 1 ? "" : "s"}`;
}

/**
 * Stock pi-cursor-sdk: `${prefix}${lineNumber} ${content}` (prefix is + / - / space).
 * @param {unknown} hunk
 * @returns {string[]}
 */
function formatEditHunkLines(hunk) {
  if (!Array.isArray(hunk)) return [];
  /** @type {string[]} */
  const rows = [];
  for (const raw of hunk) {
    if (!raw || typeof raw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const op = row.op === "+" || row.op === "-" ? row.op : " ";
    const lineNo = typeof row.line === "number" && Number.isFinite(row.line) ? row.line : "";
    const text = String(row.text ?? "").replace(/\t/g, "   ");
    rows.push(`${op}${lineNo} ${text}`);
  }
  return rows;
}

/**
 * ping/write/edit/mkdir/delete results as short prose (SDK delete/write, not JSON).
 * @param {Record<string, unknown>} o
 * @returns {string}
 */
function formatMutationToolResult(o) {
  if (o.pong === true) return "pong";
  if (o.pong === false) return "pong: false";
  const path = typeof o.path === "string" ? shortenHomePath(o.path) : "";
  if (!path) return "";
  if (typeof o.replacements === "number") {
    const added = typeof o.lines_added === "number" ? o.lines_added : null;
    const removed = typeof o.lines_removed === "number" ? o.lines_removed : null;
    let summary = "";
    if (added != null || removed != null) {
      const parts = [];
      if (added) parts.push(`added ${pluralizeCount(added, "line")}`);
      if (removed) parts.push(`removed ${pluralizeCount(removed, "line")}`);
      summary = parts.length ? parts.join(", ") : "updated file";
    } else {
      const n = o.replacements;
      const bytes = typeof o.bytes === "number" ? `, ${o.bytes} bytes` : "";
      summary = `Edited ${path} (${n} replacement${n === 1 ? "" : "s"}${bytes})`;
    }
    const hunkLines = formatEditHunkLines(o.hunk);
    return hunkLines.length ? `${summary}\n${hunkLines.join("\n")}` : summary;
  }
  if (
    "content" in o ||
    "start_line" in o ||
    "total_lines" in o ||
    "file_size" in o ||
    "end_line" in o
  ) {
    return "";
  }
  if (typeof o.bytes === "number" && (o.created === true || o.overwritten === true)) {
    const verb = o.overwritten === true ? "Overwrote" : "Wrote";
    return `${verb} ${path} (${o.bytes} bytes)`;
  }
  if (o.created === true && o.bytes == null && o.deleted == null) {
    return `Created directory ${path}`;
  }
  if (
    o.deleted === "file" ||
    o.deleted === "dir" ||
    o.deleted === "directory" ||
    o.deleted === true
  ) {
    const kind =
      o.deleted === "dir" || o.deleted === "directory" ? "directory" : "file";
    return `Deleted ${kind} ${path}`;
  }
  return "";
}

/**
 * @param {Record<string, unknown>} o
 * @returns {string}
 */
function formatReadFileResult(o) {
  if (typeof o.content !== "string") return "";
  if (
    typeof o.path !== "string" &&
    o.start_line == null &&
    o.total_lines == null &&
    o.file_size == null &&
    o.end_line == null
  ) {
    return "";
  }
  let body = o.content;
  if (o.truncated === true) {
    const hint = typeof o.hint === "string" && o.hint ? o.hint : "… (truncated)";
    body = body ? `${body}\n${hint}` : hint;
  }
  return body;
}

/**
 * Call headers matching stock pi grep/find/ls and pi-cursor-sdk WebSearch.
 * @param {string} displayName
 * @param {Record<string, unknown>} o
 * @returns {string[] | null}
 */
function formatNativeToolCallLines(displayName, o) {
  const path = firstNonEmptyString(
    o.path,
    o.target_file,
    o.file_path,
    o.file,
    o.target_directory,
  );
  const pattern = firstNonEmptyString(o.pattern);
  const glob = firstNonEmptyString(o.glob, o.glob_pattern);
  const query = firstNonEmptyString(
    o.search_term,
    o.searchTerm,
    o.query,
    o.q,
  );
  const url = firstNonEmptyString(o.url, o.uri, o.href);
  const homePath = path ? shortenHomePath(path) : "";

  if (displayName === "grep" || displayName === "rg") {
    const where = homePath || ".";
    const limit = o.head_limit ?? o.limit;
    let header = `grep ${formatRegexSlash(pattern)} in ${where}`;
    if (glob) header += ` (${glob})`;
    if (limit != null && String(limit).trim() !== "") header += ` limit ${limit}`;
    return [header];
  }
  if (displayName === "glob") {
    return [`find ${pattern || glob || "*"} in ${homePath || "."}`];
  }
  if (displayName === "list_dir" || displayName === "ls") {
    return [`ls ${homePath || "."}`];
  }
  if (displayName === "read_file" || displayName === "read") {
    let header = `read ${homePath || "?"}`;
    if (o.offset != null || o.limit != null) {
      const start = o.offset ?? 1;
      const end =
        o.limit != null ? Number(start) + Number(o.limit) - 1 : "";
      header += `:${start}${end !== "" ? `-${end}` : ""}`;
    }
    return [header];
  }
  if (displayName === "mkdir") {
    let header = `mkdir ${homePath || "?"}`;
    if (o.parents === true) header += " (parents)";
    return [header];
  }
  if (displayName === "str_replace" || displayName === "edit") {
    return [`edit ${homePath || "?"}`];
  }
  if (displayName === "delete_path" || displayName === "delete") {
    return [`delete ${homePath || "?"}`];
  }
  if (displayName === "ping") {
    return ["ping"];
  }
  if (isWebSearchName(displayName) && query) {
    return [`WebSearch ${query}`];
  }
  if (isWebFetchName(displayName) && url) {
    return [`WebFetch ${url}`];
  }
  if (displayName.startsWith("mcp__") || displayName.includes("mcp__")) {
    return formatMcpToolCallLines(displayName, o);
  }
  return null;
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
  if (typeof o.command === "string" && Object.keys(o).length <= 5) {
    return o.command;
  }
  // contour__glob — glob_pattern [target]
  if (typeof o.glob_pattern === "string") {
    const extra =
      typeof o.target_directory === "string" && o.target_directory
        ? ` ${o.target_directory}`
        : typeof o.path === "string" && o.path
          ? ` ${o.path}`
          : "";
    return o.glob_pattern + extra;
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

const TIMEOUT_SUFFIX_RE = /^(.*)( \(timeout \d+(?:\.\d+)?s\))$/;

/**
 * Explicit call timeout from args (contour `timeout` seconds, `timeout_s`, or
 * `block_until_ms`). The default 600s TOOL_WAIT is omitted unless the model
 * actually sent a timeout field.
 * @param {unknown} args
 * @returns {number | null}
 */
export function explicitTimeoutSeconds(args) {
  const o = unwrapToolArgs(args);
  const fromField = (raw, scale = 1) => {
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n / scale;
  };
  const seconds = fromField(o.timeout);
  if (seconds != null) return seconds;
  const timeoutS = fromField(o.timeout_s);
  if (timeoutS != null) return timeoutS;
  return fromField(o.block_until_ms, 1000);
}

/**
 * Stock pi bash suffix, e.g. ` (timeout 30s)`. Empty when there is no explicit timeout.
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
export function formatTimeoutSuffix(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
  const rounded = Math.round(seconds * 10) / 10;
  const shown = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return ` (timeout ${shown}s)`;
}

/**
 * Stock pi duration footer: `Took 1.5s` / `Elapsed 1.5s`.
 * @param {number | null | undefined} ms
 * @param {{ partial?: boolean }} [opts]
 * @returns {string}
 */
export function formatToolDurationLine(ms, opts = {}) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const label = opts.partial ? "Elapsed" : "Took";
  return `${label} ${(ms / 1000).toFixed(1)}s`;
}

/**
 * @param {string} line
 * @returns {{ body: string, suffix: string }}
 */
function splitTimeoutSuffix(line) {
  const m = String(line ?? "").match(TIMEOUT_SUFFIX_RE);
  return m ? { body: m[1], suffix: m[2] } : { body: String(line ?? ""), suffix: "" };
}

/**
 * Color tool-call headers like stock pi (name toolTitle, args accent, +/- bg).
 * Explicit `(timeout Ns)` is dim, matching stock bash.
 * @param {string} displayName
 * @param {string[]} lines
 * @param {{ fg?: Function, bg?: Function, bold?: Function } | null | undefined} theme
 * @returns {string[]}
 */
export function applyToolCallTheme(displayName, lines, theme) {
  if (!theme || typeof theme.fg !== "function" || !Array.isArray(lines)) {
    return lines;
  }
  const title = (s) =>
    typeof theme.bold === "function"
      ? theme.fg("toolTitle", theme.bold(s))
      : theme.fg("toolTitle", s);
  const accent = (s) => theme.fg("accent", s);
  const out = (s) => theme.fg("toolOutput", s);
  const dim = (s) => theme.fg("dim", s);
  // Foreground only — panel already uses toolSuccessBg; extra bg made + vanish
  // and - turn muddy brown (stock pi-cursor-sdk: toolDiffAdded/Removed/Context).
  const removed = (s) => theme.fg("toolDiffRemoved", s);
  const added = (s) => theme.fg("toolDiffAdded", s);
  const ctx = (s) => theme.fg("toolDiffContext", s);
  const name = String(displayName || "");
  /** @type {"header" | "rm" | "add" | "ctx" | "body"} */
  let mode = "header";
  return lines.map((line, index) => {
    const { body: s, suffix } = splitTimeoutSuffix(String(line ?? ""));
    const painted = (() => {
      if (/more lines/.test(s)) return dim(s);
      if (/^(Took|Elapsed) /.test(s)) return dim(s);
      if (name === "grep" || name === "rg") {
        const m = s.match(/^(grep) (\/(?:\\\/|[^/])*\/)( in .*)$/);
        if (m) return `${title(m[1])} ${accent(m[2])}${out(m[3])}`;
        if (index > 0) return accent(s);
      }
      if (name === "glob") {
        const m = s.match(/^(find) (.+?)( in .*)$/);
        if (m) return `${title(m[1])} ${accent(m[2])}${out(m[3])}`;
        if (index > 0) return accent(s);
      }
      if (name === "list_dir" || name === "ls") {
        const m = s.match(/^(ls) (.*)$/);
        if (m) return `${title(m[1])} ${accent(m[2])}`;
        if (index > 0) return accent(s);
      }
      if (name === "read_file" || name === "read") {
        const m = s.match(/^(read) (.*)$/);
        if (m) return `${title(m[1])} ${accent(m[2])}`;
        if (index > 0) return accent(s);
      }
      if (name === "mkdir") {
        const m = s.match(/^(mkdir) (.*)$/);
        if (m) return `${title(m[1])} ${accent(m[2])}`;
        if (index > 0) return accent(s);
      }
      if (name === "delete_path" || name === "delete") {
        const m = s.match(/^(delete) (.*)$/);
        if (m) return `${title(m[1])} ${accent(m[2])}`;
        if (index > 0) return accent(s);
      }
      if (name === "ping") return title(s || "ping");
      if (/^WebSearch |^WebFetch /.test(s)) {
        const sp = s.indexOf(" ");
        return `${title(s.slice(0, sp))} ${accent(s.slice(sp + 1))}`;
      }
      if (name === "write_file" || name === "write") {
        if (index === 0) {
          const m = s.match(/^(write) (.*)$/);
          if (m) return `${title(m[1])} ${accent(m[2])}`;
        }
        return out(s);
      }
      if (name === "str_replace" || name === "edit") {
        const header = s.match(/^(edit) (.*)$/);
        if (header) return `${title(header[1])} ${accent(header[2])}`;
        if (/^(added |removed |created |deleted |updated |Edited )/.test(s)) {
          return theme.fg("success", s);
        }
        const numbered = s.match(/^([+\- ])(\d+) ([\s\S]*)$/);
        if (numbered) {
          const p = numbered[1];
          if (p === "-") {
            mode = "rm";
            return removed(s);
          }
          if (p === "+") {
            mode = "add";
            return added(s);
          }
          mode = "ctx";
          return ctx(s);
        }
        if (s.startsWith("- ")) {
          mode = "rm";
          return removed(s);
        }
        if (s.startsWith("+ ")) {
          mode = "add";
          return added(s);
        }
        if (mode === "rm") return removed(s);
        if (mode === "add") return added(s);
        if (mode === "ctx") return ctx(s);
        return index === 0 ? title(s) : out(s);
      }
      if (name === "shell") {
        if (index === 0 && s.startsWith("$ ")) {
          return `${title("$")} ${accent(s.slice(2))}`;
        }
        return accent(s);
      }
      if (name.startsWith("mcp__") || name.includes("mcp__")) {
        if (index === 0) {
          const sp = s.indexOf(" ");
          if (sp < 0) return title(s);
          return `${title(s.slice(0, sp))} ${accent(s.slice(sp + 1))}`;
        }
        return accent(s);
      }
      return index === 0 ? title(s) : accent(s);
    })();
    return suffix ? `${painted}${dim(suffix)}` : painted;
  });
}

/**
 * Multi-line tool_call header for pi TUI (sed scripts, write_file body).
 * Wrap first, then theme, so wrapped argument rows keep accent (ANSI wrap
 * would otherwise leave only the first physical row colored).
 * Pass `width` from render() so long one-liners wrap instead of ending in `…`.
 * @param {string} displayName
 * @param {unknown} args
 * @param {{ maxLines?: number, width?: number, theme?: object, expanded?: boolean }} [opts]
 * @returns {string[]}
 */
export function formatToolCallLines(displayName, args, opts = {}) {
  const expanded = Boolean(opts.expanded);
  const maxLines =
    opts.maxLines ?? (expanded ? TOOL_CALL_EXPAND_LINES : TOOL_CALL_PREVIEW_LINES);
  const width = opts.width;
  const o = unwrapToolArgs(args);
  const native = formatNativeToolCallLines(String(displayName || "tool"), o);
  /** @type {string[]} */
  let logical = native ? [...native] : [];
  if (!native) {
    const shell = displayName === "shell";
    const writeLike = displayName === "write_file" || displayName === "write";
    const editLike = displayName === "str_replace" || displayName === "edit";
    const prefix = shell
      ? "$ "
      : writeLike
        ? "write "
        : editLike
          ? "edit "
          : `$ ${displayName} `;
    const sqlBlock = firstNonEmptyString(o.sql, o.query, o.statement);
    if (typeof o.command === "string") {
      const parts = o.command.split(LINE_BREAK_RE);
      logical = parts.map((p, i) => (i === 0 ? `${prefix}${p}` : p));
    } else if (
      typeof o.path === "string" &&
      (typeof o.old_string === "string" || typeof o.oldString === "string")
    ) {
      // Call header is `edit path`. Numbered unified diff (+ context) is the
      // tool result (stock pi-cursor-sdk: renderCall empty when complete).
      logical = [`${prefix}${o.path}`];
    } else if (
      typeof o.path === "string" &&
      (typeof o.content === "string" || typeof o.contents === "string")
    ) {
      const fileContent =
        typeof o.content === "string" ? o.content : String(o.contents ?? "");
      logical = [`${prefix}${o.path}`, ...fileContent.split(LINE_BREAK_RE)];
    } else if (sqlBlock) {
      logical = [`$ ${displayName}`, ...sqlBlock.split(LINE_BREAK_RE)];
    } else {
      const raw = formatToolArgs(args);
      if (!raw) logical = [`$ ${displayName}`];
      else {
        const parts = String(raw).split(LINE_BREAK_RE);
        logical = parts.map((p, i) => (i === 0 ? `${prefix}${p}` : p));
      }
    }
  }
  if (!logical.length) logical.push(`$ ${displayName}`);
  const timeoutSuffix = formatTimeoutSuffix(explicitTimeoutSeconds(o));
  const rows = layoutToolPanelLines(logical, width, {
    maxLines,
    expandHint: !expanded,
  });
  if (timeoutSuffix) {
    const last = rows[rows.length - 1] || "";
    const isHint = last.includes("more lines");
    if (isHint || last.includes("(timeout ")) {
      if (!last.includes("(timeout ")) rows.push(timeoutSuffix.trim());
    } else {
      const wrapped = layoutToolPanelLines([`${last}${timeoutSuffix}`], width);
      rows.splice(rows.length - 1, 1, ...wrapped);
    }
  }
  if (opts.theme) {
    return applyToolCallTheme(String(displayName || "tool"), rows, opts.theme);
  }
  return rows;
}

/**
 * Whether a bridge tool_executed payload should paint as a failed tool.
 * Wire `ok` is protocol-level (the handler ran); shell non-zero exit still
 * sends ok=true with exit_code. TUI error = ok=false, error payload, or
 * non-zero/timed-out shell.
 *
 * @param {unknown} ok
 * @param {unknown} content
 * @returns {boolean}
 */
export function isToolExecutionError(ok, content) {
  if (ok === false) return true;
  if (content == null || typeof content !== "object" || Array.isArray(content)) {
    return false;
  }
  const o = /** @type {Record<string, unknown>} */ (content);
  if (o.isError === true || o.is_error === true) return true;
  if (o.timed_out === true) return true;
  if (typeof o.exit_code === "number" && o.exit_code !== 0) return true;
  if (typeof o.error === "string" && o.error.length > 0) return true;
  return false;
}

/**
 * @param {Record<string, unknown>} o
 * @returns {boolean}
 */
function isShellShapedResult(o) {
  return (
    typeof o.exit_code === "number" ||
    typeof o.stdout === "string" ||
    typeof o.stderr === "string"
  );
}

/**
 * @param {Record<string, unknown>} o
 * @returns {string}
 */
function formatShellResult(o) {
  const parts = [];
  const stdout = typeof o.stdout === "string" ? o.stdout.replace(/\s+$/, "") : "";
  const stderr = typeof o.stderr === "string" ? o.stderr.replace(/\s+$/, "") : "";
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  if (typeof o.exit_code === "number" && o.exit_code !== 0) {
    parts.push(`exit ${o.exit_code}`);
  }
  if (o.timed_out) parts.push("timed out");
  if (o.timeout_capped && typeof o.timeout_requested === "number") {
    const cap = typeof o.timeout === "number" ? o.timeout : o.timeout_s;
    parts.push(`timeout capped to ${cap}s (requested ${o.timeout_requested}s)`);
  }
  if (typeof o.error === "string" && o.error) parts.push(o.error);
  return parts.join("\n");
}

/**
 * Format tool result preview for TUI.
 * Unwraps common {output|stdout|content|text|result|message} shapes.
 * List-like grep/glob/ls payloads stay one item per line (pi grep/find),
 * not compact JSON. write/edit/mkdir/delete/ping use short prose. Other
 * objects use indent-2 JSON. Shell-shaped payloads include stderr and
 * non-zero exit (empty stdout must not hide the failure).
 * @param {unknown} content
 * @param {boolean} [ok]
 * @param {{ expandJson?: boolean }} [opts]
 */
export function formatToolResult(content, ok = true, opts = {}) {
  const expandJson = opts.expandJson !== false;
  let body = "";
  if (typeof content === "string") {
    body = content;
  } else if (Array.isArray(content)) {
    body = formatUnknownList(content);
  } else if (content != null && typeof content === "object") {
    const o = /** @type {Record<string, unknown>} */ (content);
    if (isShellShapedResult(o)) {
      body = formatShellResult(o);
    } else if (typeof o.error === "string" && o.error) {
      const msg = typeof o.message === "string" ? o.message : "";
      const hint = typeof o.hint === "string" ? o.hint : "";
      body = [o.error, msg, hint].filter(Boolean).join("\n");
    } else {
      const mutation = formatMutationToolResult(o);
      const readBody = formatReadFileResult(o);
      const listed = formatListLikeToolResult(o);
      if (mutation) {
        body = mutation;
      } else if (readBody) {
        body = readBody;
      } else if (listed) {
        body = appendTruncatedHint(listed, o);
      } else {
        for (const k of ["output", "stdout", "text", "message", "result", "content"]) {
          const v = o[k];
          if (typeof v === "string" && v) {
            body = v;
            break;
          }
          if (Array.isArray(v) && v.length) {
            body = formatUnknownList(v);
            break;
          }
        }
        if (!body) body = prettyJson(content);
      }
    }
  } else if (content != null) {
    body = String(content);
  }
  if (expandJson && (typeof content === "string" || (body && !body.includes("\n")))) {
    body = maybeExpandJsonString(body, ok);
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
 *   idleCheckMs?: number,
 *   skipPrompt?: boolean,
 *   skipStart?: boolean,
 *   client?: import("./bridge-client.js").BridgeClient,
 * }} [opts]
 */
export async function runPromptViaBridge(client, text, opts = {}) {
  clearToolResults();
  setFollowUp(null);
  clearThinkingIndicator();
  clearWireStatus();
  const channel = opts.mode === "summarize" ? "summarize" : "coding";
  if (channel === "coding") {
    await waitWhileSummarizeBusy(client, opts.signal);
  }
  if (!opts.skipPrompt) {
    clearLiveRun(channel);
  }

  let grants = [];
  if (opts.applyGrants !== false && !opts.skipPrompt) {
    grants = await applyEnvGrants(client, opts.env || process.env);
  }

  const feederOpts = {
    ...(opts.idleCheckMs != null ? { idleCheckMs: opts.idleCheckMs } : {}),
    channel,
  };
  let session = getActiveLiveRun(channel);
  if (!session) {
    session = startLiveEventFeeder(
      client,
      opts.signal,
      opts.timeoutMs ?? LIVE_RUN_IDLE_MS,
      feederOpts
    );
  }
  const onPromptAbort = () => {
    if (channel === "summarize") return;
    if (typeof session.requestCancel === "function") session.requestCancel();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onPromptAbort();
    else opts.signal.addEventListener("abort", onPromptAbort, { once: true });
  }
  try {
    if (!opts.skipPrompt) {
      await new Promise((r) => setTimeout(r, 30));
      const model = opts.model || {};
      await client.prompt(text, opts.requestId, {
        model:
          opts.modelSelection ||
          (typeof model.id === "string" ? model.id : undefined),
        mode: opts.mode,
      });
    }
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onPromptAbort);
  }

  const result = await drainLiveRunTurn({
    ...opts,
    channel,
    client,
    _promptChars: typeof text === "string" ? text.length : 0,
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
 * Typed follow-up while a coding live-run is already painting.
 * Prefers mid-run ``steer`` (injected:true). Otherwise FIFO — keep the SSE
 * feeder so the queued turn still streams into this chat bubble.
 * @param {BridgeClient} client
 * @param {string} text
 * @param {Parameters<typeof runPromptViaBridge>[2]} [opts]
 */
export async function followUpWhileLiveRun(client, text, opts = {}) {
  await waitWhileSummarizeBusy(client, opts.signal);
  const requestId = opts.requestId || `req-${Date.now()}`;
  const model = opts.model || {};
  const promptRes = await client.prompt(text, requestId, {
    model:
      opts.modelSelection ||
      (typeof model.id === "string" ? model.id : undefined),
  });
  if (promptRes.injected) {
    emitInjectedAck(opts);
    return { injected: true, grants: [] };
  }
  await waitUntilDrainIdle("coding", opts.signal);
  await waitForActiveRequest(client, requestId, opts.signal);
  if (hasActiveLiveRun()) {
    return resumeBridgeLiveTurn({ ...opts, client, requestId });
  }
  return runPromptViaBridge(client, text, {
    ...opts,
    requestId,
    skipPrompt: true,
    applyGrants: false,
  });
}

/**
 * @param {BridgeClient} client
 * @param {string} requestId
 * @param {AbortSignal} [signal]
 */
async function waitForActiveRequest(client, requestId, signal) {
  for (;;) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const snap = await client.getSession();
      if (snap?.active_request_id === requestId && snap?.run_active) return;
      if (!sessionHasQueuedWork(snap)) return;
    } catch {
      return;
    }
    await sleepAbortable(40, signal);
  }
}

/**
 * @param {Parameters<typeof runPromptViaBridge>[2]} opts
 */
function emitInjectedAck(opts) {
  const model = opts.model || {};
  const line = "[injected into current run]\n";
  const output = {
    role: "assistant",
    content: [{ type: "text", text: line }],
    api: model.api || "cursor-remote-bridge",
    provider: model.provider || "cursor-remote",
    model: model.id || DEFAULT_MODEL,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const push = opts.onStreamEvent;
  if (typeof push !== "function") return;
  push({ type: "start", partial: output });
  push({ type: "text_start", contentIndex: 0, partial: output });
  push({
    type: "text_delta",
    contentIndex: 0,
    delta: line,
    partial: output,
  });
  push({
    type: "text_end",
    contentIndex: 0,
    content: line,
    partial: output,
  });
  push({ type: "done", reason: "stop", message: output });
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
  const channel = opts.channel === "summarize" ? "summarize" : "coding";
  const session = getActiveLiveRun(channel);
  if (!session) {
    throw new Error("no active bridge live run");
  }
  setDrainBusy(channel, true);

  const onResumeAbort = () => {
    if (channel === "summarize") return;
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
  if (!opts.skipStart) {
    stream.push({ type: "start", partial: output });
  }

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
    markToolCallStarted(id);
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

  /** @param {string} reason
   *  @param {{ keepFeeder?: boolean }} [extra]
   */
  const finishTurn = (reason, extra = {}) => {
    if (finished) return;
    finished = true;
    endThinkingBlock();
    endTextBlock();
    notifyIndicator(false);
    output.stopReason = reason;
    if (reason === "error" || reason === "aborted") {
      setFollowUp(null);
      clearLiveRun(channel);
      stream.push({ type: "error", reason, error: output });
    } else {
      stream.push({ type: "done", reason, message: output });
      if (reason === "stop") {
        const keep = extra.keepFeeder || session.fifoPending;
        if (!keep) clearLiveRun(channel);
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
        ok: !isToolExecutionError(ev.ok, ev.content),
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
      if (channel !== "summarize") {
        const stats = formatRequestStatsLine({
          usage: output.usage,
          durationMs: Number(ev.duration_ms) || 0,
        });
        const quoted = quoteRequestStatsLine(stats);
        if (quoted) appendStatusLine(`\n${quoted}`);
      }
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
    } else if (ev.type === "downlink_resync" || ev.type === "uplink_retry" || ev.type === "sse_reconnect" || ev.type === "session_reopen") {
      endThinkingBlock();
      const line =
        (typeof ev.message === "string" && ev.message) ||
        (ev.type === "uplink_retry"
          ? "[wire] Uplink retry…"
          : ev.type === "sse_reconnect"
            ? "[wire] SSE reconnecting…"
            : ev.type === "session_reopen"
              ? "[wire] VPS session lost; reconnecting…"
              : "[wire] Downlink catch-up: skipped a stuck packet; session kept.");
      appendStatusLine(line);
    } else if (ev.type === "cancel_ack") {
      const phase = ev.phase || "";
      if (phase === "uplink_ok" || ev.uplink) {
        appendStatusLine("[cancel] sent to VPS");
      } else if (phase === "uplink_failed") {
        appendStatusLine(`[cancel] uplink failed (${ev.error || "error"})`);
      } else if (phase === "sent") {
        appendStatusLine("[cancel] sending…");
      }
    } else if (ev.type === "run_heartbeat") {
      pokeUiKeepAlive();
    } else if (ev.type === "session_end") {
      endThinkingBlock();
      notifyIndicator(false);
      output.stopReason = "error";
      if (ev.reason === "version_mismatch") {
        output.errorMessage =
          (typeof ev.message === "string" && ev.message.trim()) ||
          `Incompatible versions (${ev.detail || "bridge vs relay"}). ` +
            "Update contour-bridge zip and VPS together.";
      } else {
        const detail = ev.detail ? `:${ev.detail}` : "";
        output.errorMessage = `session_end:${ev.reason || ""}${detail}`;
      }
    }
  }

  try {
    while (!finished) {
      const ev = await session.nextEvent();
      if (!ev) {
        flushDeferredBoundary();
        if (session.abandoned) {
          finishTurn("stop");
          break;
        }
        if (toolsThisTurn > 0 && pendingExec.size > 0) {
          if (session.error) {
            output.errorMessage = session.error.message;
            finishTurn("error");
          } else {
            finishTurn("toolUse");
          }
        } else if (toolsThisTurn > 0) {
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
        let keep = Boolean(session.fifoPending);
        const client = opts.client;
        if (!keep && client && typeof client.getSession === "function") {
          try {
            keep = sessionHasQueuedWork(await client.getSession());
          } catch {
            keep = false;
          }
        }
        finishTurn(toolsThisTurn > 0 ? "toolUse" : "stop", { keepFeeder: keep });
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
    setDrainBusy(channel, false);
    if (opts.signal) opts.signal.removeEventListener("abort", onResumeAbort);
  }

  return {
    stream,
    events: turnRaw,
    output,
    grants: [],
  };
}
