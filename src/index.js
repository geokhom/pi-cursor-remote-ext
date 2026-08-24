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

import {
  BridgeClient,
  runPromptViaBridge,
  resumeBridgeLiveTurn,
  runPromptViaBridgeComplete,
  hasActiveLiveRun,
  grantsFromEnv,
  emptyUsage,
  handshakeWorkspaceCwd,
  resolveWorkspaceCwd,
} from "./bridge-client.js";
import {
  resolveBridgeConnection,
  loadConfig,
  coerceModel,
  DEFAULT_MODEL,
} from "./config.js";
import { registerShadowTools } from "./shadow-tools.js";
import { takeFollowUp } from "./result-stash.js";
import { displayToolNames } from "./tool-display.js";
import { bindThinkingUi, clearThinkingIndicator } from "./thinking-indicator.js";
import {
  buildCursorModelSelection,
  fallbackProviderModels,
  cachedProviderModels,
  bootstrapProviderModels,
  saveModelsCache,
  registerModelItems,
  resolveModelOrFallback,
} from "./model-discovery.js";
import { installGenerationSpeedFooter } from "./generation-speed.js";
import { installMcpAutoRefresh } from "./mcp-auto-refresh.js";

/** @type {import('./types.js').ExtensionAPI | null} */
let _piRef = null;
/** @type {BridgeClient | null} */
let _bridgeClient = null;
/** @type {string} */
let _baseUrl = "http://127.0.0.1:18765";
/** @type {unknown} */
let _lastModel = null;

/**
 * After bridge restart, pi may still be up without a VPS session — handshake
 * cwd + wait for live models before the first prompt (avoids cwd_required /
 * 3-id fallback until manual /reload).
 * @param {{ sessionManager?: { getCwd?: () => string }, ui?: { notify?: Function }, model?: { id?: string } } | null | undefined} [ctx]
 */
async function ensureCursorRemoteSession(ctx) {
  const client = _bridgeClient;
  if (!client) return;
  let ready = false;
  try {
    const s = await client.getSession();
    ready = Boolean(s?.ok && s.ready && s.cwd);
  } catch {
    ready = false;
  }
  if (!ready) {
    await handshakeWorkspaceCwd(client, ctx || {}, ctx);
  }
  const next = await fetchProviderModels(client, {
    timeoutMs: ready ? 8000 : 20000,
    preferLive: true,
  });
  if (_piRef) {
    registerCursorRemoteProvider(_piRef, next);
  }
  const cur =
    ctx?.model?.id ||
    (typeof _lastModel === "object" && _lastModel && "id" in /** @type {object} */ (_lastModel)
      ? /** @type {{ id?: string }} */ (_lastModel).id
      : undefined);
  if (cur && next.length) {
    resolveModelOrFallback(cur, next);
  }
}

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

function createProviderConfig(models) {
  return {
    name: "Cursor Remote",
    baseUrl: _baseUrl,
    api: "cursor-remote-bridge",
    apiKey: "unused",
    streamSimple,
    models,
  };
}

function registerCursorRemoteProvider(pi, models) {
  pi.registerProvider("cursor-remote", createProviderConfig(models));
}

/**
 * @param {BridgeClient} client
 * @param {{ timeoutMs?: number, preferLive?: boolean }} [opts]
 */
async function fetchProviderModels(client, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 0;
  const preferLive = opts.preferLive !== false;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  let last = null;
  for (;;) {
    try {
      const json = await client.getModels();
      if (json?.ok && Array.isArray(json.models) && json.models.length) {
        last = registerModelItems(json.models);
        if (json.live || json.models.length > 3) {
          try {
            saveModelsCache(json.models);
          } catch {
            // cache is best-effort
          }
        }
        if (!preferLive || json.live || !deadline) {
          return last;
        }
      }
    } catch {
      // bridge not ready / no catalog yet
    }
    if (!deadline || Date.now() >= deadline) {
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return last || fallbackProviderModels();
}

function streamSimple(model, context, options) {
  const stream = createLocalStream();
  (async () => {
    try {
      if (_piRef && typeof _piRef.setActiveTools === "function") {
        const shadow = displayToolNames();
        const cur = _piRef.getActiveTools?.() || [];
        const merged = [...new Set([...cur.filter((n) => !shadow.includes(n)), ...shadow])];
        _piRef.setActiveTools(merged);
      }

      _lastModel = model || _lastModel;
      try {
        await ensureCursorRemoteSession({
          sessionManager: context?.sessionManager,
          ui: context?.ui,
          model,
        });
      } catch (err) {
        // Surface cwd/open failures instead of opaque later 409s.
        throw err instanceof Error ? err : new Error(String(err));
      }

      // Legacy follow-up (pre multi-turn drain); prefer live-run resume.
      const followUp = takeFollowUp();
      if (followUp != null) {
        const output = {
          role: "assistant",
          content: [],
          api: model?.api || "cursor-remote-bridge",
          provider: model?.provider || "cursor-remote",
          model: model?.id || DEFAULT_MODEL,
          usage: emptyUsage(),
          stopReason: "pending",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: output });
        let n = 0;
        if (followUp.thinking) {
          const idx = output.content.length;
          output.content.push({ type: "thinking", thinking: "" });
          stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
          output.content[idx].thinking = followUp.thinking;
          n += followUp.thinking.length;
          stream.push({
            type: "thinking_delta",
            contentIndex: idx,
            delta: followUp.thinking,
            partial: output,
          });
          stream.push({
            type: "thinking_end",
            contentIndex: idx,
            content: followUp.thinking,
            partial: output,
          });
        }
        if (followUp.text) {
          const idx = output.content.length;
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: idx, partial: output });
          output.content[idx].text = followUp.text;
          n += followUp.text.length;
          stream.push({
            type: "text_delta",
            contentIndex: idx,
            delta: followUp.text,
            partial: output,
          });
          stream.push({
            type: "text_end",
            contentIndex: idx,
            content: followUp.text,
            partial: output,
          });
        }
        output.usage.output = Math.max(1, Math.ceil(n / 4));
        output.usage.totalTokens = output.usage.output;
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
        return;
      }

      const conn = resolveBridgeConnection();
      if (!conn.baseUrl && !conn.unixPath) {
        throw new Error(
          "Bridge not configured: create ~/.pi/agent/cursor-remote.json " +
            "(copy pack/contour-bridge/cursor-remote.example.json), set bridgeToken, " +
            "then start local-bridge (./pack/contour-bridge/run_bridge.sh). " +
            "Or set BRIDGE_URL + BRIDGE_LOCAL_TOKEN / BRIDGE_UNIX_PATH."
        );
      }
      const client = new BridgeClient({
        baseUrl: conn.baseUrl,
        token: conn.token,
        unixPath: conn.unixPath,
      });
      const thinkingLevel =
        options?.thinkingLevel ||
        options?.reasoning ||
        context?.thinkingLevel ||
        "off";
      const piModelId = typeof model?.id === "string" ? model.id : DEFAULT_MODEL;
      const modelSelection = buildCursorModelSelection(piModelId, thinkingLevel);
      const streamOpts = {
        signal: options?.signal,
        thinkingDisplay: conn.thinkingDisplay,
        wireStats: conn.wireStats,
        modelSelection,
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
      };

      // Resume open SSE after toolUse (stock pi-cursor-sdk live-run pattern).
      if (hasActiveLiveRun()) {
        await resumeBridgeLiveTurn(streamOpts);
        stream.end();
        clearThinkingIndicator();
        return;
      }

      const text = lastUserText(context);
      if (!text) {
        throw new Error("no user text in context");
      }
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
        ...streamOpts,
        env,
      });
      stream.end();
      clearThinkingIndicator();
    } catch (err) {
      clearThinkingIndicator();
      const msg = {
        role: "assistant",
        content: [],
        api: "cursor-remote-bridge",
        provider: "cursor-remote",
        model: model?.id || DEFAULT_MODEL,
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
export default async function register(pi) {
  if (!pi || typeof pi.registerProvider !== "function") {
    throw new Error("pi.registerProvider required (ExtensionAPI)");
  }
  _piRef = pi;
  const cfg = loadConfig();
  const conn = resolveBridgeConnection();
  _baseUrl = conn.baseUrl || cfg?.baseUrl || "http://127.0.0.1:18765";

  const captureUi = (_event, ctx) => {
    if (ctx?.ui) bindThinkingUi(ctx.ui);
  };

  let models;
  try {
    models = bootstrapProviderModels();
  } catch {
    models = fallbackProviderModels();
  }

  // Register immediately so pi TUI has a model + slash commands even if the
  // bridge GET /models hangs (no HTTP timeout on the client).
  registerCursorRemoteProvider(pi, models);

  const client =
    conn.baseUrl || conn.unixPath
      ? new BridgeClient({
          baseUrl: conn.baseUrl,
          token: conn.token,
          unixPath: conn.unixPath,
        })
      : null;
  _bridgeClient = client;

  /** @type {{ syncMcpShadows?: Function } | null} */
  const shadowApi = registerShadowTools(pi);

  /** @type {{ notify?: Function } | null} */
  let lastUi = null;

  installMcpAutoRefresh({
    pi,
    client,
    shadowApi,
    getModel: () => _lastModel,
    notify: (msg, level) => {
      try {
        lastUi?.notify?.(msg, level || "info");
      } catch {
        // ignore
      }
    },
  });

  if (typeof pi.on === "function") {
    pi.on("session_start", async (event, ctx) => {
      captureUi(event, ctx);
      _lastModel = ctx?.model || event?.model || _lastModel;
      if (ctx?.ui) lastUi = ctx.ui;
      installGenerationSpeedFooter(ctx);
      if (!client) return;
      try {
        await ensureCursorRemoteSession(ctx);
      } catch {
        // notify already emitted from handshake
      }
      try {
        const mcpSnap = await shadowApi?.syncMcpShadows?.(client, ctx?.model);
        const errs = mcpSnap?.errors;
        if (Array.isArray(errs) && errs.length) {
          const detail = errs
            .map((e) => `${e?.server || "?"}: ${e?.error || "failed"}`)
            .join("; ");
          ctx?.ui?.notify?.(`MCP catalog errors: ${detail}`, "warning");
        }
      } catch {
        // MCP optional
      }
      try {
        const next = await fetchProviderModels(client, {
          timeoutMs: 20000,
          preferLive: true,
        });
        registerCursorRemoteProvider(pi, next);
        const cur = ctx?.model?.id || event?.model?.id;
        const curProv = ctx?.model?.provider || event?.model?.provider;
        const resolved = resolveModelOrFallback(cur, next);
        if (curProv && curProv !== "cursor-remote" && typeof ctx?.ui?.notify === "function") {
          ctx.ui.notify(
            `Session model is ${curProv}/${cur || "?"}. Switch to Cursor Remote (${resolved}).`,
            "warning"
          );
        } else if (
          cur &&
          resolved !== cur &&
          !String(resolved).startsWith(String(cur).split(/[@:]/)[0]) &&
          typeof ctx?.ui?.notify === "function"
        ) {
          // Only warn when base id truly missing (not :slow / @context rematch).
          const baseCur = String(cur).split(/[@:]/)[0];
          const baseRes = String(resolved).split(/[@:]/)[0];
          if (baseCur !== baseRes) {
            ctx.ui.notify(
              `Model "${cur}" unavailable; falling back to ${resolved}.`,
              "warning"
            );
          }
        } else if (next.length > 3 && typeof ctx?.ui?.notify === "function") {
          ctx.ui.notify(
            `Cursor Remote models ready (${next.length}).`,
            "info"
          );
        }
      } catch {
        // keep previous registration
      }
    });
    pi.on("before_agent_start", async (event, ctx) => {
      captureUi(event, ctx);
      _lastModel = ctx?.model || _lastModel;
      if (ctx?.ui) lastUi = ctx.ui;
      if (client) {
        try {
          await ensureCursorRemoteSession(ctx);
        } catch {
          // prompt path will surface the error
        }
      }
    });
    pi.on("model_select", (_event, ctx) => {
      captureUi(_event, ctx);
      _lastModel = ctx?.model || _lastModel;
      if (ctx?.ui) lastUi = ctx.ui;
    });
  }

  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("cursor-remote-refresh-models", {
      description: "Refresh Cursor Remote model catalog from the VPS via local-bridge",
      handler: async (_args, ctx) => {
        if (!client) {
          ctx?.ui?.notify?.("Bridge not configured; cannot refresh models.", "warning");
          return;
        }
        try {
          await client.refreshModels({ force: true });
          // Give bridge a moment to receive models_catalog SSE.
          await new Promise((r) => setTimeout(r, 800));
          const next = await fetchProviderModels(client);
          registerCursorRemoteProvider(pi, next);
          const n = next.length;
          ctx?.ui?.notify?.(
            `Cursor Remote catalog refreshed (${n} model${n === 1 ? "" : "s"}).`,
            "info"
          );
        } catch (err) {
          ctx?.ui?.notify?.(
            `Model refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            "error"
          );
        }
      },
    });
    pi.registerCommand("cursor-remote-refresh-mcp", {
      description: "Refresh MCP tools on local-bridge (reopens VPS session)",
      handler: async (_args, ctx) => {
        if (!client) {
          ctx?.ui?.notify?.("Bridge not configured; cannot refresh MCP.", "warning");
          return;
        }
        try {
          const snap = await client.refreshMcp({});
          await shadowApi?.syncMcpShadows?.(client, ctx?.model);
          const n = Array.isArray(snap?.tools) ? snap.tools.length : 0;
          const trunc = snap?.truncated ? ` (truncated ${snap.truncated})` : "";
          const errn = Array.isArray(snap?.errors) ? snap.errors.length : 0;
          const extra = errn ? `; ${errn} catalog error${errn === 1 ? "" : "s"}` : "";
          ctx?.ui?.notify?.(
            `MCP tools refreshed (${n} tool${n === 1 ? "" : "s"})${trunc}${extra}.`,
            errn ? "warning" : "info"
          );
        } catch (err) {
          ctx?.ui?.notify?.(
            `MCP refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            "error"
          );
        }
      },
    });
  }
}

export {
  BridgeClient,
  runPromptViaBridge,
  resumeBridgeLiveTurn,
  runPromptViaBridgeComplete,
  hasActiveLiveRun,
  streamSimple,
  grantsFromEnv,
  emptyUsage,
  handshakeWorkspaceCwd,
  resolveWorkspaceCwd,
};
export {
  formatToolArgs,
  formatToolResult,
  joinThinkingChunk,
  assertUnixSocketSafe,
} from "./bridge-client.js";
export { displayToolName } from "./tool-display.js";
export {
  loadConfig,
  resolveBridgeConnection,
  coerceThinkingDisplay,
  coerceWireStats,
  coerceModel,
  DEFAULT_MODEL,
  MODEL_VALUES,
  MODEL_DISPLAY_NAMES,
} from "./config.js";
export {
  bindThinkingUi,
  showThinkingIndicator,
  clearThinkingIndicator,
  setWireStatus,
  clearWireStatus,
  formatBytes,
} from "./thinking-indicator.js";
export {
  buildCursorModelSelection,
  registerModelItems,
  fallbackProviderModels,
  encodePiModelId,
  parsePiModelId,
  cachedProviderModels,
  bootstrapProviderModels,
  saveModelsCache,
  loadModelsCache,
  modelsCachePath,
} from "./model-discovery.js";
export { tryApplyWireUsage, applyCursorSdkUsage } from "./usage-accounting.js";
export {
  recordDecodeSample,
  resetGenerationSpeed,
  getTokPerSec,
  formatTokPerSec,
  peekTokPerSecLabel,
  installGenerationSpeedFooter,
} from "./generation-speed.js";
