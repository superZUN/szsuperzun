// To-do webhook for "Jay": every new task goes to the user's Power Automate flow as { issue, pic, status }.
// The flow URL carries a signature (sig=…), so it is kept here in Netlify Blobs — never in the code, the repo or other devices.
// GET  /api/hook                         -> { configured, host }
// PUT  /api/hook { url }                 -> { configured, host }      ("" clears it)
// POST /api/hook { issue, pic, status }  -> { ok, status }            (forwarded to the saved URL)
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const passOk = (given, expected) => {
  const a = Buffer.from(String(given || "")), b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
};
const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
/** only Microsoft flow hosts (and the local test sink while testing) */
function allowed(u) {
  let x; try { x = new URL(u); } catch { return false; }
  if (Netlify.env.get("SIDEKICK_TEST_API") === "1" && x.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(x.hostname)) return true;
  return x.protocol === "https:" && /(^|\.)(powerplatform\.com|logic\.azure\.com)$/i.test(x.hostname);
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };

export default async (req) => {
  const expected = Netlify.env.get("SIDEKICK_PASSCODE");
  if (!expected) return json({ error: "not_configured" }, 503);
  if (!passOk(req.headers.get("x-passcode"), expected)) return json({ error: "unauthorized" }, 401);
  const store = getStore({ name: "sidekick", consistency: "strong" });
  const saved = (await store.get("hook", { type: "json" })) || { url: "" };

  if (req.method === "GET") return json({ configured: !!saved.url, host: hostOf(saved.url) });
  let b; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  if (req.method === "PUT") {
    const url = str(b?.url, 2000);
    if (url && !allowed(url)) return json({ error: "bad_url" }, 400);
    await store.setJSON("hook", { url, updatedAt: Date.now() });
    return json({ configured: !!url, host: hostOf(url) });
  }
  if (req.method === "POST") {
    if (!saved.url) return json({ error: "no_hook" }, 409);
    const body = { issue: str(b?.issue, 300), pic: str(b?.pic, 80), status: str(b?.status, 20) || "OPEN" };
    if (!body.issue) return json({ error: "issue_required" }, 400);
    try {
      const r = await fetch(saved.url, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      return json(r.ok ? { ok: true, status: r.status } : { ok: false, error: `HTTP ${r.status}`, status: r.status }, r.ok ? 200 : 502);
    } catch { return json({ ok: false, error: "응답 없음" }, 502); }
  }
  return json({ error: "method" }, 405);
};
export const config = { path: "/api/hook" };
