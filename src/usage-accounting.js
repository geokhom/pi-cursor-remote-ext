/**
 * Map Cursor SDK TokenUsage (run_finished.usage) → pi-ai Usage fields.
 * Mirrors pi-cursor-sdk applyCursorSdkUsage.
 *
 * Do not reject usage just because it exceeds the advertised contextWindow:
 * composer-2.5 has no catalog `context` param (pi used to fall back to 128k)
 * while live turns report cache_read well above that. Reject only garbage.
 */

/** Sanity cap: reject clearly broken SDK numbers, not real occupancy. */
export const USAGE_SANITY_MAX = 2_000_000;
export const OUTPUT_SANITY_MAX = 200_000;

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
 * Uncached prompt tokens. Some runtimes put cache inside `input_tokens`;
 * others report `input_tokens` as uncached-only (then input − cache is negative).
 * @param {CursorSdkTurnUsage} turnUsage
 */
export function getUncachedInput(turnUsage) {
  const raw =
    turnUsage.inputTokens - turnUsage.cacheReadTokens - turnUsage.cacheWriteTokens;
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return turnUsage.inputTokens;
}

/**
 * Prompt occupancy this turn (what the model saw), not the uncached delta.
 * @param {CursorSdkTurnUsage} turnUsage
 */
export function promptOccupancyTokens(turnUsage) {
  return (
    getUncachedInput(turnUsage) +
    turnUsage.cacheReadTokens +
    turnUsage.cacheWriteTokens
  );
}

/**
 * @param {CursorSdkTurnUsage} turnUsage
 * @param {{ contextWindow?: number, maxTokens?: number } | undefined} [_model]
 */
export function isCursorSdkUsageSafeForPiMessage(turnUsage, _model) {
  const counts = [
    turnUsage.inputTokens,
    turnUsage.outputTokens,
    turnUsage.cacheReadTokens,
    turnUsage.cacheWriteTokens,
  ];
  const uncached = getUncachedInput(turnUsage);
  const occupancy = promptOccupancyTokens(turnUsage);
  return (
    counts.every((c) => Number.isFinite(c) && c >= 0 && c <= USAGE_SANITY_MAX) &&
    Number.isFinite(uncached) &&
    uncached >= 0 &&
    uncached <= USAGE_SANITY_MAX &&
    occupancy <= USAGE_SANITY_MAX &&
    turnUsage.outputTokens <= OUTPUT_SANITY_MAX
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
  partial.usage.totalTokens = promptOccupancyTokens(turnUsage) + turnUsage.outputTokens;
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
