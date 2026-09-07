/**
 * Active bridge SSE session across pi streamSimple turns.
 *
 * Stock pi-cursor-sdk ends a turn at each tool batch (done/toolUse) so the TUI
 * can paint ToolExecution panels, then resumes the same live run. We mirror
 * that: keep GET /events open, queue events, pause drain on tool boundaries.
 *
 * State is on globalThis (Symbol.for) so jiti/static vs dynamic imports share
 * one session — same pattern as result-stash.js.
 */

import {
  SSE_RECONNECT_MAX,
  isReconnectableSseError,
  sleepAbortable,
  sseReconnectDelayMs,
} from "./sse-reconnect.js";

const STATE_KEY = Symbol.for("pi-cursor-remote.live-run.v1");

/** Settle window to gather parallel tool_call events (ms). */
export const TOOL_BATCH_SETTLE_MS = 75;

/**
 * @typedef {object} LiveRunSession
 * @property {object[]} queue
 * @property {Array<() => void>} waiters
 * @property {boolean} closed
 * @property {Error | null} error
 * @property {Set<string>} awaitingToolExec
 * @property {boolean} sawRunFinished
 * @property {object[]} rawEvents
 * @property {AbortController} abort
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {number | null} [firstOutAt] first thinking/text/tool chunk (Decode-ish)
 * @property {boolean} [decodeSampleRecorded]
 * @property {(ev: object | null) => void} enqueue
 * @property {() => object | null | undefined} peek
 * @property {() => Promise<object | null>} nextEvent
 * @property {(ev: object) => void} unshift
 * @property {() => void} dispose
 * @property {() => void} markFirstOut
 */

/**
 * @returns {{ session: LiveRunSession | null }}
 */
function state() {
  const g = globalThis;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = { session: null };
  }
  return g[STATE_KEY];
}

/** @returns {LiveRunSession | null} */
export function getActiveLiveRun() {
  return state().session;
}

/** True while a bridge run still has (or may get) events to drain. */
export function hasActiveLiveRun() {
  const s = state().session;
  if (!s) return false;
  if (s.error) return false;
  if (!s.closed) return true;
  return s.queue.length > 0;
}

export function clearLiveRun() {
  const st = state();
  if (st.session) {
    st.session.dispose();
    st.session = null;
  }
}

/**
 * @param {LiveRunSession | null} session
 */
export function setActiveLiveRun(session) {
  const st = state();
  if (st.session && st.session !== session) {
    st.session.dispose();
  }
  st.session = session;
}

/**
 * @param {import("./bridge-client.js").BridgeClient} client
 * @param {AbortSignal} [signal]
 * @param {number} [timeoutMs]
 * @returns {LiveRunSession}
 */
export function startLiveEventFeeder(client, signal, timeoutMs = 600_000) {
  clearLiveRun();

  const abort = new AbortController();
  const timer = setTimeout(() => {
    session.error = new Error(
      `bridge event wait timed out (${Math.round(timeoutMs / 1000)}s)`
    );
    try {
      abort.abort();
    } catch {
      // ignore
    }
  }, timeoutMs);
  // User ESC must NOT abort SSE: pi keeps painting while we drain until
  // run_error(cancelled). Only the 10m timer closes this feeder.
  // Pi aborting a finished toolUse turn's AbortSignal must NOT cancel the VPS run.

  /** @type {LiveRunSession} */
  const session = {
    queue: [],
    waiters: [],
    closed: false,
    error: null,
    awaitingToolExec: new Set(),
    sawRunFinished: false,
    rawEvents: [],
    firstOutAt: null,
    decodeSampleRecorded: false,
    abort,
    timer,
    requestCancel() {
      return client.cancel().catch(() => {});
    },
    markFirstOut() {
      if (session.firstOutAt == null) session.firstOutAt = Date.now();
    },
    enqueue(ev) {
      session.queue.push(ev);
      const waiters = session.waiters.splice(0);
      for (const w of waiters) w();
    },
    peek() {
      return session.queue[0];
    },
    unshift(ev) {
      session.queue.unshift(ev);
    },
    async nextEvent() {
      while (!session.queue.length && !session.closed) {
        await new Promise((r) => {
          session.waiters.push(r);
        });
      }
      if (session.queue.length) {
        return session.queue.shift() ?? null;
      }
      if (session.error) throw session.error;
      return null;
    },
    dispose() {
      clearTimeout(timer);
      try {
        abort.abort();
      } catch {
        // ignore
      }
      session.closed = true;
      const waiters = session.waiters.splice(0);
      for (const w of waiters) w();
    },
  };

  setActiveLiveRun(session);

  (async () => {
    let after = 0;
    let attempt = 0;
    try {
      while (!abort.signal.aborted && !session.closed) {
        try {
          let gotEvent = false;
          for await (const ev of client.events(abort.signal, {
            after,
            catchup: attempt > 0 || after > 0,
          })) {
            if (!ev || typeof ev !== "object") continue;
            if (typeof ev.sse_seq === "number" && ev.sse_seq > after) {
              after = ev.sse_seq;
            }
            if (ev.type === "run_heartbeat") continue;
            gotEvent = true;
            attempt = 0;
            session.rawEvents.push(ev);
            if (ev.type === "tool_call") {
              const id = typeof ev.call_id === "string" ? ev.call_id : "";
              if (id) session.awaitingToolExec.add(id);
            } else if (ev.type === "tool_executed") {
              const id = typeof ev.call_id === "string" ? ev.call_id : "";
              if (id) session.awaitingToolExec.delete(id);
            } else if (ev.type === "run_finished") {
              session.sawRunFinished = true;
            }
            session.enqueue(ev);
            const terminal =
              ev.type === "run_error" ||
              ev.type === "session_end" ||
              (session.sawRunFinished && session.awaitingToolExec.size === 0);
            if (terminal) return;
          }
          if (abort.signal.aborted || session.closed) return;
          if (session.sawRunFinished && session.awaitingToolExec.size === 0) {
            return;
          }
          // Unexpected EOF (Node often surfaces this as Error: aborted).
          if (!gotEvent && attempt === 0 && after === 0) {
            // Connected then closed before any event — still retry.
          }
          throw new Error("aborted");
        } catch (err) {
          if (abort.signal.aborted || session.closed) {
            return;
          }
          if (!isReconnectableSseError(err) || attempt >= SSE_RECONNECT_MAX) {
            session.error =
              err instanceof Error ? err : new Error(String(err ?? "sse error"));
            return;
          }
          attempt += 1;
          session.enqueue({
            type: "sse_reconnect",
            attempt,
            max_attempts: SSE_RECONNECT_MAX,
            message: `[wire] SSE reconnecting (${attempt}/${SSE_RECONNECT_MAX})…`,
          });
          await sleepAbortable(sseReconnectDelayMs(attempt), abort.signal);
        }
      }
    } finally {
      clearTimeout(timer);
      session.closed = true;
      session.enqueue(null);
    }
  })();

  return session;
}

/**
 * @param {number} [ms]
 */
export function settleToolBatch(ms = TOOL_BATCH_SETTLE_MS) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object | null | undefined} ev
 */
export function isPostToolBoundaryEvent(ev) {
  if (!ev || typeof ev !== "object") return false;
  const t = ev.type;
  return (
    t === "thinking_start" ||
    t === "thinking_delta" ||
    t === "thinking_end" ||
    t === "assistant_delta" ||
    t === "assistant_message" ||
    t === "run_finished" ||
    t === "run_error" ||
    t === "session_end"
  );
}
