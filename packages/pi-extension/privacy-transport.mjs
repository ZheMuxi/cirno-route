// Pi 1.2.0 exposes the configured ModelRuntime through its compatibility registry.
// This intentionally guards the last provider dispatch, after authentication can
// replace baseUrl. Event-handler exceptions alone do not stop Pi requests.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
function supportedHost() {
  try {
    // This package exports only an ESM condition, so require.resolve(package) is not valid.
    for (const root of require.resolve.paths('@earendil-works/pi-coding-agent') ?? []) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, '@earendil-works/pi-coding-agent/package.json'), 'utf8'));
        return pkg.name === '@earendil-works/pi-coding-agent' && pkg.version === '1.2.0';
      } catch (error) { if (error.code !== 'ENOENT') return false; }
    }
    return false;
  } catch { return false; }
}
const INSTALLATION = Symbol.for('cirno-route.privacy-transport.v1');
const METHODS = new Set(['stream', 'streamSimple', 'generateImages', 'classify', 'fetchDeferred', 'cancelDeferred']);

export class PrivacyTransportError extends Error {
  constructor(code = 'PRIVACY_GUARD_UNAVAILABLE') { super(code); this.name = 'PrivacyTransportError'; this.code = code; }
}

function unavailable() { throw new PrivacyTransportError(); }

function guardProvider(provider, state) {
  const methods = new Map();
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (!METHODS.has(property) || typeof value !== 'function') return value;
      if (!methods.has(property)) methods.set(property, function (model, context, options) {
        // A request prepared before unloading must not escape after the last guard
        // disappears. Newly prepared requests use the restored runtime normally.
        if (!state.guards.size) unavailable();
        for (const guard of state.guards.keys()) {
          const result = guard.assertRequest(model, context, options);
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch(() => {});
            unavailable();
          }
        }
        return Reflect.apply(value, target, arguments);
      });
      return methods.get(property);
    },
  });
}

/**
 * Install one synchronous guard on Pi's final model dispatch. The private runtime
 * seam is pinned to Pi 1.2.0; unknown shapes are rejected rather than silently
 * falling back to event hooks. Does not patch Pi files or the global API registry.
 */
export function installPrivacyTransport(registry, guard) {
  if (!supportedHost() || !guard || typeof guard.assertRequest !== 'function') unavailable();
  let runtime;
  try { runtime = registry?.runtime; } catch { unavailable(); }
  if (!runtime || typeof runtime.prepareRequest !== 'function'
    || typeof runtime.stream !== 'function' || typeof runtime.streamSimple !== 'function') unavailable();
  let state = runtime[INSTALLATION];
  if (state && (state.wrapper !== runtime.prepareRequest || !(state.guards instanceof Map))) unavailable();
  if (!state) {
    const descriptor = Object.getOwnPropertyDescriptor(runtime, 'prepareRequest');
    if (descriptor && (!('value' in descriptor) || !descriptor.writable)) unavailable();
    state = { original: runtime.prepareRequest, descriptor, guards: new Map(), wrapper: null };
    state.wrapper = async function (...args) {
      const prepared = await Reflect.apply(state.original, this, args);
      if (!state.guards.size || !prepared?.model || !prepared?.provider
        || typeof prepared.provider !== 'object') unavailable();
      return { ...prepared, provider: guardProvider(prepared.provider, state) };
    };
    try {
      Object.defineProperty(runtime, INSTALLATION, { value: state, configurable: true });
      Object.defineProperty(runtime, 'prepareRequest', {
        ...descriptor, value: state.wrapper, configurable: descriptor?.configurable ?? true,
        writable: true, enumerable: descriptor?.enumerable ?? false,
      });
    } catch {
      if (runtime[INSTALLATION] === state) delete runtime[INSTALLATION];
      unavailable();
    }
  }
  state.guards.set(guard, (state.guards.get(guard) ?? 0) + 1);
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      const count = state.guards.get(guard);
      if (count > 1) state.guards.set(guard, count - 1);
      else state.guards.delete(guard);
      if (state.guards.size) return;
      // Another extension may have installed its own wrapper after ours. Never
      // overwrite that extension's mutation while cleaning up this installation.
      if (runtime.prepareRequest === state.wrapper) {
        if (state.descriptor) Object.defineProperty(runtime, 'prepareRequest', state.descriptor);
        else delete runtime.prepareRequest;
      }
      if (runtime[INSTALLATION] === state) delete runtime[INSTALLATION];
    },
  };
}
