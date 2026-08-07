/**
 * Stash bridge tool_executed results so pi's local tool loop can "execute"
 * instantly and paint ToolExecutionComponent (colored bg + result text).
 * Results are local — already on the contour machine; no proxy fetch.
 *
 * Also holds deferred assistant text for a follow-up stream turn so the TUI
 * shows tools above the final answer (pi always paints text above tool blocks
 * within a single assistant message).
 */

/** @type {Map<string, { ok: boolean, content: unknown, name?: string }>} */
const stash = new Map();

/** FIFO of call ids per display name when wire call_id is missing/mismatched. */
/** @type {Map<string, string[]>} */
const idsByName = new Map();

/** @type {string | null} */
let followUpText = null;

/**
 * @param {string} callId
 * @param {{ ok: boolean, content: unknown, name?: string }} result
 */
export function stashToolResult(callId, result) {
  if (!callId) return;
  stash.set(callId, result);
}

/**
 * Remember call id under display name for fallback lookup.
 * @param {string} displayName
 * @param {string} callId
 */
export function trackCallId(displayName, callId) {
  if (!displayName || !callId) return;
  let q = idsByName.get(displayName);
  if (!q) {
    q = [];
    idsByName.set(displayName, q);
  }
  q.push(callId);
}

/**
 * @param {string} callId
 * @param {string} [displayName]
 * @returns {{ ok: boolean, content: unknown, name?: string } | undefined}
 */
export function takeToolResult(callId, displayName) {
  if (callId && stash.has(callId)) {
    const v = stash.get(callId);
    stash.delete(callId);
    return v;
  }
  if (displayName) {
    const q = idsByName.get(displayName);
    while (q && q.length) {
      const id = q.shift();
      if (id && stash.has(id)) {
        const v = stash.get(id);
        stash.delete(id);
        return v;
      }
    }
  }
  // Last resort: any remaining stashed result
  if (stash.size === 1) {
    const [id, v] = stash.entries().next().value;
    stash.delete(id);
    return v;
  }
  return undefined;
}

/** @param {string} callId */
export function peekToolResult(callId) {
  return stash.get(callId);
}

export function clearToolResults() {
  stash.clear();
  idsByName.clear();
}

/** @param {string} text */
export function setFollowUpText(text) {
  followUpText = typeof text === "string" && text.trim() ? text : null;
}

/** @returns {string | null} */
export function takeFollowUpText() {
  const t = followUpText;
  followUpText = null;
  return t;
}

/** @returns {boolean} */
export function hasFollowUpText() {
  return followUpText != null && followUpText.length > 0;
}

export function peekFollowUpText() {
  return followUpText;
}
