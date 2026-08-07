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
  "contour__write_file",
  "contour__mkdir",
  "contour__delete_path",
  "contour__shell",
]);

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
  return CONTOUR_WIRE_TOOLS.map(displayToolName);
}
