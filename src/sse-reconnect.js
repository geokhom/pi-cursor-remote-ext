/**
 * Classify local-bridge SSE drops that should reconnect instead of
 * ending the TUI turn. Pi paints a bare `Error: aborted` when Node's
 * IncomingMessage is destroyed (socket reset / req.destroy).
 */

export const SSE_RECONNECT_MAX = 8;
export const SSE_RECONNECT_BASE_MS = 250;

/**
 * @param {unknown} err
 * @param {AbortSignal | null | undefined} [userSignal] pi ESC / /stop for this turn
 */
export function isReconnectableSseError(err, userSignal) {
  if (userSignal && userSignal.aborted) return false;
  const name =
    err && typeof err === "object" && "name" in err ? String(err.name) : "";
  // Feeder AbortController (idle timer / dispose) — do not reconnect.
  if (name === "AbortError") return false;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const code =
    err && typeof err === "object" && "code" in err ? String(err.code) : "";
  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED"
  ) {
    return true;
  }
  const t = msg.trim();
  if (/^(aborted|socket hang up|read ECONNRESET|write EPIPE)$/i.test(t)) {
    return true;
  }
  if (
    /ECONNRESET|EPIPE|ECONNREFUSED|ETIMEDOUT|socket hang up|Client network socket disconnected/i.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

/** @param {number} attempt 1-based */
export function sseReconnectDelayMs(attempt) {
  const n = Math.max(1, attempt);
  return Math.min(8000, SSE_RECONNECT_BASE_MS * 2 ** (n - 1));
}

/**
 * Sleep that resolves early when `signal` aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
    }
  });
}
