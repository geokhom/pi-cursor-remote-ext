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

/**
 * @param {object | undefined} options streamSimple options from pi
 */
export function isSummarizationRequest(options) {
  return options?.toolChoice === "none";
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
  const text = summarizationPromptFromContext(context);
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
  const thinkingLevel =
    options?.thinkingLevel ||
    options?.reasoning ||
    context?.thinkingLevel ||
    "off";
  await runPromptViaBridge(client, text, {
    signal: options?.signal,
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
    onStreamEvent: (ev) => {
      if (ev?.type === "_end") return;
      stream.push(ev);
    },
  });
  stream.end();
}

export function summarizationErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
