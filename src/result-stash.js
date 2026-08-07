/**
 * Stash bridge tool_executed results so pi's local tool loop can "execute"
 * instantly and paint ToolExecutionComponent (colored bg + result text).
 * Results are local — already on the contour machine; no proxy fetch.
 */

/** @type {Map<string, { ok: boolean, content: unknown, name?: string }>} */
const stash = new Map();

/**
 * @param {string} callId
 * @param {{ ok: boolean, content: unknown, name?: string }} result
 */
export function stashToolResult(callId, result) {
  if (!callId) return;
  stash.set(callId, result);
}

/**
 * @param {string} callId
 * @returns {{ ok: boolean, content: unknown, name?: string } | undefined}
 */
export function takeToolResult(callId) {
  if (!callId) return undefined;
  const v = stash.get(callId);
  if (v) stash.delete(callId);
  return v;
}

/** @param {string} callId */
export function peekToolResult(callId) {
  return stash.get(callId);
}

export function clearToolResults() {
  stash.clear();
}
