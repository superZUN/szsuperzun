// In-memory stand-in for @netlify/blobs, used only by the local test API server.
// Each request runs inside a test namespace (header x-test-ns), so parallel tests never see each other's data.
import { AsyncLocalStorage } from "node:async_hooks";

export const testCtx = new AsyncLocalStorage();
const spaces = new Map(); // ns -> Map(storeName -> Map(key -> json string))

function space(ns) {
  if (!spaces.has(ns)) spaces.set(ns, new Map());
  return spaces.get(ns);
}
export function resetNs(ns) { spaces.delete(ns); }
export function deleteKey(ns, store, key) { space(ns).get(store)?.delete(key); }
export function dumpNs(ns) {
  const out = {};
  for (const [name, m] of space(ns)) out[name] = Object.fromEntries([...m].map(([k, v]) => [k, JSON.parse(v)]));
  return out;
}

export function getStore(opts) {
  const name = typeof opts === "string" ? opts : opts.name;
  const ns = testCtx.getStore()?.ns || "default";
  const sp = space(ns);
  if (!sp.has(name)) sp.set(name, new Map());
  const m = sp.get(name);
  return {
    async get(key, o = {}) {
      if (!m.has(key)) return null;
      const raw = m.get(key);
      return o.type === "json" ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) { m.set(key, JSON.stringify(value)); },
    async set(key, value) { m.set(key, JSON.stringify(value)); },
    async delete(key) { m.delete(key); },
    async list() { return { blobs: [...m.keys()].map((key) => ({ key })) }; },
  };
}
