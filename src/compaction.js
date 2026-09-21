/**
 * Pi /compact and branch summarization (toolChoice: "none").
 *
 * Must not reuse the coding Agent turn: no shadow tools, grants, or live-run
 * resume. Bridge opens an ephemeral VPS sid with empty hello tools.
 */

import {
  BridgeClient,
  runPromptViaBridge,
} from "./bridge-client.js";
import {
  resolveBridgeConnection,
  DEFAULT_MODEL,
} from "./config.js";
import { buildCursorModelSelection } from "./model-discovery.js";
import { hasActiveLiveRun } from "./live-run.js";
import { sleepAbortable } from "./sse-reconnect.js";

const SUMMARIZE_BUSY_RETRY_MS = 200;

/**
 * Hermes `turn_end` often fires after a tool batch while the VPS coding run is
 * still in-flight. Sidecar summarize must not share that SSE (`409 busy`).
 *
 * @param {unknown} err
 */
export function isBridgeBusyError(err) {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /prompt HTTP 409/.test(msg) && /busy/.test(msg);
}

/**
 * @param {AbortSignal | undefined} signal
 * @param {{ isActive?: () => boolean, intervalMs?: number }} [opts]
 */
export async function waitWhileLiveRunActive(signal, opts = {}) {
  const isActive = opts.isActive || hasActiveLiveRun;
  const intervalMs = opts.intervalMs ?? SUMMARIZE_BUSY_RETRY_MS;
  while (isActive()) {
    if (signal?.aborted) throw new Error("aborted");
    await sleepAbortable(intervalMs, signal);
    if (signal?.aborted) throw new Error("aborted");
  }
}

/**
 * @param {object | undefined} options streamSimple options from pi
 */
export function isSummarizationRequest(options) {
  return options?.toolChoice === "none";
}

/**
 * Isolated LLM calls that must not hit the coding Agent (empty hello tools).
 * Covers Pi `/compact` (`toolChoice: "none"`) and in-process `completeSimple`
 * from extensions such as pi-hermes-memory.
 *
 * Hermes often snapshots the session tool list and/or splits the transcript
 * into many messages. Those must still go to the summarize sidecar — otherwise
 * the dump is posted as a coding `user_prompt` and the Agent starts tools.
 *
 * @param {object | undefined} context
 * @param {object | undefined} options
 */
export function isSideChannelCompletion(context, options) {
  if (isSummarizationRequest(options)) return true;
  if (contextLooksLikeHermesReview(context)) return true;
  const tools = context?.tools;
  if (Array.isArray(tools) && tools.length > 0) return false;
  const sys =
    typeof context?.systemPrompt === "string" && context.systemPrompt.trim().length > 0;
  if (!sys) return false;
  const n = Array.isArray(context?.messages) ? context.messages.length : 0;
  return n <= 2;
}

/**
 * @param {object | undefined} context
 */
export function lastUserText(context) {
  const messages = context?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");
      }
    }
  }
  return "";
}

/** Match local-bridge sidecar cap (chars). */
export const SUMMARIZE_TEXT_MAX = 512_000;
const SUMMARIZE_HEAD_KEEP = 12_000;
const SUMMARIZE_TRUNC_MARKER = "\n\n[truncated for summarization]\n";

export function looksLikeHermesOperations(text) {
  const head = String(text || "")
    .slice(0, 8000)
    .toLowerCase();
  return (
    head.includes("do not call tools") ||
    head.includes('"operations"') ||
    head.includes("'operations'")
  );
}

/**
 * @param {object | undefined} message
 */
function messagePlainText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/**
 * Hermes review prompt: operations schema in systemPrompt / system messages,
 * or in the current user dump. Do not scan older user turns — a past review
 * dump left in the session must not reroute later coding streamSimple calls.
 *
 * @param {object | undefined} context
 */
export function contextLooksLikeHermesReview(context) {
  if (looksLikeHermesOperations(context?.systemPrompt)) return true;
  if (looksLikeHermesOperations(lastUserText(context))) return true;
  const messages = context?.messages;
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (m?.role !== "system") continue;
    if (looksLikeHermesOperations(messagePlainText(m))) return true;
  }
  return false;
}

/**
 * Hermes `parseReviewOperations` needs a JSON object with an `operations`
 * array. Cursor often wraps it in ```json, prefixes prose, or (with thinking)
 * emits nothing on the visible text channel.
 * @param {string} text
 * @returns {string | null} canonical `{"operations":...}` or null
 */
export function parseHermesOperationsJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  /** @param {string} raw */
  const tryObj = (raw) => {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj) && Array.isArray(obj.operations)) {
        return JSON.stringify(obj);
      }
    } catch {
      // not JSON
    }
    return null;
  };
  const direct = tryObj(trimmed);
  if (direct) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const got = tryObj(fenced[1].trim());
    if (got) return got;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryObj(trimmed.slice(start, end + 1));
  }
  return null;
}

/**
 * Hermes auto-review expects a JSON object. Cursor often wraps it in ```json
 * or prefixes prose — that becomes Direct `parse_error`.
 * @param {string} text
 * @returns {string}
 */
export function unwrapHermesJsonText(text) {
  const parsed = parseHermesOperationsJson(text);
  if (parsed) return parsed;
  const raw = String(text || "");
  if (/nothing to save/i.test(raw) && !raw.includes("{")) {
    return '{"operations":[]}';
  }
  return raw;
}

/**
 * Visible-channel JSON for Hermes. Empty / unparseable assistant text (typical
 * when thinking was dropped) must still be `{"operations":[]}` so Direct is
 * empty-success instead of parse_error + subprocess "model not found".
 * @param {string} text
 * @returns {string}
 */
export function hermesReviewResultText(text) {
  return parseHermesOperationsJson(text) || '{"operations":[]}';
}

/**
 * Mutate the assistant message Hermes `completeSimple().result()` reads.
 * Copying a new object is not enough if the drain still holds `output`.
 * @param {object | undefined} message
 * @returns {object}
 */
export function canonicalizeHermesAssistantMessage(message) {
  const textBlocks = Array.isArray(message?.content)
    ? message.content.filter(
        (b) => b && b.type === "text" && typeof b.text === "string"
      )
    : [];
  const joined = textBlocks.map((b) => b.text).join("\n");
  const text = hermesReviewResultText(joined);
  const block = { type: "text", text };
  if (message && typeof message === "object") {
    if (Array.isArray(message.content)) {
      message.content.length = 0;
      message.content.push(block);
    } else {
      message.content = [block];
    }
    return message;
  }
  return { role: "assistant", content: [block] };
}

/**
 * @param {object} ev
 * @returns {object}
 */
export function unwrapHermesJsonEvent(ev) {
  if (!ev || typeof ev !== "object") return ev;
  if (ev.type === "done" && ev.message) {
    canonicalizeHermesAssistantMessage(ev.message);
    return ev;
  }
  if (ev.type === "text_end" && typeof ev.content === "string") {
    return { ...ev, content: hermesReviewResultText(ev.content) };
  }
  return ev;
}

/**
 * Fit a Hermes/compact dump so POST /prompt stays under the bridge body cap.
 * Keep the operations-schema head and the recent transcript tail.
 *
 * @param {string} text
 * @param {number} [limit]
 */
export function truncateSummarizeText(text, limit = SUMMARIZE_TEXT_MAX) {
  if (typeof text !== "string" || text.length <= limit) return text;
  const budget = Math.max(0, limit - SUMMARIZE_TRUNC_MARKER.length);
  if (looksLikeHermesOperations(text)) {
    const headN = Math.min(SUMMARIZE_HEAD_KEEP, Math.floor(budget / 4));
    const head = text.slice(0, headN);
    const tailN = budget - head.length;
    const tail = tailN > 0 ? text.slice(-tailN) : "";
    return head + SUMMARIZE_TRUNC_MARKER + tail;
  }
  return SUMMARIZE_TRUNC_MARKER + text.slice(-budget);
}

/**
 * True when this streamSimple is a freshly typed user message, not a tool-loop
 * resume (last message is a toolResult / assistant). A leftover live-run SSE
 * must not swallow that text via resumeBridgeLiveTurn.
 *
 * @param {object | undefined} context
 */
export function isNewUserTurn(context) {
  const messages = context?.messages || [];
  const last = messages[messages.length - 1];
  return last?.role === "user";
}

/**
 * @param {object | undefined} context
 */
export function summarizationPromptFromContext(context) {
  const user = lastUserText(context);
  const sys =
    typeof context?.systemPrompt === "string" ? context.systemPrompt.trim() : "";
  if (sys && user) return `${sys}\n\n${user}`;
  return user || sys;
}

/**
 * Minimal AssistantMessageEventStream stand-in (no pi-ai import).
 * Pi compaction awaits stream.result() after iterating / in parallel.
 */
export function createLocalStream() {
  const queue = [];
  let ended = false;
  let wake = null;
  let settled = false;
  let resultResolve;
  let resultReject;
  const resultPromise = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  resultPromise.catch(() => {
    // Avoid unhandled rejection if nobody awaits result() (agent turns).
  });

  const settleOk = (message) => {
    if (settled) return;
    settled = true;
    resultResolve(message);
  };
  const settleErr = (err) => {
    if (settled) return;
    settled = true;
    if (err instanceof Error) {
      resultReject(err);
      return;
    }
    if (err && typeof err === "object") {
      const msg = err.errorMessage || err.message || err.reason;
      if (msg) {
        resultReject(new Error(String(msg)));
        return;
      }
    }
    resultReject(new Error(String(err)));
  };

  return {
    push(ev) {
      queue.push(ev);
      if (ev?.type === "done") settleOk(ev.message);
      else if (ev?.type === "error") {
        settleErr(ev.error || ev.reason || "error");
      }
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    end() {
      ended = true;
      if (!settled) settleErr(new Error("stream ended without result"));
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    result() {
      return resultPromise;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (ended) return;
        await new Promise((r) => {
          wake = r;
        });
      }
    },
  };
}

/**
 * @param {{
 *   model?: object,
 *   context?: object,
 *   options?: object,
 *   stream: ReturnType<typeof createLocalStream>,
 *   client?: import('./bridge-client.js').BridgeClient | null,
 * }} args
 */
export async function runSummarizationViaBridge(args) {
  const { model, context, options, stream } = args;
  const text = truncateSummarizeText(summarizationPromptFromContext(context));
  if (!text) {
    throw new Error("no summarization text in context");
  }
  const conn = resolveBridgeConnection();
  if (!conn.baseUrl && !conn.unixPath && !args.client) {
    throw new Error(
      "Bridge not configured: cannot run /compact (need cursor-remote.json or BRIDGE_URL)"
    );
  }
  const client =
    args.client ||
    new BridgeClient({
      baseUrl: conn.baseUrl,
      token: conn.token,
      unixPath: conn.unixPath,
    });
  const piModelId = typeof model?.id === "string" ? model.id : DEFAULT_MODEL;
  // Hermes review parses visible assistant text as JSON. Session thinkingLevel
  // (medium) puts the JSON in thinking, which summarize drops (thinking_display
  // off) → Direct parse_error. Compact summaries can keep the caller's level.
  const hermesReview =
    contextLooksLikeHermesReview(context) || looksLikeHermesOperations(text);
  const thinkingLevel = hermesReview
    ? "off"
    : options?.thinkingLevel ||
      options?.reasoning ||
      context?.thinkingLevel ||
      "off";
  const signal = options?.signal;
  stream.push({
    type: "start",
    partial: {
      role: "assistant",
      content: [],
      api: model?.api || "cursor-remote-bridge",
      provider: model?.provider || "cursor-remote",
      model: piModelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
      stopReason: "pending",
      timestamp: Date.now(),
    },
  });
  const SUMMARIZE_KEEPALIVE_MS = 4000;
  let keepAlive = null;
  const pokeKeepAlive = () => {
    stream.push({
      type: "thinking_delta",
      delta: "",
      contentIndex: 0,
      partial: {
        role: "assistant",
        content: [],
        stopReason: "pending",
        timestamp: Date.now(),
      },
    });
  };
  keepAlive = setInterval(pokeKeepAlive, SUMMARIZE_KEEPALIVE_MS);
  if (hermesReview) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
  let busyAttempts = 0;
  const promptOpts = {
    applyGrants: false,
    thinkingDisplay: "off",
    rejectTools: true,
    mode: "summarize",
    modelSelection: buildCursorModelSelection(piModelId, thinkingLevel),
    model: {
      id: piModelId,
      api: model?.api || "cursor-remote-bridge",
      provider: model?.provider || "cursor-remote",
      contextWindow: model?.contextWindow,
      maxTokens: model?.maxTokens,
    },
    skipStart: true,
    onStreamEvent: (ev) => {
      if (ev?.type === "_end" || ev?.type === "start") return;
      if (hermesReview) {
        ev = unwrapHermesJsonEvent(ev);
      }
      stream.push(ev);
    },
  };
  try {
    for (;;) {
      await waitWhileLiveRunActive(signal);
      try {
        await runPromptViaBridge(client, text, promptOpts);
        break;
      } catch (err) {
        if (!isBridgeBusyError(err) || signal?.aborted) throw err;
        busyAttempts += 1;
        if (!signal && busyAttempts > 3000) throw err;
        await sleepAbortable(SUMMARIZE_BUSY_RETRY_MS, signal);
        if (signal?.aborted) throw new Error("aborted");
      }
    }
    stream.end();
  } finally {
    if (keepAlive) clearInterval(keepAlive);
  }
}

export function summarizationErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
