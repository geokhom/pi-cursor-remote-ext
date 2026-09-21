/**
 * Register shadow tools (display names without contour__) that return stashed
 * bridge results. Agent loop then paints ToolExecutionComponent with
 * success/error backgrounds — same UX as local bash/read.
 *
 * render() MUST truncate to the given width — pi crashes on overflow:
 * "Rendered line N exceeds terminal width".
 */

import {
  activeShadowNames,
  displayToolName,
  setMcpWireTools,
  shadowToolNames,
} from "./tool-display.js";
import { takeToolResult, hasFollowUpText, hasToolResult } from "./result-stash.js";
import {
  applyToolCallTheme,
  formatToolCallLines,
  formatToolDurationLine,
  formatToolResult,
  hasActiveLiveRun,
  isToolExecutionError,
  layoutToolPanelLines,
} from "./bridge-client.js";
import { truncateToWidth } from "./tui-width.js";
import { MODEL_VALUE_SET, resolveToolCallLineLimits } from "./config.js";

/** Loose JSON Schema — accepted by pi's typebox/json validator path. */
const ANY_OBJECT = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

/** Match stock pi bash preview (last N lines + expand hint). */
const TOOL_PREVIEW_LINES_TAIL = 5;
/** Match stock pi grep/find/ls (first N lines + expand hint). */
const TOOL_PREVIEW_LINES_HEAD = 15;

/** Match pi_cursor_wire.constants.TOOL_WAIT (shell/VPS wait cap). */
const STASH_WAIT_MS = 600_000;

const STASH_POLL_MS = 50;

/** @type {Set<string>} */
const _registeredShadows = new Set();

/**
 * Last-N physical lines (stock bash uses visual wrap; good enough without pi-tui).
 * @param {string} text
 * @param {number} maxLines
 */
export function truncateToLastLines(text, maxLines) {
  const lines = String(text ?? "").split(/\r\n|\n|\r/);
  if (lines.length <= maxLines) {
    return { lines, skipped: 0 };
  }
  return {
    lines: lines.slice(-maxLines),
    skipped: lines.length - maxLines,
  };
}

/**
 * Shell: last N lines (pi bash). Grep/find/ls/read/MCP: first N (pi grep/find).
 * @param {string} displayName
 * @param {string} text
 * @param {boolean} [expanded]
 * @returns {{ lines: string[], skipped: number, fromStart: boolean }}
 */
export function previewToolResultLines(displayName, text, expanded = false) {
  const lines = String(text ?? "").split(/\r\n|\n|\r/);
  const tail =
    displayName === "shell" || displayName === "bash";
  if (expanded) return { lines, skipped: 0, fromStart: !tail };
  const max = tail ? TOOL_PREVIEW_LINES_TAIL : TOOL_PREVIEW_LINES_HEAD;
  if (lines.length <= max) return { lines, skipped: 0, fromStart: !tail };
  if (tail) {
    return {
      lines: lines.slice(-max),
      skipped: lines.length - max,
      fromStart: false,
    };
  }
  return {
    lines: lines.slice(0, max),
    skipped: lines.length - max,
    fromStart: true,
  };
}

function isDurationFooter(row) {
  return /^(Took|Elapsed) \d+\.\d+s$/.test(String(row ?? "").trim());
}

/**
 * Paint logical lines as TUI rows. Height = array length (newlines already split).
 * Empty rows are a space so the Box background does not tear.
 * @param {string[] | ((width: number) => string[])} linesOrFn
 * @param {{ theme?: { fg: (name: string, text: string) => string, bold: (text: string) => string }, color?: string, bold?: boolean, maxLines?: number, precolored?: boolean }} [style]
 */
function panelLinesComponent(linesOrFn, style = {}) {
  return {
    render(width) {
      const w = typeof width === "number" && width > 0 ? width : 80;
      const raw = typeof linesOrFn === "function" ? linesOrFn(w) : linesOrFn;
      const rows = layoutToolPanelLines(raw && raw.length ? raw : [""], w, {
        maxLines: style.maxLines,
      });
      return rows.map((row) => {
        let styled = row;
        if (style.theme && isDurationFooter(row)) {
          styled = style.theme.fg("dim", row);
        } else if (!style.precolored && style.theme && style.color) {
          styled = style.bold
            ? style.theme.fg(style.color, style.theme.bold(row))
            : style.theme.fg(style.color, row);
        }
        // Always clip: wrap can still under-count vs pi-tui wcwidth.
        return truncateToWidth(styled, w);
      });
    },
    invalidate() {},
  };
}

/**
 * Pi's agent loop ignores execute() `isError` (only throws or this hook
 * paint toolErrorBg). Return `{ isError: true }` and nothing else so the
 * field-by-field merge keeps content. Same pattern as pi-mcp-adapter.
 *
 * @param {unknown} details
 * @returns {{ isError: true } | undefined}
 */
export function toolErrorOverride(details) {
  if (!details || typeof details !== "object") return undefined;
  if (/** @type {{ ok?: unknown }} */ (details).ok === false) {
    return { isError: true };
  }
  return undefined;
}

/**
 * @param {unknown} content
 * @param {boolean} [ok]
 * @returns {string}
 */
function contentToText(content, ok = true) {
  return formatToolResult(content, ok);
}

/**
 * Drain waits for tool_executed before toolUse, but a closed feeder / race
 * can still leave stash empty. Wait while the live SSE session is open
 * instead of immediately returning "No bridge result".
 * @param {string} callId
 * @param {string} displayName
 * @param {number} [timeoutMs]
 */
export async function takeToolResultWhenReady(
  callId,
  displayName,
  timeoutMs = STASH_WAIT_MS
) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (hasToolResult(callId, displayName)) {
      return takeToolResult(callId, displayName);
    }
    if (!hasActiveLiveRun()) break;
    await new Promise((r) => setTimeout(r, STASH_POLL_MS));
  }
  return takeToolResult(callId, displayName);
}

/**
 * @param {unknown} result
 * @param {unknown} context
 * @param {{ isPartial?: boolean }} [options]
 * @returns {number | undefined}
 */
function resolveToolDurationMs(result, context, options) {
  const details = result && typeof result === "object" ? /** @type {{ details?: { durationMs?: unknown } }} */ (result).details : undefined;
  const fromDetails = details?.durationMs;
  if (typeof fromDetails === "number" && Number.isFinite(fromDetails) && fromDetails >= 0) {
    return fromDetails;
  }
  const state = context && typeof context === "object" ? /** @type {{ state?: { startedAt?: unknown, endedAt?: unknown } }} */ (context).state : undefined;
  const started = state?.startedAt;
  if (typeof started === "number" && Number.isFinite(started)) {
    if (!options?.isPartial && state && state.endedAt === undefined) {
      state.endedAt = Date.now();
    }
    const end = typeof state?.endedAt === "number" ? state.endedAt : Date.now();
    return Math.max(0, end - started);
  }
  return undefined;
}

/**
 * @param {string} displayName
 */
function makeShadowTool(displayName) {
  return {
    name: displayName,
    label: displayName,
    description: `Cursor Remote contour tool (${displayName}) — results from local-bridge`,
    // Omit promptSnippet so default system prompt does not advertise these.
    parameters: ANY_OBJECT,
    executionMode: "parallel",
    renderCall(args, theme, context) {
      const state = context?.state;
      if (state && context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
      }
      const expanded = Boolean(context?.expanded);
      const limits = resolveToolCallLineLimits();
      return panelLinesComponent(
        (width) =>
          formatToolCallLines(displayName, args, {
            width,
            theme,
            expanded,
            maxLines: expanded ? limits.expand : limits.preview,
          }),
        { theme, precolored: true }
      );
    },
    renderResult(result, options, theme, context) {
      const text = (result?.content || [])
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      const durationLine = formatToolDurationLine(
        resolveToolDurationMs(result, context, options),
        { partial: Boolean(options?.isPartial) && !context?.isError },
      );
      const isError = Boolean(result?.isError || context?.isError);
      const color = isError ? "error" : "toolOutput";
      const expanded = Boolean(options?.expanded);
      const editLike =
        displayName === "str_replace" || displayName === "edit";
      /** @param {string[]} rows */
      const withDuration = (rows) =>
        durationLine ? [...rows, durationLine] : rows;
      /** @param {string[]} rows */
      const paint = (rows, maxLines) => {
        if (editLike && !isError && theme) {
          return panelLinesComponent(
            (width) =>
              applyToolCallTheme(
                displayName,
                layoutToolPanelLines(withDuration(rows), width, { maxLines }),
                theme,
              ),
            { theme, precolored: true },
          );
        }
        return panelLinesComponent(withDuration(rows), {
          theme,
          color,
          maxLines,
        });
      };
      if (!text) {
        return paint(durationLine ? [] : [""]);
      }
      if (expanded) {
        return paint(text.split(/\r?\n/), 80);
      }
      const { lines: preview, skipped, fromStart } = previewToolResultLines(
        displayName,
        text,
        false,
      );
      if (skipped > 0) {
        const hint = fromStart
          ? `... (${skipped} more lines, Ctrl+O to expand)`
          : `... (${skipped} earlier lines, Ctrl+O to expand)`;
        const body = fromStart ? [...preview, hint] : [hint, ...preview];
        return paint(body);
      }
      return paint(editLike ? preview : ["", ...preview]);
    },
    async execute(toolCallId, _params, _signal, onUpdate, _ctx) {
      const execStarted = Date.now();
      const stashed = await takeToolResultWhenReady(toolCallId, displayName);
      // Continue the agent loop while live SSE still has turns, or legacy follow-up.
      const terminate = !hasFollowUpText() && !hasActiveLiveRun();
      if (!stashed) {
        return {
          content: [
            {
              type: "text",
              text:
                `No bridge result for ${displayName} (${toolCallId}). ` +
                "This tool only completes Cursor Remote runs.",
            },
          ],
          details: { ok: false, durationMs: Date.now() - execStarted },
          isError: true,
          terminate,
        };
      }
      const isError = isToolExecutionError(stashed.ok, stashed.content);
      const body = contentToText(stashed.content, !isError);
      const durationMs =
        typeof stashed.durationMs === "number" && Number.isFinite(stashed.durationMs)
          ? stashed.durationMs
          : Date.now() - execStarted;
      const result = {
        content: [
          { type: "text", text: body || (isError ? "(failed)" : "(ok)") },
        ],
        details: { wireName: stashed.name, ok: !isError, durationMs },
        isError,
        terminate,
      };
      if (typeof onUpdate === "function") onUpdate(result);
      return result;
    },
  };
}

/**
 * @param {unknown} model
 * @returns {boolean}
 */
export function isCursorRemoteModel(model) {
  const m = /** @type {{ provider?: string, api?: string, id?: string } | null} */ (model);
  return (
    m?.provider === "cursor-remote" ||
    m?.api === "cursor-remote-bridge" ||
    m?.id === "cursor-remote" ||
    (typeof m?.id === "string" &&
      (MODEL_VALUE_SET.has(m.id) ||
        m.id.startsWith("composer-") ||
        m.id.includes("@") ||
        m.id.includes(":")))
  );
}

/**
 * Keep shadows when the model is unknown (session_start race). Stripping on
 * null caused "Tool shell not found" on the first prompt.
 * @param {unknown} model
 * @returns {boolean}
 */
export function shouldActivateShadows(model) {
  if (model == null) return true;
  return isCursorRemoteModel(model);
}

/**
 * @param {unknown} listed `getAllTools()` / `getActiveTools()` payload
 * @returns {string[]}
 */
export function extractToolNames(listed) {
  if (!Array.isArray(listed)) return [];
  const out = [];
  const seen = new Set();
  for (const t of listed) {
    const n = typeof t === "string" ? t : t && typeof t.name === "string" ? t.name : "";
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Replace (do not merge) the active set on Cursor Remote so Pi builtins, MCP
 * adapter schemas, and other extensions drop out of `/context`. Off Cursor
 * Remote, restore non-shadow tools. `remembered` keeps foreign names after a
 * replace when `getAllTools` is unavailable and `getActiveTools` is already
 * shadows-only.
 *
 * @param {string[] | unknown} listed
 * @param {unknown} model
 * @param {string[]} [remembered]
 * @returns {{ active: string[], foreign: string[] }}
 */
export function nextActiveToolNames(listed, model, remembered = []) {
  const shadow = new Set(shadowToolNames());
  const foreign = extractToolNames(listed).filter((n) => !shadow.has(n));
  const keep = foreign.length ? foreign : extractToolNames(remembered);
  if (shouldActivateShadows(model)) {
    return { active: activeShadowNames(), foreign: keep };
  }
  return { active: keep, foreign: keep };
}

/**
 * @param {import('./types.js').ExtensionAPI} pi
 */
export function registerShadowTools(pi) {
  if (!pi || typeof pi.registerTool !== "function") {
    return { syncActive: () => {}, syncMcpShadows: async () => {}, ensureShadow: () => {} };
  }

  /**
   * @param {string} name
   */
  const ensureShadow = (name) => {
    if (_registeredShadows.has(name)) return;
    pi.registerTool(makeShadowTool(name));
    _registeredShadows.add(name);
  };

  for (const name of shadowToolNames()) {
    ensureShadow(name);
  }

  /** @type {string[]} */
  let rememberedForeign = [];

  /**
   * Agent-loop snapshots `context.tools` at turn start. Mid-stream
   * setActiveTools (inside streamSimple) is too late — execute sees the old
   * list and returns "Tool shell not found". Activate before the snapshot.
   * Cursor Remote: replace with display shadows only (not merge).
   * @param {unknown} model
   */
  const syncActive = (model) => {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
      return;
    }
    const shadow = new Set(shadowToolNames());
    for (const name of shadow) ensureShadow(name);
    const listed =
      typeof pi.getAllTools === "function"
        ? extractToolNames(pi.getAllTools())
        : extractToolNames(pi.getActiveTools() || []);
    const { active, foreign } = nextActiveToolNames(listed, model, rememberedForeign);
    rememberedForeign = foreign;
    pi.setActiveTools(active);
  };

  /**
   * Pull MCP tools from bridge and register shadows (call after session handshake).
   * @param {import('./bridge-client.js').BridgeClient | null | undefined} client
   * @param {unknown} [model]
   */
  const syncMcpShadows = async (client, model) => {
    if (!client || typeof client.getMcpTools !== "function") return;
    try {
      const snap = await client.getMcpTools();
      const wires = (snap?.tools || [])
        .map((t) => (t && typeof t.name === "string" ? t.name : null))
        .filter(Boolean);
      setMcpWireTools(wires);
      for (const name of shadowToolNames()) ensureShadow(name);
      syncActive(model);
      return snap;
    } catch {
      // MCP optional; keep core shadows
      return null;
    }
  };

  if (typeof pi.on === "function") {
    pi.on("tool_result", (ev) => toolErrorOverride(ev?.details));
    pi.on("model_select", (ev) => {
      syncActive(ev?.model);
    });
    pi.on("session_start", (_ev, ctx) => {
      // Use current model — do NOT clear with null (that dropped shell/read_file
      // from the active set and caused "Tool shell not found" on first prompt).
      syncActive(ctx?.model);
    });
    pi.on("before_agent_start", (_ev, ctx) => {
      syncActive(ctx?.model);
    });
  }

  return { syncActive, syncMcpShadows, ensureShadow };
}

export {
  activeShadowNames,
  displayToolName,
  setMcpWireTools,
  shadowToolNames,
};
export { truncateToWidth, visibleWidth } from "./tui-width.js";
