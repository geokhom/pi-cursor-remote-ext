/**
 * Register shadow tools (display names without contour__) that return stashed
 * bridge results. Agent loop then paints ToolExecutionComponent with
 * success/error backgrounds — same UX as local bash/read.
 */

import { displayToolNames, displayToolName } from "./tool-display.js";
import { takeToolResult } from "./result-stash.js";
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
      const stashed = takeToolResult(toolCallId);
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
          // Stop the agent from starting another LLM turn after our synthetic tools.
          terminate: true,
        };
      }
      const body = contentToText(stashed.content);
      return {
        content: [{ type: "text", text: body || (stashed.ok ? "(ok)" : "(failed)") }],
        details: { wireName: stashed.name, ok: stashed.ok },
        isError: stashed.ok === false,
        terminate: true,
      };
    },
  };
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

  const syncActive = (model) => {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
      return;
    }
    const ours =
      model?.provider === "cursor-remote" ||
      model?.api === "cursor-remote-bridge" ||
      model?.id === "cursor-remote";
    const current = pi.getActiveTools() || [];
    const without = current.filter((n) => !shadow.has(n));
    if (ours) {
      pi.setActiveTools([...without, ...shadow]);
    } else {
      pi.setActiveTools(without);
    }
  };

  if (typeof pi.on === "function") {
    pi.on("model_select", (ev) => {
      syncActive(ev?.model);
    });
    pi.on("session_start", () => {
      // Keep shadow tools out until cursor-remote is selected.
      syncActive(null);
    });
  }
}

export { displayToolName };
