// Vite plugin: serves netlify/functions/*.mjs at their /api paths with an in-memory Blobs store.
// Enabled only when SIDEKICK_TEST_API=1 (tests). Works for both `vite` and `vite preview`.
//   header x-test-ns       : data namespace (one per test)
//   header x-test-env-pass : passcode the "server" expects; "-" = SIDEKICK_PASSCODE not set
//   POST /__test/blobs/reset, GET /__test/blobs/dump, POST /__test/blobs/delete?store=&key= : manage a namespace
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockUrl = pathToFileURL(path.join(here, "blobs-mock.mjs")).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@netlify/blobs") return { url: mockUrl, shortCircuit: true };
    return next(spec, ctx);
  },
});
const { testCtx, resetNs, dumpNs, deleteKey } = await import(mockUrl);

globalThis.Netlify = {
  env: {
    get(k) {
      if (k !== "SIDEKICK_PASSCODE") return process.env[k];
      const p = testCtx.getStore()?.pass;
      return p === "-" ? undefined : p ?? "test-pass";
    },
  },
};

const fnDir = path.resolve(here, "../../netlify/functions");
const routes = {};
for (const name of ["glossary", "minutes", "tasks", "hook"]) {
  const mod = await import(pathToFileURL(path.join(fnDir, name + ".mjs")).href);
  routes[mod.config.path] = mod.default;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const sink = {};
function middleware() {
  return async (req, res, next) => {
    const url = new URL(req.url, "http://local");
    const ns = String(req.headers["x-test-ns"] || "default");
    if (url.pathname === "/__test/blobs/reset") { resetNs(ns); res.end("{}"); return; }
    if (url.pathname === "/__test/blobs/delete") { deleteKey(ns, url.searchParams.get("store"), url.searchParams.get("key")); res.end("{}"); return; }
    // a stand-in for the Power Automate flow: POST stores the body (?fail=1 answers 500), GET lists what arrived
    if (url.pathname === "/__test/hook-sink") {
      const key = url.searchParams.get("ns") || "default"; const list = (sink[key] ||= []);
      if (req.method === "POST") { // ?failOn=word refuses only bodies whose issue contains that word
        const body = JSON.parse(String(await readBody(req)) || "{}"), fo = url.searchParams.get("failOn");
        const fail = url.searchParams.get("fail") || (fo && String(body.issue || "").includes(fo)); if (!fail) list.push(body);
        res.statusCode = fail ? 500 : 202; res.end(""); return;
      }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(list)); return;
    }
    if (url.pathname === "/__test/blobs/dump") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(dumpNs(ns))); return; }
    const fn = routes[url.pathname];
    if (!fn) return next();
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(url.href, { method: req.method, headers, body });
    const pass = req.headers["x-test-env-pass"];
    const r = await testCtx.run({ ns, pass: typeof pass === "string" ? pass : undefined }, () => fn(request));
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await r.arrayBuffer()));
  };
}

export function localApi() {
  return {
    name: "sidekick-local-api",
    configureServer(server) { server.middlewares.use(middleware()); },
    configurePreviewServer(server) { server.middlewares.use(middleware()); },
  };
}
