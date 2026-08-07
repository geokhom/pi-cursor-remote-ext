/**
 * Register shadow tools (display names without contour__) that return stashed
 * bridge results. Agent loop then paints ToolExecutionComponent with
 * success/error backgrounds — same UX as local bash/read.
 */

import { displayToolNames, displayToolName } from "./tool-display.js";
import { takeToolResult, hasFollowUpText } from "./result-stash.js";
import { formatToolArgs, formatToolResult } from "./bridge-client.js";

/** Loose JSON Schema — accepted by pi's typebox/json validator path. */
const ANY_OBJECT = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

/**
 * Minimal pi-tui Component (avoid hard dep on @earendil-works/pi-tui).
 * @param {string[]} lines
 */
function linesComponent(lines) {
  const out = lines.length ? lines : [""];
  return {
    render() {
      return out;
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
    renderResult(result, _options, theme) {
      const text = (result?.content || [])
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      if (!text) return linesComponent([]);
      const color = result?.isError ? "error" : "toolOutput";
      return linesComponent(text.split("\n").map((l) => theme.fg(color, l)));
    },
    async execute(toolCallId, _params, _signal, _onUpdate, _ctx) {
      const stashed = takeToolResult(toolCallId, displayName);
      // If final assistant text was deferred, let the agent start another stream
      // turn so the answer appears BELOW the tool panels (pi paints text above
      // tools within a single assistant message).
      const terminate = !hasFollowUpText();
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
      return {
        content: [{ type: "text", text: body || (stashed.ok ? "(ok)" : "(failed)") }],
        details: { wireName: stashed.name, ok: stashed.ok },
        isError: stashed.ok === false,
        terminate,
      };
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
    m?.id === "cursor-remote"
  );
}

/**
 * @param {import('./types.js').ExtensionAPI} pi
 */
export function registerShadowTools(pi) {
  if (!pi || typeof pi.registerTool !== "function") return;
  for (const name of displayToolNames()) {
    pi.registerTool(makeShadowTool(name));
  }

  const shadow = new Set(displayToolNames());

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
    const current = pi.getActiveTools() || [];
    const without = current.filter((n) => !shadow.has(n));
    if (isCursorRemoteModel(model)) {
      pi.setActiveTools([...without, ...shadow]);
    } else {
      pi.setActiveTools(without);
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
}

export { displayToolName };
