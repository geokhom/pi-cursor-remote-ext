/**
 * Pi UI helpers: thinking indicator widget + footer status (wire stats).
 */

const WIDGET_ID = "cursor-remote-thinking";
const STATUS_KEY = "cursor-remote-wire";

/** @type {ReturnType<typeof setInterval> | null} */
let blinkTimer = null;

/** @type {{ setWidget?: Function, setStatus?: Function } | null} */
let uiRef = null;

/**
 * @param {{ setWidget?: Function, setStatus?: Function } | null | undefined} ui
 */
export function bindThinkingUi(ui) {
  if (ui && (typeof ui.setWidget === "function" || typeof ui.setStatus === "function")) {
    uiRef = ui;
  }
}

export function clearThinkingIndicator() {
  if (blinkTimer != null) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
  try {
    uiRef?.setWidget?.(WIDGET_ID, undefined);
  } catch {
    // ignore
  }
}

/**
 * Show blinking Thinking label. No-op without bound UI.
 */
export function showThinkingIndicator() {
  if (!uiRef || typeof uiRef.setWidget !== "function") return;
  clearThinkingIndicator();
  let on = true;
  const paint = () => {
    try {
      uiRef.setWidget(WIDGET_ID, [on ? "Thinking" : "· · · ·"]);
    } catch {
      // ignore
    }
    on = !on;
  };
  paint();
  blinkTimer = setInterval(paint, 450);
}

/**
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${Math.round(v)}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10 * 1024 ? 1 : 0)}KiB`;
  return `${(v / (1024 * 1024)).toFixed(2)}MiB`;
}

/**
 * Footer status: proxy-visible wire traffic + optional char/s.
 * @param {{
 *   proxy_up_bytes?: number,
 *   proxy_down_bytes?: number,
 *   proxy_gets?: number,
 *   chars_per_sec?: number,
 *   duration_ms?: number,
 *   out_chars?: number,
 * }} stats
 */
export function setWireStatus(stats) {
  if (!uiRef || typeof uiRef.setStatus !== "function") return;
  const up = formatBytes(stats.proxy_up_bytes ?? 0);
  const down = formatBytes(stats.proxy_down_bytes ?? 0);
  const parts = [`wire ↑${up} ↓${down}`];
  if (typeof stats.proxy_gets === "number" && stats.proxy_gets > 0) {
    parts.push(`${stats.proxy_gets} GET`);
  }
  if (typeof stats.chars_per_sec === "number" && stats.chars_per_sec > 0) {
    parts.push(`${Math.round(stats.chars_per_sec)} c/s`);
  } else if (
    typeof stats.out_chars === "number" &&
    typeof stats.duration_ms === "number" &&
    stats.duration_ms > 0 &&
    stats.out_chars > 0
  ) {
    parts.push(`${Math.round((stats.out_chars * 1000) / stats.duration_ms)} c/s`);
  }
  try {
    uiRef.setStatus(STATUS_KEY, parts.join(" · "));
  } catch {
    // ignore
  }
}

export function clearWireStatus() {
  try {
    uiRef?.setStatus?.(STATUS_KEY, undefined);
  } catch {
    // ignore
  }
}
