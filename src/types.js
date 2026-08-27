/**
 * Minimal ExtensionAPI surface we rely on (pi-coding-agent).
 * Not a full type package — keep the extension thin.
 *
 * @typedef {object} ProviderConfig
 * @property {string} [name]
 * @property {string} [api]
 * @property {string} [apiKey]
 * @property {string} [baseUrl]
 * @property {Function} [streamSimple]
 * @property {object[]} [models]
 *
 * @typedef {object} ExtensionAPI
 * @property {(name: string, config: ProviderConfig) => void} registerProvider
 * @property {(name: string, spec: { description?: string, handler: Function }) => void} [registerCommand]
 */

export {};
