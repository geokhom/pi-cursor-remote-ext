/**
 * Map Cursor SDK TokenUsage (run_finished.usage) → pi-ai Usage fields.
 * Mirrors pi-cursor-sdk applyCursorSdkUsage.
 */

/**
 * @typedef {{
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 * }} CursorSdkTurnUsage
 */

/**
 * @param {unknown} value
 * @returns {CursorSdkTurnUsage | undefined}
 */
export function readCursorSdkTurnUsage(value) {
  if (!value || typeof value !== "object") return undefined;
  const rec = /** @type {Record<string, unknown>} */ (value);
  const num = (a, b) => {
    const v = rec[a] ?? rec[b];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
    return Math.floor(v);
  };
  const inputTokens = num("input_tokens", "inputTokens");
  const outputTokens = num("output_tokens", "outputTokens");
  const cacheReadTokens = num("cache_read_tokens", "cacheReadTokens") ?? 0;
  const cacheWriteTokens = num("cache_write_tokens", "cacheWriteTokens") ?? 0;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/**
 * @param {CursorSdkTurnUsage} turnUsage
 */
function getUncachedInput(turnUsage) {
  return turnUsage.inputTokens - turnUsage.cacheReadTokens - turnUsage.cacheWriteTokens;
}

/**
 * @param {CursorSdkTurnUsage} turnUsage
 * @param {{ contextWindow?: number, maxTokens?: number } | undefined} model
 */
export function isCursorSdkUsageSafeForPiMessage(turnUsage, model) {
  const counts = [
    turnUsage.inputTokens,
    turnUsage.outputTokens,
    turnUsage.cacheReadTokens,
    turnUsage.cacheWriteTokens,
  ];
  const uncached = getUncachedInput(turnUsage);
  const contextWindow = model?.contextWindow || 128000;
  const maxTokens = model?.maxTokens || 8192;
  return (
    counts.every((c) => Number.isFinite(c) && c >= 0) &&
    Number.isFinite(uncached) &&
    uncached >= 0 &&
    turnUsage.outputTokens <= maxTokens &&
    turnUsage.inputTokens + turnUsage.outputTokens <= contextWindow
  );
}

/**
 * @param {{ usage: Record<string, number> }} partial
 * @param {CursorSdkTurnUsage} turnUsage
 */
export function applyCursorSdkUsage(partial, turnUsage) {
  partial.usage.input = getUncachedInput(turnUsage);
  partial.usage.output = turnUsage.outputTokens;
  partial.usage.cacheRead = turnUsage.cacheReadTokens;
  partial.usage.cacheWrite = turnUsage.cacheWriteTokens;
  partial.usage.totalTokens = turnUsage.inputTokens + turnUsage.outputTokens;
}

/**
 * @param {{ usage: Record<string, number> }} partial
 * @param {unknown} wireUsage
 * @param {{ contextWindow?: number, maxTokens?: number } | undefined} model
 * @returns {boolean} true if applied
 */
export function tryApplyWireUsage(partial, wireUsage, model) {
  const turn = readCursorSdkTurnUsage(wireUsage);
  if (!turn) return false;
  if (!isCursorSdkUsageSafeForPiMessage(turn, model)) return false;
  applyCursorSdkUsage(partial, turn);
  return true;
}
