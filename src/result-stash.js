/**
 * Stash bridge tool_executed results so pi's local tool loop can "execute"
 * instantly and paint ToolExecutionComponent (colored bg + result text).
 * Results are local — already on the contour machine; no proxy fetch.
 *
 * Also holds deferred assistant text for a follow-up stream turn so the TUI
 * shows tools above the final answer (pi always paints text above tool blocks
 * within a single assistant message).
 *
 * State lives on globalThis (Symbol.for) so jiti/static vs dynamic imports of
 * this module still share one Map — otherwise stash writes land in one
 * instance and shadow-tool execute reads an empty one → "No bridge result".
 */

/**
 * @typedef {{ ok: boolean, content: unknown, name?: string, displayName?: string }} Stashed
 */

const STATE_KEY = Symbol.for("pi-cursor-remote.result-stash.v1");

/**
 * @returns {{
 *   stash: Map<string, Stashed>,
 *   idsByName: Map<string, string[]>,
 *   followUpText: string | null,
 * }}
 */
function state() {
  const g = globalThis;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      stash: new Map(),
      idsByName: new Map(),
      followUpText: null,
    };
  }
  return g[STATE_KEY];
}

/**
 * @param {string} callId
 * @param {Stashed} result
 */
export function stashToolResult(callId, result) {
  if (!callId) return;
  const s = state();
  s.stash.set(callId, result);
}

/**
 * Remember call id under display name for fallback lookup.
 * @param {string} displayName
 * @param {string} callId
 */
export function trackCallId(displayName, callId) {
  if (!displayName || !callId) return;
  const s = state();
  let q = s.idsByName.get(displayName);
  if (!q) {
    q = [];
    s.idsByName.set(displayName, q);
  }
  q.push(callId);
}

/**
 * @param {string} callId
 * @param {string} [displayName]
 * @returns {Stashed | undefined}
 */
export function takeToolResult(callId, displayName) {
  const s = state();
  if (callId && s.stash.has(callId)) {
    const v = s.stash.get(callId);
    s.stash.delete(callId);
    return v;
  }
  if (displayName) {
    const q = s.idsByName.get(displayName);
    while (q && q.length) {
      const id = q.shift();
      if (id && s.stash.has(id)) {
        const v = s.stash.get(id);
        s.stash.delete(id);
        return v;
      }
    }
    // Match by stashed displayName / wire name (module-split or id rewrite).
    for (const [id, v] of s.stash) {
      const dn = v.displayName || (v.name ? stripContour(v.name) : "");
      if (dn === displayName) {
        s.stash.delete(id);
        return v;
      }
    }
  }
  if (s.stash.size === 1) {
    const [id, v] = s.stash.entries().next().value;
    s.stash.delete(id);
    return v;
  }
  return undefined;
}

/** @param {string} wireName */
function stripContour(wireName) {
  return wireName.startsWith("contour__") ? wireName.slice("contour__".length) : wireName;
}

/** @param {string} callId */
export function peekToolResult(callId) {
  return state().stash.get(callId);
}

export function clearToolResults() {
  const s = state();
  s.stash.clear();
  s.idsByName.clear();
}

/** @param {string} text */
export function setFollowUpText(text) {
  state().followUpText = typeof text === "string" && text.trim() ? text : null;
}

/** @returns {string | null} */
export function takeFollowUpText() {
  const s = state();
  const t = s.followUpText;
  s.followUpText = null;
  return t;
}

/** @returns {boolean} */
export function hasFollowUpText() {
  const t = state().followUpText;
  return t != null && t.length > 0;
}

export function peekFollowUpText() {
  return state().followUpText;
}
