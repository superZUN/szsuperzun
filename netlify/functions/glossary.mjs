// Shared glossary for "Jay" (회의 옆자리), stored in Netlify Blobs.
// GET  /api/glossary  -> { text, updatedAt }
// PUT  /api/glossary  { text } -> { text, updatedAt }
// Every request must carry the passcode set in the site's environment variable SIDEKICK_PASSCODE
// (header: x-passcode). Without that variable the endpoint refuses everything.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const MAX_CHARS = 20000;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function passOk(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async (req) => {
  const expected = Netlify.env.get("SIDEKICK_PASSCODE");
  if (!expected) return json({ error: "not_configured" }, 503);
  if (!passOk(req.headers.get("x-passcode"), expected)) return json({ error: "unauthorized" }, 401);

  const store = getStore({ name: "sidekick", consistency: "strong" }); // strong: an index read must never point at a blob that is not visible yet

  if (req.method === "GET") {
    const saved = await store.get("glossary", { type: "json" });
    return json(saved || { text: "", updatedAt: 0 });
  }

  if (req.method === "PUT") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (typeof body?.text !== "string") return json({ error: "text_required" }, 400);
    if (body.text.length > MAX_CHARS) return json({ error: "too_long", max: MAX_CHARS }, 413);
    const saved = { text: body.text, updatedAt: Date.now() };
    await store.setJSON("glossary", saved);
    return json(saved);
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: "/api/glossary" };
