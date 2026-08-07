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
   */
  async prompt(text, requestId) {
    const body = JSON.stringify({
      text,
      request_id: requestId || `req-${Date.now()}`,
    });
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
   */
  async collectUntilTerminal(signal, timeoutMs = 15000, onEvent) {
    const out = [];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const ev of this.events(ac.signal)) {
        out.push(ev);
        if (typeof onEvent === "function") onEvent(ev);
        const t = ev?.type;
        if (
          t === "run_finished" ||
          t === "run_error" ||
          t === "session_end"
        ) {
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
 * Tools: emit toolcall_* with display names (no contour__ prefix). Shadow tools
 * registered by the extension return stashed local results so pi paints
 * ToolExecutionComponent (colored success/error + result text) without
 * re-running work or fetching via corp proxy.
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
 *   model?: { id?: string, api?: string, provider?: string },
 * }} [opts]
 */
export async function runPromptViaBridge(client, text, opts = {}) {
  const { displayToolName } = await import("./tool-display.js");
  const { stashToolResult, clearToolResults } = await import("./result-stash.js");

  clearToolResults();

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
  const output = {
    role: "assistant",
    content: [],
    api: model.api || "cursor-remote-bridge",
    provider: model.provider || "cursor-remote",
    model: model.id || "cursor-remote",
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: output });

  let grants = [];
  if (opts.applyGrants !== false) {
    grants = await applyEnvGrants(client, opts.env || process.env);
  }

  /** @type {number | null} */
  let textIndex = null;
  let textBuf = "";
  let sawToolCall = false;

  const bumpUsage = () => {
    const n = output.content.reduce((acc, c) => {
      if (c.type === "text") return acc + (c.text?.length || 0);
      return acc;
    }, 0);
    output.usage.output = Math.max(1, Math.ceil(n / 4));
    output.usage.totalTokens = output.usage.input + output.usage.output;
  };

  /** @param {string} chunk */
  const appendText = (chunk) => {
    if (!chunk) return;
    if (textIndex == null) {
      textIndex = output.content.length;
      textBuf = "";
      output.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
    }
    textBuf += chunk;
    output.content[textIndex].text = textBuf;
    bumpUsage();
    stream.push({
      type: "text_delta",
      contentIndex: textIndex,
      delta: chunk,
      partial: output,
    });
  };

  /** Close current text block so the next toolCall gets its own contentIndex. */
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

  /**
   * @param {string} wireName
   * @param {string} callId
   * @param {Record<string, unknown>} args
   */
  const emitToolCall = (wireName, callId, args) => {
    endTextBlock();
    const name = displayToolName(wireName);
    const id = callId || `call-${output.content.length}`;
    const contentIndex = output.content.length;
    const toolCall = {
      type: "toolCall",
      id,
      name,
      arguments: args && typeof args === "object" ? args : {},
    };
    output.content.push(toolCall);
    sawToolCall = true;
    bumpUsage();
    stream.push({ type: "toolcall_start", contentIndex, partial: output });
    stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall,
      partial: output,
    });
  };

  /** @param {object} ev */
  const handleLive = (ev) => {
    if (typeof opts.onEvent === "function") opts.onEvent(ev);
    if (ev.type === "assistant_delta" && typeof ev.text === "string") {
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
      stashToolResult(callId, {
        ok: ev.ok !== false,
        content: ev.content,
        name: typeof ev.name === "string" ? ev.name : undefined,
      });
    } else if (ev.type === "run_finished") {
      output.stopReason = sawToolCall ? "toolUse" : "stop";
    } else if (ev.type === "run_error") {
      output.stopReason = "error";
      const kind = ev.kind || "run_error";
      if (kind === "policy") {
        const tn = ev.tool_name || "built-in/unknown";
        const hint = ev.message || ev.redirect_to;
        output.errorMessage = hint
          ? `policy: ${hint}`
          : `policy: blocked tool "${tn}" — use only contour__* tools ` +
            "(list_dir/read_file/write_file/mkdir/delete_path/shell/ping)";
      } else {
        output.errorMessage = ev.message
          ? `${kind}: ${ev.message}`
          : kind;
      }
    } else if (ev.type === "session_end") {
      output.stopReason = "error";
      const detail = ev.detail ? `:${ev.detail}` : "";
      output.errorMessage = `session_end:${ev.reason || ""}${detail}`;
    }
  };

  // Start SSE before prompt so we do not miss early events.
  // Default 10m — Cursor runs with tools exceed the old 15s smoke timeout.
  const collectPromise = client.collectUntilTerminal(
    opts.signal,
    opts.timeoutMs ?? 600_000,
    handleLive
  );
  await new Promise((r) => setTimeout(r, 30));
  await client.prompt(text, opts.requestId);

  const events = await collectPromise;
  endTextBlock();

  if (output.stopReason === "pending") {
    output.stopReason = "error";
    output.errorMessage = "stream ended without terminal";
  }
  if (output.stopReason === "error" || output.stopReason === "aborted") {
    stream.push({ type: "error", reason: output.stopReason, error: output });
  } else {
    // toolUse → agent runs shadow tools (stashed results) then stops (terminate:true).
    const reason =
      output.stopReason === "toolUse" || sawToolCall ? "toolUse" : "stop";
    output.stopReason = reason;
    stream.push({ type: "done", reason, message: output });
  }
  stream.end();
  return { stream, events, output, grants };
}
