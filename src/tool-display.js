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
  "contour__write_file",
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
 * All names Pi may look up after a Cursor Remote tool_use (display, wire, aliases).
 * Missing any of these → "Tool shell not found".
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
