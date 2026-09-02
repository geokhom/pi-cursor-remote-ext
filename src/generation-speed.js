/**
 * Decode-ish generation speed (tok/s) for the pi footer.
 *
 * Per request: output_tokens / ((end − firstOutAt) / 1000)
 * Across requests in a session: sum(tokens) / sum(decode_ms/1000)
 *
 * Shown on the stock-style stats line immediately before the context window
 * (`200k (auto)` — Cursor Agent packs context; no fill% / pi auto-compact).
 */

import { truncateToWidth, visibleWidth } from "./tui-width.js";
import { advertisedContextWindow } from "./model-discovery.js";

const STATE_KEY = Symbol.for("pi-cursor-remote.generation-speed.v1");

/**
 * @returns {{
 *   outputTokens: number,
 *   decodeMs: number,
 *   requestRender: (() => void) | null,
 * }}
 */
function state() {
  const g = globalThis;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      outputTokens: 0,
      decodeMs: 0,
      requestRender: null,
    };
  }
  return g[STATE_KEY];
}

export function resetGenerationSpeed() {
  const s = state();
  s.outputTokens = 0;
  s.decodeMs = 0;
}

/**
 * Accumulate one completed decode window (one user prompt / bridge live run).
 * @param {number} outputTokens
 * @param {number} decodeMs  wall time from first out chunk to end
 */
export function recordDecodeSample(outputTokens, decodeMs) {
  const tokens = Math.max(0, Math.floor(Number(outputTokens) || 0));
  const ms = Math.max(0, Math.floor(Number(decodeMs) || 0));
  if (tokens <= 0 || ms <= 0) return;
  const s = state();
  s.outputTokens += tokens;
  s.decodeMs += ms;
  try {
    s.requestRender?.();
  } catch {
    // ignore
  }
}

/**
 * @returns {number | null} tokens per second, or null if no samples
 */
export function getTokPerSec() {
  const s = state();
  if (s.outputTokens <= 0 || s.decodeMs <= 0) return null;
  return (s.outputTokens * 1000) / s.decodeMs;
}

/**
 * @param {number} rate
 * @returns {string}
 */
export function formatTokPerSec(rate) {
  if (!(rate > 0) || !Number.isFinite(rate)) return "";
  if (rate < 10) return `${rate.toFixed(1)} tok/s`;
  if (rate < 100) return `${rate.toFixed(1)} tok/s`;
  return `${Math.round(rate)} tok/s`;
}

/** @returns {string | null} */
export function peekTokPerSecLabel() {
  const rate = getTokPerSec();
  if (rate == null) return null;
  return formatTokPerSec(rate);
}

/**
 * Compact token count (matches stock pi footer).
 * @param {number} count
 */
/** Skip char/4 crumbs from tool-resume turns (input=1) when finding occupancy. */
const MIN_PROMPT_OCCUPANCY = 256;

/**
 * Prompt tokens on one pi usage object (uncached + cache).
 * @param {object | undefined} u
 */
export function promptOccupancyFromPiUsage(u) {
  if (!u || typeof u !== "object") return 0;
  const n =
    (Number(u.input) || 0) +
    (Number(u.cacheRead) || 0) +
    (Number(u.cacheWrite) || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Last significant prompt occupancy in session order (not the cumulative R sum,
 * not the latest input=1 tool-resume turn).
 * When contextWindow is set, skip measurements above it (run-sum / unsafe SDK
 * totals must not drive fill% — same gate as pi-cursor-sdk).
 * @param {object[]} entries
 * @param {number} [contextWindow]
 */
export function lastPromptOccupancy(entries, contextWindow) {
  let last = 0;
  const max =
    Number(contextWindow) > 0 ? Number(contextWindow) : Number.POSITIVE_INFINITY;
  for (const entry of entries || []) {
    /** @type {object | undefined} */
    let u;
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      u = entry.message.usage;
    } else if (entry?.type === "message" && entry.message?.role === "toolResult") {
      u = entry.message.usage;
    } else if (entry?.type === "branch_summary" || entry?.type === "compaction") {
      u = entry.usage;
    }
    const n = promptOccupancyFromPiUsage(u);
    if (n >= MIN_PROMPT_OCCUPANCY && n <= max) last = n;
  }
  return last;
}

/**
 * Compact token count (matches stock pi footer).
 * @param {number} count
 */
export function formatFooterTokens(count) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/**
 * Install a stock-like footer with cumulative Decode-ish tok/s before context %.
 * Wire / other setStatus lines still appear via footerData extension statuses.
 *
 * @param {{
 *   ui?: { setFooter?: Function },
 *   sessionManager?: {
 *     getEntries?: () => object[],
 *     getCwd?: () => string,
 *     getSessionName?: () => string | undefined,
 *   },
 *   model?: { id?: string, provider?: string, contextWindow?: number, reasoning?: boolean },
 *   thinkingLevel?: string,
 *   modelRegistry?: { isUsingOAuth?: (provider: string) => boolean },
 *   getContextUsage?: () => { percent?: number | null, contextWindow?: number } | undefined,
 * }} ctx
 */
export function installGenerationSpeedFooter(ctx) {
  if (!ctx?.ui || typeof ctx.ui.setFooter !== "function") return;

  resetGenerationSpeed();

  ctx.ui.setFooter((tui, theme, footerData) => {
    const s = state();
    s.requestRender = () => {
      try {
        tui.requestRender?.();
      } catch {
        // ignore
      }
    };
    const unsub = footerData?.onBranchChange?.(() => tui.requestRender?.());

    return {
      dispose() {
        if (s.requestRender) s.requestRender = null;
        try {
          unsub?.();
        } catch {
          // ignore
        }
      },
      invalidate() {},
      render(width) {
        return renderSpeedFooter(width, theme, footerData, ctx);
      },
    };
  });
}

/**
 * @param {number} width
 * @param {{ fg: (k: string, t: string) => string, bold?: (t: string) => string }} theme
 * @param {{
 *   getGitBranch?: () => string | null,
 *   getExtensionStatuses?: () => Map<string, string> | ReadonlyMap<string, string>,
 *   getAvailableProviderCount?: () => number,
 * } | null | undefined} footerData
 * @param {Parameters<typeof installGenerationSpeedFooter>[0]} ctx
 */
function renderSpeedFooter(width, theme, footerData, ctx) {
  const w = typeof width === "number" && width > 0 ? width : 80;
  const dim = (t) => (theme?.fg ? theme.fg("dim", t) : t);

  // --- usage totals (same sources as stock FooterComponent) ---
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  /** @type {number | undefined} */
  let latestCacheHitRate;
  /** @type {object | undefined} */
  let lastSignificantUsage;
  const entries =
    typeof ctx.sessionManager?.getEntries === "function"
      ? ctx.sessionManager.getEntries()
      : [];
  for (const entry of entries) {
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const u = entry.message.usage || {};
      input += Number(u.input) || 0;
      output += Number(u.output) || 0;
      cacheRead += Number(u.cacheRead) || 0;
      cacheWrite += Number(u.cacheWrite) || 0;
      cost += Number(u.cost?.total) || 0;
      const n = promptOccupancyFromPiUsage(u);
      // Window filter applied after advertisedWindow is known (below).
      if (n >= MIN_PROMPT_OCCUPANCY) {
        lastSignificantUsage = u;
      }
    } else if (
      entry?.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.usage
    ) {
      const u = entry.message.usage;
      input += Number(u.input) || 0;
      output += Number(u.output) || 0;
      cacheRead += Number(u.cacheRead) || 0;
      cacheWrite += Number(u.cacheWrite) || 0;
      cost += Number(u.cost?.total) || 0;
    } else if (
      (entry?.type === "branch_summary" || entry?.type === "compaction") &&
      entry.usage
    ) {
      const u = entry.usage;
      input += Number(u.input) || 0;
      output += Number(u.output) || 0;
      cacheRead += Number(u.cacheRead) || 0;
      cacheWrite += Number(u.cacheWrite) || 0;
      cost += Number(u.cost?.total) || 0;
    }
  }

  const advertisedWindow = advertisedContextWindow(ctx.model?.id);
  const contextWindow = advertisedWindow;
  if (
    lastSignificantUsage &&
    contextWindow > 0 &&
    promptOccupancyFromPiUsage(lastSignificantUsage) > contextWindow
  ) {
    lastSignificantUsage = undefined;
  }

  if (lastSignificantUsage) {
    const promptTokens = promptOccupancyFromPiUsage(lastSignificantUsage);
    latestCacheHitRate =
      promptTokens > 0
        ? ((Number(lastSignificantUsage.cacheRead) || 0) / promptTokens) * 100
        : undefined;
  }
  let pwd =
    typeof ctx.sessionManager?.getCwd === "function"
      ? String(ctx.sessionManager.getCwd() || "")
      : "";
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && pwd.startsWith(home)) {
    pwd = `~${pwd.slice(home.length)}` || "~";
  }
  const branch = footerData?.getGitBranch?.() || null;
  if (branch) pwd = `${pwd} (${branch})`;
  const sessionName =
    typeof ctx.sessionManager?.getSessionName === "function"
      ? ctx.sessionManager.getSessionName()
      : undefined;
  if (sessionName) pwd = `${pwd} • ${sessionName}`;

  const statsParts = [];
  if (input) statsParts.push(`↑${formatFooterTokens(input)}`);
  if (output) statsParts.push(`↓${formatFooterTokens(output)}`);
  if (cacheRead) statsParts.push(`R${formatFooterTokens(cacheRead)}`);
  if (cacheWrite) statsParts.push(`W${formatFooterTokens(cacheWrite)}`);
  if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
    statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }

  const usingSubscription = Boolean(
    ctx.model &&
      (ctx.model.provider === "kimi-coding" ||
        (typeof ctx.modelRegistry?.isUsingOAuth === "function" &&
          ctx.modelRegistry.isUsingOAuth(ctx.model)))
  );
  if (cost || usingSubscription) {
    statsParts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
  }

  // Decode-ish tok/s — immediately before context window indicator.
  const tokLabel = peekTokPerSecLabel();
  if (tokLabel) statsParts.push(tokLabel);

  // Cursor Agent owns packing — never paint fill% (that trips pi auto-compact).
  const contextLabel =
    contextWindow > 0
      ? `${formatFooterTokens(contextWindow)} (auto)`
      : "? (auto)";
  statsParts.push(contextLabel);

  let statsLeft = statsParts.join(" ");
  const modelName = ctx.model?.id || "no-model";
  let rightSide = modelName;
  if (ctx.model?.reasoning) {
    const thinkingLevel = ctx.thinkingLevel || "off";
    rightSide =
      thinkingLevel === "off"
        ? `${modelName} • thinking off`
        : `${modelName} • ${thinkingLevel}`;
  }
  const providerCount = footerData?.getAvailableProviderCount?.() ?? 0;
  if (providerCount > 1 && ctx.model?.provider) {
    const withProvider = `(${ctx.model.provider}) ${rightSide}`;
    if (
      visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <=
      w
    ) {
      rightSide = withProvider;
    }
  }

  let statsLeftWidth = visibleWidth(statsLeft);
  if (statsLeftWidth > w) {
    statsLeft = truncateToWidth(statsLeft, w, "...");
    statsLeftWidth = visibleWidth(statsLeft);
  }

  const minPadding = 2;
  const rightSideWidth = visibleWidth(rightSide);
  let statsLine;
  if (statsLeftWidth + minPadding + rightSideWidth <= w) {
    const padding = " ".repeat(w - statsLeftWidth - rightSideWidth);
    statsLine = dim(statsLeft) + dim(padding + rightSide);
  } else {
    const availableForRight = w - statsLeftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
      const truncatedRightWidth = visibleWidth(truncatedRight);
      const padding = " ".repeat(
        Math.max(0, w - statsLeftWidth - truncatedRightWidth)
      );
      statsLine = dim(statsLeft) + dim(padding + truncatedRight);
    } else {
      statsLine = dim(statsLeft);
    }
  }

  const lines = [
    truncateToWidth(dim(pwd), w, dim("...")),
    statsLine,
  ];

  const extensionStatuses = footerData?.getExtensionStatuses?.();
  if (extensionStatuses && extensionStatuses.size > 0) {
    const sorted = Array.from(extensionStatuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) =>
        String(text || "")
          .replace(/[\r\n\t]/g, " ")
          .replace(/ +/g, " ")
          .trim()
      )
      .filter(Boolean);
    if (sorted.length) {
      lines.push(truncateToWidth(sorted.join(" "), w, dim("...")));
    }
  }

  return lines;
}

export {
  renderSpeedFooter as _renderSpeedFooterForTests,
};
