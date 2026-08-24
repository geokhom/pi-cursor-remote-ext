/**
 * Register shadow tools (display names without contour__) that return stashed
 * bridge results. Agent loop then paints ToolExecutionComponent with
 * success/error backgrounds — same UX as local bash/read.
 *
 * render() MUST truncate to the given width — pi crashes on overflow:
 * "Rendered line N exceeds terminal width".
 */

import { displayToolNames, displayToolName, setMcpWireTools } from "./tool-display.js";
import { takeToolResult, hasFollowUpText } from "./result-stash.js";
import { formatToolArgs, formatToolResult, hasActiveLiveRun } from "./bridge-client.js";
import { MODEL_VALUE_SET } from "./config.js";

/** Loose JSON Schema — accepted by pi's typebox/json validator path. */
const ANY_OBJECT = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

/** Match stock pi bash preview (last N lines + expand hint). */
const TOOL_PREVIEW_LINES = 5;

/** CSI / OSC / simple ANSI — stripped for visible width only. */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

/** @type {Set<string>} */
const _registeredShadows = new Set();


/**
 * Visible column width (ANSI ignored; code points ≈ 1 column — enough for shell).
 * @param {string} text
 */
export function visibleWidth(text) {
  if (!text) return 0;
  return [...String(text).replace(ANSI_RE, "")].length;
}

/**
 * Truncate to max visible columns, preserving leading ANSI where possible.
 * @param {string} text
 * @param {number} maxWidth
 * @param {string} [ellipsis]
 */
export function truncateToWidth(text, maxWidth, ellipsis = "…") {
  const s = String(text ?? "");
  if (!(maxWidth > 0)) return "";
  if (visibleWidth(s) <= maxWidth) return s;
  const ellW = visibleWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellW);
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\u001b") {
      ANSI_RE.lastIndex = i;
      const m = ANSI_RE.exec(s);
      if (m && m.index === i) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = String.fromCodePoint(s.codePointAt(i));
    if (w + 1 > budget) break;
    out += cp;
    w += 1;
    i += cp.length;
  }
  return out + ellipsis;
}

/**
 * Last-N physical lines (stock bash uses visual wrap; good enough without pi-tui).
 * @param {string} text
 * @param {number} maxLines
 */
export function truncateToLastLines(text, maxLines) {
  const lines = String(text ?? "").split("\n");
  if (lines.length <= maxLines) {
    return { lines, skipped: 0 };
  }
  return {
    lines: lines.slice(-maxLines),
    skipped: lines.length - maxLines,
  };
}

/**
 * Minimal pi-tui Component — truncates every line to render(width).
 * @param {string[] | (() => string[])} linesOrFn
 */
function linesComponent(linesOrFn) {
  return {
    render(width) {
      const w = typeof width === "number" && width > 0 ? width : 80;
      const raw = typeof linesOrFn === "function" ? linesOrFn() : linesOrFn;
      const lines = raw && raw.length ? raw : [""];
      return lines.map((line) => truncateToWidth(line, w));
    },
    invalidate() {},
  };
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function contentToText(content) {
  return formatToolResult(content, true);
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
    renderCall(args, theme) {
      const argLine = formatToolArgs(args);
      const title =
        displayName === "shell" && argLine
          ? `$ ${argLine}`
          : argLine
            ? `$ ${displayName} ${argLine}`
            : `$ ${displayName}`;
      return linesComponent([theme.fg("toolTitle", theme.bold(title))]);
    },
    renderResult(result, options, theme) {
      const text = (result?.content || [])
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      if (!text) return linesComponent([]);
      const color = result?.isError ? "error" : "toolOutput";
      const expanded = Boolean(options?.expanded);
      if (expanded) {
        const lines = text.split("\n").map((l) => theme.fg(color, l));
        return linesComponent(lines);
      }
      const { lines: preview, skipped } = truncateToLastLines(text, TOOL_PREVIEW_LINES);
      const styled = preview.map((l) => theme.fg(color, l));
      if (skipped > 0) {
        const hint = theme.fg(
          "muted",
          `... (${skipped} earlier lines, Ctrl+O to expand)`
        );
        return linesComponent(["", hint, ...styled]);
      }
      return linesComponent(styled.length ? ["", ...styled] : []);
    },
    async execute(toolCallId, _params, _signal, onUpdate, _ctx) {
      const stashed = takeToolResult(toolCallId, displayName);
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
          details: {},
          isError: true,
          terminate,
        };
      }
      const body = contentToText(stashed.content);
      const result = {
        content: [{ type: "text", text: body || (stashed.ok ? "(ok)" : "(failed)") }],
        details: { wireName: stashed.name, ok: stashed.ok },
        isError: stashed.ok === false,
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
function isCursorRemoteModel(model) {
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

  for (const name of displayToolNames()) {
    ensureShadow(name);
  }

  /**
   * Agent-loop snapshots `context.tools` at turn start. Mid-stream
   * setActiveTools (inside streamSimple) is too late — execute sees the old
   * list and returns "Tool shell not found". Activate before the snapshot.
   * @param {unknown} model
   */
  const syncActive = (model) => {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
      return;
    }
    const shadow = new Set(displayToolNames());
    for (const name of shadow) ensureShadow(name);
    const current = pi.getActiveTools() || [];
    const without = current.filter((n) => !shadow.has(n) && !_registeredShadows.has(n));
    if (isCursorRemoteModel(model)) {
      pi.setActiveTools([...without, ...shadow]);
    } else {
      pi.setActiveTools(without);
    }
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
      for (const name of displayToolNames()) ensureShadow(name);
      syncActive(model);
      return snap;
    } catch {
      // MCP optional; keep core shadows
      return null;
    }
  };

  if (typeof pi.on === "function") {
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

export { displayToolName, setMcpWireTools };
