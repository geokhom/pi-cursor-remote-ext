/**
 * Map Cursor SDK TokenUsage (run_finished.usage) → pi-ai Usage fields.
 * Mirrors pi-cursor-sdk cursor-usage-accounting.ts:
 * - inputTokens is the full prompt; cache fields partition it when inside input
 * - reject usage for pi messages when input+output exceeds model.contextWindow
 *   (run-sum / multi-step aggregates must not drive footer fill% or auto-compact)
 */

/** Sanity cap for clearly broken numbers when no contextWindow is set. */
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
 * Partition + output bounds (pi-cursor-sdk isCursorSdkUsagePartitionSafe).
 * @param {CursorSdkTurnUsage} turnUsage
 * @param {{ maxTokens?: number } | undefined} [model]
 */
export function isCursorSdkUsagePartitionSafe(turnUsage, model) {
  const maxOut =
    Number(model?.maxTokens) > 0 ? Number(model.maxTokens) : OUTPUT_SANITY_MAX;
  const counts = [
    turnUsage.inputTokens,
    turnUsage.outputTokens,
    turnUsage.cacheReadTokens,
    turnUsage.cacheWriteTokens,
  ];
  const uncached = getUncachedInput(turnUsage);
  return (
    counts.every((c) => Number.isFinite(c) && c >= 0 && c <= USAGE_SANITY_MAX) &&
    Number.isFinite(uncached) &&
    uncached >= 0 &&
    uncached <= USAGE_SANITY_MAX &&
    turnUsage.outputTokens <= maxOut
  );
}

/**
 * Safe to attach to a pi assistant message / drive footer fill%.
 * Run-sum usage above contextWindow is rejected (Agent multi-step totals).
 * @param {CursorSdkTurnUsage} turnUsage
 * @param {{ contextWindow?: number, maxTokens?: number } | undefined} [model]
 */
export function isCursorSdkUsageSafeForPiMessage(turnUsage, model) {
  if (!isCursorSdkUsagePartitionSafe(turnUsage, model)) return false;
  const window = Number(model?.contextWindow) || 0;
  if (window > 0) {
    return turnUsage.inputTokens + turnUsage.outputTokens <= window;
  }
  return promptOccupancyTokens(turnUsage) <= USAGE_SANITY_MAX;
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
  // Occupancy = full prompt + output (native: inputTokens + outputTokens when
  // cache partitions input; our uncached+cache matches that shape).
  partial.usage.totalTokens =
    promptOccupancyTokens(turnUsage) + turnUsage.outputTokens;
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
