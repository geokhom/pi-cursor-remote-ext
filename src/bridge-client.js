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
 * Join thinking chunks into flowing prose (SDK often sends short lines / CR).
 * @param {string} buf
 * @param {string} chunk
 */
export function joinThinkingChunk(buf, chunk) {
  if (!chunk) return buf || "";
  let c = String(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Soft line wraps → spaces; keep rare blank-line paragraph breaks
  c = c.replace(/([^\n])\n(?!\n)/g, "$1 ").replace(/\n{3,}/g, "\n\n");
  c = c.replace(/[ \t]{2,}/g, " ");
  if (!buf) return c.replace(/^\s+/, "");
  const right = c.replace(/^\s+/, "");
  if (!right) return buf;
  // Cumulative snapshot or exact/replay duplicate (ignore tiny punctuation-only)
  if (right.startsWith(buf)) return right;
  if (right === buf || (right.length >= 4 && buf.endsWith(right))) return buf;
  if (/\s$/.test(buf)) return buf + right;
  // Letter/digit/punct boundary (Cyrillic + «»); insert space across chunks
  if (
    /[\p{L}\p{N}.!?)\]"'…»]$/u.test(buf) &&
    /^[\p{L}\p{N}("'([`«]/u.test(right)
  ) {
    return `${buf} ${right}`;
  }
  return buf + right;
}

/**
 * @typedef {object} BridgeClientOptions
 * @property {string} [baseUrl] TCP base, e.g. http://127.0.0.1:PORT
 * @property {string} [token] Bearer token (required for TCP mode)
 * @property {string} [unixPath] Absolute path to Unix socket (0600)
 */

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

/**
 * Format contour tool args for TUI (single line when short).
 * @param {unknown} args
 */
export function formatToolArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const o = /** @type {Record<string, unknown>} */ (args);
  // contour__shell — show command like local bash UI
  if (typeof o.command === "string" && Object.keys(o).length <= 3) {
    return o.command;
  }
  if (typeof o.path === "string" && Object.keys(o).length <= 3) {
    return o.path;
  }
  try {
    const s = JSON.stringify(args);
    return s.length > 240 ? s.slice(0, 240) + "…" : s;
  } catch {
    return "";
  }
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
            "(list_dir/read_file/write_file/mkdir/delete_path/shell/ping)";
      } else {
        output.errorMessage = ev.message ? `${kind}: ${ev.message}` : kind;
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
      if (toolsThisTurn > 0 && isPostToolBoundaryEvent(ev)) {
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
  }

  return {
    stream,
    events: turnRaw,
    output,
    grants: [],
  };
}
