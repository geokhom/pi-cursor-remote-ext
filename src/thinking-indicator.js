/**
 * Blinking "Thinking" widget for indicator mode (pi ctx.ui.setWidget).
 */

const WIDGET_ID = "cursor-remote-thinking";

/** @type {ReturnType<typeof setInterval> | null} */
let blinkTimer = null;

/** @type {{ setWidget?: Function } | null} */
let uiRef = null;

/**
 * @param {{ setWidget?: Function } | null | undefined} ui
 */
export function bindThinkingUi(ui) {
  if (ui && typeof ui.setWidget === "function") {
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
