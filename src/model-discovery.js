/**
 * Expand VPS models_catalog into pi registerProvider models (pi-cursor-sdk style).
 * Encodes variants as id@context:fast|:slow and builds ModelSelection for /prompt.
 *
 * Catalog metadata lives on globalThis (Symbol.for) so jiti/static vs dynamic
 * imports share one Map — otherwise streamSimple builds a bare id and drops
 * :fast / @context params.
 */

import { DEFAULT_MODEL, defaultConfigPath } from "./config.js";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Catalog omits `context` for composer-2.5 (only `fast`). 128k was a pi-ai
 * default and made the footer look empty while cache_read was already 100k+.
 * Third-party / Cursor-family figure for composer-2.5 is 256k; grow from usage
 * in the footer if a turn reports more.
 */
const FALLBACK_CONTEXT_WINDOW = 256000;
const FALLBACK_MAX_TOKENS = 8192;

/** @type {Record<string, number>} */
const KNOWN_CONTEXT_WINDOWS = {
  "composer-2.5": 256000,
  "composer-2": 256000,
};
const ZERO_COST = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const META_KEY = Symbol.for("pi-cursor-remote.model-metadata.v1");
const META_KEY_STR = "__pi_cursor_remote_model_metadata_v1";

/** Module-local Map; share via globalThis when the host allows it (jiti split). */
const _localMeta = new Map();

/** @returns {Map<string, object>} */
function metadataByPiModelId() {
  try {
    const g = globalThis;
    if (g && (typeof g === "object" || typeof g === "function")) {
      let store = g[META_KEY];
      if (!(store instanceof Map)) store = g[META_KEY_STR];
      if (!(store instanceof Map)) {
        store = _localMeta;
        try {
          g[META_KEY] = store;
        } catch {
          // frozen / vm globalThis
        }
        try {
          g[META_KEY_STR] = store;
        } catch {
          // ignore
        }
      }
      return store;
    }
  } catch {
    // ignore
  }
  return _localMeta;
}

/**
 * @param {unknown} item
 * @param {string} id
 */
function getParameter(item, id) {
  const params = item?.parameters;
  if (!Array.isArray(params)) return undefined;
  return params.find((p) => p && p.id === id);
}

/**
 * @param {object | undefined} parameter
 * @param {string} value
 */
function getParameterValue(parameter, value) {
  if (!parameter || !Array.isArray(parameter.values)) return null;
  const hit = parameter.values.find((v) => String(v?.value) === value);
  return hit ? String(hit.value) : null;
}

/**
 * @param {object | undefined} parameter
 * @param {string[]} preferred
 */
function getPreferredParameterValue(parameter, preferred) {
  for (const p of preferred) {
    const v = getParameterValue(parameter, p);
    if (v != null) return v;
  }
  return null;
}

function hasBooleanValues(parameter) {
  if (!parameter || !Array.isArray(parameter.values)) return false;
  const vals = new Set(parameter.values.map((v) => String(v?.value).toLowerCase()));
  return vals.has("true") && vals.has("false");
}

/**
 * @param {object | undefined} parameter
 * @param {string} level
 */
function mapComparableLevel(parameter, level) {
  if (level === "xhigh") {
    return getPreferredParameterValue(parameter, ["xhigh", "extra-high"]);
  }
  return getParameterValue(parameter, level);
}

/**
 * @param {object} item
 * @returns {Record<string, string|null> | undefined}
 */
export function getThinkingLevelMap(item) {
  const reasoningParameter = getParameter(item, "reasoning");
  const effortParameter = getParameter(item, "effort");
  const thinkingParameter = getParameter(item, "thinking");
  const valueParameter = effortParameter ?? reasoningParameter ?? thinkingParameter;
  if (!valueParameter) return undefined;

  if (valueParameter.id === "thinking" && hasBooleanValues(valueParameter)) {
    return {
      off: getParameterValue(valueParameter, "false"),
      minimal: null,
      low: null,
      medium: null,
      high: getParameterValue(valueParameter, "true"),
      xhigh: null,
      max: null,
    };
  }

  return {
    off:
      getParameterValue(reasoningParameter, "none") ??
      getParameterValue(reasoningParameter, "off") ??
      getParameterValue(thinkingParameter, "false"),
    minimal: mapComparableLevel(valueParameter, "minimal"),
    low: mapComparableLevel(valueParameter, "low"),
    medium: mapComparableLevel(valueParameter, "medium"),
    high: mapComparableLevel(valueParameter, "high"),
    xhigh: mapComparableLevel(valueParameter, "xhigh"),
    max: mapComparableLevel(valueParameter, "max"),
  };
}

/**
 * @param {string} value
 */
export function parseContextWindow(value) {
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(String(value || "").trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isFinite(amount)) return undefined;
  return Math.round(amount * (unit === "m" ? 1000000 : 1000));
}

/**
 * @param {string} modelId catalog / pi base id
 * @param {string | undefined} context catalog `context` value (`200k`, `1m`, …)
 */
export function resolveContextWindow(modelId, context) {
  const fromParam = context ? parseContextWindow(context) : undefined;
  if (fromParam) return fromParam;
  const id = typeof modelId === "string" ? modelId : "";
  return KNOWN_CONTEXT_WINDOWS[id] ?? FALLBACK_CONTEXT_WINDOW;
}

/**
 * @param {Array<{id:string,value:string}>} params
 */
function cloneParams(params) {
  return (params || []).map((p) => ({ id: p.id, value: p.value }));
}

/**
 * @param {object} item
 */
function getDefaultParams(item) {
  const variants = item?.variants;
  if (!Array.isArray(variants) || !variants.length) return [];
  const defaultVariant = variants.find((v) => v.is_default || v.isDefault) ?? variants[0];
  return cloneParams(defaultVariant?.params || []);
}

/**
 * @param {Array<{id:string,value:string}>} params
 * @param {string} id
 * @param {string} value
 */
function replaceParam(params, id, value) {
  let replaced = false;
  const next = params.map((param) => {
    if (param.id !== id) return { ...param };
    replaced = true;
    return { id, value };
  });
  if (!replaced) next.push({ id, value });
  return next;
}

function getParamValue(params, id) {
  return params.find((p) => p.id === id)?.value;
}

/**
 * @param {string} modelId
 * @param {string} [context]
 * @param {boolean} [fastOverride]
 */
export function encodePiModelId(modelId, context, fastOverride) {
  const contextQualified = context ? `${modelId}@${context}` : modelId;
  if (fastOverride === true) return `${contextQualified}:fast`;
  if (fastOverride === false) return `${contextQualified}:slow`;
  return contextQualified;
}

/**
 * Inverse of encodePiModelId. Safe on bare catalog ids.
 * @param {unknown} modelId
 * @returns {{ baseId: string, context: string|undefined, fastOverride: boolean|undefined }}
 */
export function parsePiModelId(modelId) {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) {
    return { baseId: DEFAULT_MODEL, context: undefined, fastOverride: undefined };
  }
  let rest = raw;
  /** @type {boolean|undefined} */
  let fastOverride;
  if (rest.endsWith(":fast")) {
    fastOverride = true;
    rest = rest.slice(0, -":fast".length);
  } else if (rest.endsWith(":slow")) {
    fastOverride = false;
    rest = rest.slice(0, -":slow".length);
  }
  const at = rest.lastIndexOf("@");
  let baseId = rest;
  /** @type {string|undefined} */
  let context;
  if (at > 0) {
    baseId = rest.slice(0, at);
    context = rest.slice(at + 1) || undefined;
  }
  return { baseId: baseId || DEFAULT_MODEL, context, fastOverride };
}

function getModelName(item, context, fastOverride) {
  const displayName = item.display_name || item.displayName || item.id;
  const qualifiers = [];
  if (fastOverride === true) qualifiers.push("fast");
  if (fastOverride === false) qualifiers.push("slow");
  const baseName = qualifiers.length
    ? `${displayName} (${qualifiers.join(", ")})`
    : displayName;
  return context ? `${baseName} @ ${context}` : baseName;
}

function getContextValues(item) {
  const raw = getParameter(item, "context")?.values;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (v && typeof v.value === "string" ? v.value : String(v?.value ?? "")))
    .filter((v) => v && v !== "undefined");
}

const MAX_PICKER_MODELS = 96;

/**
 * @param {object[]} items
 * @returns {object[]}
 */
export function registerModelItems(items) {
  const store = metadataByPiModelId();
  store.clear();
  const used = new Set();
  const configs = [];
  const sorted = [...(items || [])].sort((a, b) =>
    String(a.id || "").localeCompare(String(b.id || ""))
  );

  for (const item of sorted) {
    if (!item || typeof item.id !== "string" || !item.id) continue;
    const defaultParams = getDefaultParams(item);
    const contextValues = getContextValues(item);
    const contexts = contextValues.length > 0 ? contextValues : [undefined];
    const fastOverrides =
      getParameter(item, "fast") === undefined ? [undefined] : [undefined, true, false];

    for (const context of contexts) {
      const contextParams = context
        ? replaceParam(defaultParams, "context", context)
        : defaultParams;
      for (const fastOverride of fastOverrides) {
        const params =
          fastOverride === undefined
            ? contextParams
            : replaceParam(contextParams, "fast", fastOverride ? "true" : "false");
        const piModelId = encodePiModelId(item.id, context, fastOverride);
        if (used.has(piModelId)) continue;
        used.add(piModelId);
        const thinkingLevelMap = getThinkingLevelMap(item);
        const contextWindow = resolveContextWindow(item.id, context);
        const entry = {
          piModelId,
          baseModelId: item.id,
          selectionModelId: item.id,
          displayName: item.display_name || item.displayName || item.id,
          defaultParams: cloneParams(params),
          context,
          contextWindow,
          supportsFast: getParameter(item, "fast") !== undefined,
          defaultFast: getParamValue(params, "fast")?.toLowerCase() === "true",
          fastOverride,
          supportsReasoning: thinkingLevelMap !== undefined,
          thinkingLevelMap,
          parameterIds: {
            context: getParameter(item, "context") !== undefined,
            reasoning: getParameter(item, "reasoning") !== undefined,
            effort: getParameter(item, "effort") !== undefined,
            thinking: getParameter(item, "thinking") !== undefined,
            fast: getParameter(item, "fast") !== undefined,
          },
        };
        store.set(piModelId, entry);
        configs.push({
          id: piModelId,
          name: getModelName(item, context, fastOverride),
          reasoning: Boolean(thinkingLevelMap),
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
          input: ["text"],
          cost: { ...ZERO_COST },
          contextWindow,
          maxTokens: FALLBACK_MAX_TOKENS,
        });
        if (configs.length >= MAX_PICKER_MODELS) {
          return configs;
        }
      }
    }
  }

  if (!configs.length) {
    return fallbackProviderModels();
  }
  return configs;
}

/** Live catalog exposes `fast`; Pi persists `composer-2.5:slow`. Stub must too. */
const FAST_PARAMETER = {
  id: "fast",
  values: [{ value: "false" }, { value: "true" }],
};

function withFastParam(item) {
  const params = Array.isArray(item?.parameters) ? item.parameters : [];
  if (params.some((p) => p && p.id === "fast")) return item;
  return { ...item, parameters: [...params, FAST_PARAMETER] };
}

function fallbackCatalogItems() {
  return [
    withFastParam({
      id: DEFAULT_MODEL,
      display_name: "Composer 2.5",
      parameters: [],
      variants: [],
    }),
    { id: "auto", display_name: "Auto", parameters: [], variants: [] },
    {
      id: "auto-smart",
      display_name: "Auto (Router)",
      parameters: [
        {
          id: "optimize_for",
          display_name: "Optimize for",
          values: [
            { value: "cost", display_name: "Cost" },
            { value: "balanced", display_name: "Balance" },
            { value: "intelligence", display_name: "Intelligence" },
          ],
        },
      ],
      variants: [
        {
          params: [{ id: "optimize_for", value: "balanced" }],
          display_name: "Balance",
          is_default: true,
        },
      ],
    },
  ];
}

export function fallbackProviderModels() {
  return registerModelItems(fallbackCatalogItems());
}

/**
 * Cache + fallback aliases in one registerModelItems pass (do not call
 * fallback after cache — that clears metadata). Always includes
 * composer-2.5:slow so Pi restore does not jump to llama-cpp.
 */
export function bootstrapProviderModels() {
  const byId = new Map();
  for (const item of loadModelsCache() || []) {
    if (item?.id) byId.set(item.id, item);
  }
  for (const item of fallbackCatalogItems()) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const composer = byId.get(DEFAULT_MODEL);
  if (composer) byId.set(DEFAULT_MODEL, withFastParam(composer));
  return registerModelItems([...byId.values()]);
}

export function getCursorModelMetadata(modelId) {
  return metadataByPiModelId().get(modelId);
}

export function knownPiModelIds() {
  return new Set(metadataByPiModelId().keys());
}

/**
 * @param {object} metadata
 * @param {Array<{id:string,value:string}>} params
 * @param {string} level
 */
function applyThinkingLevel(metadata, params, level) {
  if (!metadata?.thinkingLevelMap || level === "off") {
    if (metadata?.parameterIds?.thinking) {
      const idx = params.findIndex((p) => p.id === "thinking");
      if (idx >= 0) params.splice(idx, 1);
      else params.push({ id: "thinking", value: "false" });
    }
    if (metadata?.parameterIds?.reasoning) {
      const mapped = metadata.thinkingLevelMap?.off;
      if (mapped) {
        const existing = params.find((p) => p.id === "reasoning" || p.id === "effort");
        if (existing) existing.value = mapped;
        else {
          const id = metadata.parameterIds.effort ? "effort" : "reasoning";
          params.push({ id, value: mapped });
        }
      }
    }
    return;
  }
  const mapped = metadata.thinkingLevelMap[level];
  if (mapped == null) return;
  if (metadata.parameterIds.effort) {
    const existing = params.find((p) => p.id === "effort");
    if (existing) existing.value = mapped;
    else params.push({ id: "effort", value: mapped });
    return;
  }
  if (metadata.parameterIds.reasoning) {
    const existing = params.find((p) => p.id === "reasoning");
    if (existing) existing.value = mapped;
    else params.push({ id: "reasoning", value: mapped });
    return;
  }
  if (metadata.parameterIds.thinking) {
    const existing = params.find((p) => p.id === "thinking");
    if (existing) existing.value = mapped;
    else params.push({ id: "thinking", value: mapped });
  }
}

/**
 * @param {string} modelId pi model id (may include @context:fast)
 * @param {string} [thinkingLevel]
 * @returns {{id: string, params?: Array<{id:string,value:string}>}}
 */
export function buildCursorModelSelection(modelId, thinkingLevel = "off") {
  const metadata = getCursorModelMetadata(modelId);
  if (metadata) {
    const params = cloneParams(metadata.defaultParams);
    applyThinkingLevel(metadata, params, thinkingLevel);
    return params.length
      ? { id: metadata.selectionModelId, params }
      : { id: metadata.selectionModelId };
  }
  // Catalog Map missing (jiti split) or unknown picker id — still honor
  // @context / :fast|:slow so sticky SendOptions is not a bare composer id.
  const parsed = parsePiModelId(modelId);
  const params = [];
  if (parsed.context) params.push({ id: "context", value: parsed.context });
  if (parsed.fastOverride === true) params.push({ id: "fast", value: "true" });
  if (parsed.fastOverride === false) params.push({ id: "fast", value: "false" });
  return params.length ? { id: parsed.baseId, params } : { id: parsed.baseId };
}

/**
 * Soft fallback: if current pi model id missing from catalog → best match by
 * base id (``grok-4.5:slow`` → ``grok-4.5…``) else composer-2.5.
 * @param {string | undefined} currentId
 * @param {object[]} providerModels
 */
export function resolveModelOrFallback(currentId, providerModels) {
  const list = providerModels || [];
  const ids = new Set(list.map((m) => m.id));
  if (currentId && ids.has(currentId)) return currentId;
  if (currentId) {
    const parsed = parsePiModelId(currentId);
    const base = parsed.baseId || currentId;
    const hits = list.filter((m) => {
      if (!m?.id) return false;
      if (m.id === base) return true;
      const p = parsePiModelId(m.id);
      return p.baseId === base;
    });
    if (hits.length) {
      const exact = hits.find((m) => {
        const p = parsePiModelId(m.id);
        return (
          p.fastOverride === parsed.fastOverride &&
          (p.context || undefined) === (parsed.context || undefined)
        );
      });
      if (exact) return exact.id;
      const sameFast = hits.find(
        (m) => parsePiModelId(m.id).fastOverride === parsed.fastOverride
      );
      if (sameFast) return sameFast.id;
      return hits[0].id;
    }
  }
  if (ids.has(DEFAULT_MODEL)) return DEFAULT_MODEL;
  return list[0]?.id || DEFAULT_MODEL;
}

const MODELS_CACHE_NAME = "cursor-remote-models-cache.json";
const MAX_CACHED_MODELS = 80;

export function modelsCachePath() {
  return join(dirname(defaultConfigPath()), MODELS_CACHE_NAME);
}

function sanitizeCatalogItem(item) {
  if (!item || typeof item.id !== "string" || !item.id.trim()) return null;
  return {
    id: item.id.trim().slice(0, 128),
    display_name: String(item.display_name || item.displayName || item.id).slice(0, 200),
    parameters: Array.isArray(item.parameters) ? item.parameters : [],
    variants: Array.isArray(item.variants) ? item.variants : [],
  };
}

/** Persist last live VPS catalog so Pi can restore grok-*:slow before GET /models. */
export function saveModelsCache(items) {
  const models = (items || []).map(sanitizeCatalogItem).filter(Boolean).slice(0, MAX_CACHED_MODELS);
  if (!models.length) return;
  const path = modelsCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ savedAt: Date.now(), models }, null, 0),
    { encoding: "utf8", mode: 0o600 }
  );
}

export function loadModelsCache() {
  const path = modelsCachePath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const models = Array.isArray(raw?.models) ? raw.models : null;
    if (!models?.length) return null;
    const clean = models.map(sanitizeCatalogItem).filter(Boolean);
    return clean.length ? clean : null;
  } catch {
    return null;
  }
}

/** Last cached catalog as provider models, or null. */
export function cachedProviderModels() {
  const items = loadModelsCache();
  if (!items) return null;
  const configs = registerModelItems(items);
  return configs.length ? configs : null;
}
