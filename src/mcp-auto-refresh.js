/**
 * Auto POST /mcp/refresh when pi-mcp-adapter reports connected MCP tools,
 * or when a server Pi disabled is still in the contour catalog.
 * Debounced; skips while a live Cursor Remote run is active; flushes on agent_end.
 * Cached stdio status flaps do not reopen when hello already matches.
 */

import { hasActiveLiveRun } from "./live-run.js";

/** Same channel as pi-mcp-adapter (avoid hard dependency on that package). */
export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export const MCP_AUTO_REFRESH_DEBOUNCE_MS = 2000;

/**
 * @param {unknown} snapshot
 * @returns {string}
 */
export function mcpStatusFingerprint(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const servers = /** @type {{ servers?: unknown }} */ (snapshot).servers;
  if (!Array.isArray(servers)) {
    const total = /** @type {{ totalTools?: unknown, connectedCount?: unknown }} */ (
      snapshot
    );
    return `t${Number(total.totalTools) || 0}:c${Number(total.connectedCount) || 0}`;
  }
  return servers
    .map((s) => {
      if (!s || typeof s !== "object") return "";
      const o = /** @type {{ name?: unknown, status?: unknown, toolCount?: unknown, disabled?: unknown }} */ (s);
      const flag = o.disabled === true ? "d" : "e";
      return `${String(o.name || "")}:${String(o.status || "")}:${Number(o.toolCount) || 0}:${flag}`;
    })
    .filter(Boolean)
    .sort()
    .join("|");
}

/**
 * True when snapshot shows at least one server with tools in a usable state.
 * Includes adapter "cached" keep-alive (stdio like chrome-devtools) so a gap
 * vs the contour hello catalog can still trigger one refresh.
 * @param {unknown} snapshot
 * @returns {boolean}
 */
export function mcpStatusHasTools(snapshot) {
  return mcpAdapterServersWithTools(snapshot).length > 0;
}

/**
 * Server names Pi marked disabled (literal true only).
 * @param {unknown} snapshot
 * @returns {string[]}
 */
export function mcpDisabledServerNames(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const servers = /** @type {{ servers?: unknown }} */ (snapshot).servers;
  if (!Array.isArray(servers)) return [];
  const names = [];
  for (const srv of servers) {
    if (!srv || typeof srv !== "object") continue;
    const o = /** @type {{ name?: unknown, disabled?: unknown }} */ (srv);
    if (o.disabled !== true) continue;
    const name = String(o.name || "").trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * True when a status event should be considered for refresh.
 * Disabled-only snapshots still count so `/mcp disable` can drop contour tools.
 * @param {unknown} snapshot
 * @returns {boolean}
 */
export function mcpStatusShouldSchedule(snapshot) {
  return mcpStatusHasTools(snapshot) || mcpDisabledServerNames(snapshot).length > 0;
}

/**
 * Adapter server names that expose tools (connected or cached keep-alive).
 * @param {unknown} snapshot
 * @returns {string[]}
 */
export function mcpAdapterServersWithTools(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const s = /** @type {{
    totalTools?: unknown,
    connectedCount?: unknown,
    servers?: Array<{ name?: string, status?: string, toolCount?: number, disabled?: boolean }>
  }} */ (snapshot);
  if (!Array.isArray(s.servers)) {
    if ((Number(s.totalTools) || 0) > 0 && (Number(s.connectedCount) || 0) > 0) {
      return ["*"];
    }
    return [];
  }
  const names = [];
  for (const srv of s.servers) {
    if (!srv || srv.disabled) continue;
    if ((Number(srv.toolCount) || 0) <= 0) continue;
    const st = String(srv.status || "");
    if (st !== "connected" && st !== "cached") continue;
    const name = String(srv.name || "").trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * True when the adapter has a named server with tools that is missing from
 * the bridge GET /mcp/tools snapshot (contour hello).
 * @param {unknown} adapterSnap
 * @param {unknown} bridgeSnap
 * @returns {boolean}
 */
export function mcpCatalogHasGap(adapterSnap, bridgeSnap) {
  const want = mcpAdapterServersWithTools(adapterSnap);
  if (!want.length || want.includes("*")) {
    return want.includes("*") && !(
      Array.isArray(/** @type {{ tools?: unknown }} */ (bridgeSnap)?.tools) &&
      /** @type {{ tools: unknown[] }} */ (bridgeSnap).tools.length > 0
    );
  }
  const have = new Set();
  const tools = /** @type {{ tools?: Array<{ server?: string }> }} */ (bridgeSnap)?.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (t && typeof t.server === "string" && t.server.trim()) {
        have.add(t.server.trim());
      }
    }
  }
  return want.some((name) => !have.has(name));
}

/**
 * True when contour still advertises or errors a server Pi has disabled.
 * @param {unknown} adapterSnap
 * @param {unknown} bridgeSnap
 * @returns {boolean}
 */
export function mcpCatalogHasDisabledOverlap(adapterSnap, bridgeSnap) {
  const disabled = new Set(mcpDisabledServerNames(adapterSnap));
  if (!disabled.size) return false;
  const tools = /** @type {{ tools?: Array<{ server?: string }> }} */ (bridgeSnap)?.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (t && typeof t.server === "string" && disabled.has(t.server.trim())) {
        return true;
      }
    }
  }
  const errors = /** @type {{ errors?: Array<{ server?: string }> }} */ (bridgeSnap)?.errors;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (e && typeof e.server === "string" && disabled.has(e.server.trim())) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Reopen when hello is missing an enabled server, or still has a disabled one.
 * A cached chrome-devtools flap with a matching hello does not qualify.
 * @param {unknown} adapterSnap
 * @param {unknown} bridgeSnap
 * @returns {boolean}
 */
export function mcpCatalogNeedsRefresh(adapterSnap, bridgeSnap) {
  return (
    mcpCatalogHasGap(adapterSnap, bridgeSnap) ||
    mcpCatalogHasDisabledOverlap(adapterSnap, bridgeSnap)
  );
}

/**
 * @param {{
 *   pi: { events?: { on?: Function, off?: Function }, on?: Function },
 *   client: { getMcpTools: Function, refreshMcp: Function },
 *   shadowApi?: { syncMcpShadows?: Function } | null,
 *   getModel?: () => unknown,
 *   notify?: (msg: string, level?: string) => void,
 *   debounceMs?: number,
 * }} opts
 * @returns {() => void} disposer
 */
export function installMcpAutoRefresh(opts) {
  const {
    pi,
    client,
    shadowApi,
    getModel,
    notify,
    debounceMs = MCP_AUTO_REFRESH_DEBOUNCE_MS,
  } = opts || {};
  if (!client || typeof client.refreshMcp !== "function") {
    return () => {};
  }
  const events = pi?.events;
  if (!events || typeof events.on !== "function") {
    return () => {};
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let pending = false;
  let inFlight = false;
  /** Status fingerprint last scheduled / processed. */
  let lastStatusFp = "";
  /** Status fingerprint after last successful refresh. */
  let lastSuccessFp = "";
  /** @type {unknown} */
  let lastAdapterSnap = null;

  /**
   * @param {string} reason
   */
  async function doRefresh(reason) {
    if (inFlight) {
      pending = true;
      return;
    }
    if (hasActiveLiveRun()) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      let before;
      try {
        before = await client.getMcpTools();
      } catch {
        return;
      }
      if (!before?.enabled) {
        return;
      }
      if (before.ready === false) {
        return;
      }
      const beforeNames = (before.tools || [])
        .map((t) => (t && typeof t.name === "string" ? t.name : ""))
        .filter(Boolean)
        .sort()
        .join(",");
      const disabled = new Set(mcpDisabledServerNames(lastAdapterSnap));
      const needs = mcpCatalogNeedsRefresh(lastAdapterSnap, before);
      const visibleErrors = Array.isArray(before.errors)
        ? before.errors.filter((e) => !disabled.has(String(e?.server || "").trim()))
        : [];
      if (visibleErrors.length && (needs || reason === "manual")) {
        const detail = visibleErrors
          .map((e) => `${e?.server || "?"}: ${e?.error || "failed"}`)
          .join("; ");
        notify?.(`MCP catalog errors: ${detail}`, "warning");
      }
      // Skip reopen when hello already matches Pi: enabled servers present,
      // disabled servers absent. Cached chrome-devtools flaps stay here.
      if (reason !== "manual" && !needs) {
        lastSuccessFp = lastStatusFp;
        return;
      }

      await client.refreshMcp({});
      await shadowApi?.syncMcpShadows?.(client, getModel?.());

      let after = before;
      try {
        after = await client.getMcpTools();
      } catch {
        // keep before
      }
      const afterNames = (after?.tools || [])
        .map((t) => (t && typeof t.name === "string" ? t.name : ""))
        .filter(Boolean)
        .sort()
        .join(",");
      lastSuccessFp = lastStatusFp;
      if (afterNames !== beforeNames || reason === "manual") {
        const n = Array.isArray(after?.tools) ? after.tools.length : 0;
        const trunc = after?.truncated ? ` (truncated ${after.truncated})` : "";
        notify?.(
          `MCP tools auto-refreshed (${n} tool${n === 1 ? "" : "s"})${trunc}.`,
          "info"
        );
      }
    } catch (err) {
      notify?.(
        `MCP auto-refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        "warning"
      );
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        schedule("pending", null, true);
      }
    }
  }

  /**
   * @param {string} reason
   * @param {unknown} [snapshot]
   * @param {boolean} [force]
   */
  function schedule(reason, snapshot, force = false) {
    if (snapshot != null) {
      lastAdapterSnap = snapshot;
      if (!mcpStatusShouldSchedule(snapshot)) return;
      const fp = mcpStatusFingerprint(snapshot);
      if (!force && fp && fp === lastStatusFp) return;
      if (!force && fp && fp === lastSuccessFp) return;
      if (fp) lastStatusFp = fp;
    } else if (!force && !pending && !lastStatusFp) {
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void doRefresh(reason);
    }, debounceMs);
  }

  /** @param {unknown} snapshot */
  const onStatus = (snapshot) => {
    schedule("status", snapshot);
  };

  events.on(MCP_STATUS_EVENT, onStatus);

  /** @type {((...args: unknown[]) => void) | null} */
  let onAgentEnd = null;
  if (typeof pi.on === "function") {
    onAgentEnd = () => {
      if (pending || (lastStatusFp && lastStatusFp !== lastSuccessFp)) {
        schedule("agent_end", null, true);
      }
    };
    pi.on("agent_end", onAgentEnd);
  }

  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (typeof events.off === "function") {
      events.off(MCP_STATUS_EVENT, onStatus);
    }
  };
}
