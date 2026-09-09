/**
 * Contour wire names → short TUI names (strip contour__).
 * Shadow tools registered under display names so pi ToolExecutionComponent
 * paints success/error backgrounds like local bash/read tools.
 */

export const CONTOUR_PREFIX = "contour__";

/** @type {readonly string[]} */
export const CONTOUR_WIRE_TOOLS = Object.freeze([
  "contour__ping",
  "contour__list_dir",
  "contour__read_file",
  "contour__grep",
  "contour__glob",
  "contour__write_file",
  "contour__str_replace",
  "contour__mkdir",
  "contour__delete_path",
  "contour__shell",
]);

/** Extra MCP wire names from bridge GET /mcp/tools (session-scoped). */
/** @type {string[]} */
let _mcpWireTools = [];

/** Cursor built-in names → shadow display names (Pi execute lookup). */
export const BUILTIN_SHADOW_ALIASES = Object.freeze({
  Shell: "shell",
  Read: "read_file",
  Grep: "grep",
  Write: "write_file",
  Edit: "str_replace",
  Glob: "glob",
  LS: "list_dir",
  Delete: "delete_path",
});

/**
 * @param {string} wireName
 * @returns {string}
 */
export function displayToolName(wireName) {
  if (typeof wireName !== "string" || !wireName) return "tool";
  return wireName.startsWith(CONTOUR_PREFIX)
    ? wireName.slice(CONTOUR_PREFIX.length)
    : wireName;
}

/**
 * @param {string} displayName
 * @returns {string}
 */
export function wireToolName(displayName) {
  if (typeof displayName !== "string" || !displayName) return "contour__unknown";
  return displayName.startsWith(CONTOUR_PREFIX)
    ? displayName
    : CONTOUR_PREFIX + displayName;
}

/** @returns {string[]} */
export function displayToolNames() {
  const core = CONTOUR_WIRE_TOOLS.map(displayToolName);
  const mcp = _mcpWireTools.map(displayToolName);
  return [...new Set([...core, ...mcp])];
}

/**
 * Names to put in Pi `setActiveTools` on Cursor Remote.
 * `emitToolCall` uses display names (`shell`, `mcp__grafana__…`), not wire or
 * PascalCase aliases. Activating those extras tripled MCP stubs in `/context`.
 * @returns {string[]}
 */
export function activeShadowNames() {
  return displayToolNames();
}

/**
 * All names to `registerTool` so execute lookup can still resolve wire/aliases.
 * Missing any of these → "Tool shell not found" if a caller uses that spelling.
 * @returns {string[]}
 */
export function shadowToolNames() {
  const names = new Set(displayToolNames());
  for (const w of CONTOUR_WIRE_TOOLS) names.add(w);
  for (const w of _mcpWireTools) names.add(w);
  for (const alias of Object.keys(BUILTIN_SHADOW_ALIASES)) names.add(alias);
  return [...names];
}

/**
 * Replace MCP wire-name list used for shadow registration / active tools.
 * @param {Iterable<string> | null | undefined} wireNames
 */
export function setMcpWireTools(wireNames) {
  const next = [];
  if (wireNames) {
    for (const n of wireNames) {
      if (
        typeof n === "string" &&
        n.startsWith(CONTOUR_PREFIX) &&
        n.includes("mcp__")
      ) {
        next.push(n);
      }
    }
  }
  _mcpWireTools = next;
}

/** @returns {string[]} */
export function mcpWireTools() {
  return [..._mcpWireTools];
}
