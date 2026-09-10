/**
 * Pi extension entry. Must stay TypeScript: the bundled CLI's jiti native-
 * imports `"type":"module"` `.js` (no virtualModules rewrite), while Hermes
 * `completeSimple` is loaded from `.ts` onto the in-memory compat registry.
 * This file is always transpiled, so the specifier below is the same copy.
 */
import { bindJitiRegisterApiProvider } from "./compat-api.js";
import factory from "./index.js";

try {
  const compat = await import("@earendil-works/pi-ai/compat");
  const reg =
    typeof compat?.registerApiProvider === "function"
      ? compat.registerApiProvider
      : compat?.default?.registerApiProvider;
  bindJitiRegisterApiProvider(reg);
} catch {
  // Host without jiti aliases / virtualModules: disk walk in compat-api.js.
}

export default factory;
