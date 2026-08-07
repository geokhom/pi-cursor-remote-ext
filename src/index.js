/**
 * Level A pi extension — Cursor-orchestrated via local-bridge.
 *
 * Pi TUI → this extension → local-bridge POST /prompt + SSE /events
 * → VPS Cursor Agent (tools executed on bridge, not here).
 *
 * registerProvider shape matches pi-coding-agent ExtensionAPI:
 *   pi.registerProvider(name, { name, api, models, streamSimple?, ... })
 *
 * We intentionally avoid depending on @earendil-works/pi-ai at install time.
 * streamSimple returns a minimal event stream compatible with the pattern in
 * pi's custom-provider docs (start / text_delta / done | error).
 *
 * Env / config:
 *   ~/.pi/agent/cursor-remote.json  (shared with bridge; preferred)
 *   BRIDGE_URL / BRIDGE_LOCAL_TOKEN / BRIDGE_UNIX_PATH  (overrides)
 *   BRIDGE_GRANTS / BRIDGE_GRANT_WRITE / BRIDGE_GRANT_SHELL
 */

import { BridgeClient, runPromptViaBridge, grantsFromEnv, emptyUsage } from "./bridge-client.js";
import { resolveBridgeConnection, loadConfig } from "./config.js";

function lastUserText(context) {
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
 * Minimal AssistantMessageEventStream stand-in (no pi-ai import).
 */
function createLocalStream() {
  const queue = [];
  let ended = false;
  let wake = null;
  return {
    push(ev) {
      queue.push(ev);
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    end() {
      ended = true;
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
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

function streamSimple(model, context, options) {
  const stream = createLocalStream();
  (async () => {
    try {
      const conn = resolveBridgeConnection();
      const client = new BridgeClient({
        baseUrl: conn.baseUrl,
        token: conn.token,
        unixPath: conn.unixPath,
      });
      const text = lastUserText(context);
      if (!text) {
        throw new Error("no user text in context");
      }
      // Reject image attachments (v1 text-only uplink)
      const messages = context?.messages || [];
      for (const m of messages) {
        if (Array.isArray(m.content) && m.content.some((b) => b?.type === "image")) {
          throw new Error("v1 uplink is text-only; image attachments rejected");
        }
      }
      const env = { ...process.env };
      if (!grantsFromEnv(env).length && conn.grants?.length) {
        env.BRIDGE_GRANTS = conn.grants.join(",");
      }
      await runPromptViaBridge(client, text, {
        signal: options?.signal,
        env,
        model: {
          id: model?.id || "cursor-remote",
          api: model?.api || "cursor-remote-bridge",
          provider: model?.provider || "cursor-remote",
        },
        onStreamEvent: (ev) => {
          if (ev?.type === "_end") return;
          stream.push(ev);
        },
      });
      stream.end();
    } catch (err) {
      const msg = {
        role: "assistant",
        content: [],
        api: "cursor-remote-bridge",
        provider: "cursor-remote",
        model: model?.id || "cursor-remote",
        usage: emptyUsage(),
        stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: msg.stopReason, error: msg });
      stream.end();
    }
  })();
  return stream;
}

/**
 * @param {import('./types.js').ExtensionAPI} pi
 */
export default function register(pi) {
  if (!pi || typeof pi.registerProvider !== "function") {
    throw new Error("pi.registerProvider required (ExtensionAPI)");
  }
  const cfg = loadConfig();
  const conn = resolveBridgeConnection();
  // pi requires baseUrl when models[] is set; real traffic uses BridgeClient
  const baseUrl = conn.baseUrl || cfg?.baseUrl || "http://127.0.0.1:18765";
  pi.registerProvider("cursor-remote", {
    name: "Cursor Remote",
    baseUrl,
    // Custom stream — not openai-completions (that is Level B facade)
    api: "cursor-remote-bridge",
    apiKey: "unused", // bridge auth is Unix/Bearer, not Cursor API key
    streamSimple,
    models: [
      {
        id: "cursor-remote",
        name: "Cursor Remote (stub/SDK via bridge)",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}

export { BridgeClient, runPromptViaBridge, streamSimple, grantsFromEnv, emptyUsage };
export { formatToolArgs, formatToolResult } from "./bridge-client.js";
export { loadConfig, resolveBridgeConnection } from "./config.js";
