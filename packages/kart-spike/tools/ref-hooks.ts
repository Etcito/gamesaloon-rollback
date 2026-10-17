// Resolve hook that lets node (type stripping) load the reference game's TypeScript sources, which use
// extension-less relative imports ('../core/types', './mech/index'). Read-only: nothing is written there.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) {
      for (const suffix of [".ts", "/index.ts"]) {
        try { return nextResolve(specifier + suffix, context); } catch { /* try next */ }
      }
    }
    return nextResolve(specifier, context);
  },
});
