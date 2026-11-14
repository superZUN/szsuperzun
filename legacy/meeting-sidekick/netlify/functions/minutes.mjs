// Meeting-minutes library for "회의 옆자리", stored in Netlify Blobs.
// GET    /api/minutes          -> { items: [{ id, name, added, size, updatedAt }] }
// GET    /api/minutes?id=ID    -> { id, name, text, added, updatedAt }
// PUT    /api/minutes  { id, name, text, added } -> { id, updatedAt }
// DELETE /api/minutes?id=ID    -> { ok: true }
// Same passcode as the glossary: header x-passcode must equal the SIDEKICK_PASSCODE environment variable.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const MAX_CHARS = 2_000_000;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const passOk = (given, expected) => {
  const a = Buffer.from(String(given || "")), b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
};
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(id);

export default async (req) => {
  const expected = Netlify.env.get("SIDEKICK_PASSCODE");
  if (!expected) return json({ error: "not_configured" }, 503);
  if (!passOk(req.headers.get("x-passcode"), expected)) return json({ error: "unauthorized" }, 401);

  const store = getStore({ name: "sidekick", consistency: "strong" }); // strong: an index read must never point at a blob that is not visible yet
  const id = new URL(req.url).searchParams.get("id");
  const readIndex = async () => (await store.get("minutes-index", { type: "json" })) || [];

  if (req.method === "GET") {
    if (!id) return json({ items: await readIndex() });
    if (!validId(id)) return json({ error: "bad_id" }, 400);
    const doc = await store.get("minutes/" + id, { type: "json" });
    if (doc) return json(doc);
    // the index points at a blob that no longer exists: drop the stale entry so clients stop asking for it
    await store.setJSON("minutes-index", (await readIndex()).filter((x) => x.id !== id));
    return json({ error: "not_found" }, 404);
  }

  if (req.method === "PUT") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!validId(b?.id) || typeof b?.text !== "string" || typeof b?.name !== "string") return json({ error: "bad_doc" }, 400);
    if (b.text.length > MAX_CHARS) return json({ error: "too_long", max: MAX_CHARS }, 413);
    const updatedAt = Date.now();
    const doc = { id: b.id, name: b.name.slice(0, 200), text: b.text, added: Number(b.added) || updatedAt, updatedAt };
    await store.setJSON("minutes/" + b.id, doc);
    const index = (await readIndex()).filter((x) => x.id !== b.id);
    index.push({ id: doc.id, name: doc.name, added: doc.added, size: doc.text.length, updatedAt });
    await store.setJSON("minutes-index", index);
    return json({ id: doc.id, updatedAt });
  }

  if (req.method === "DELETE") {
    if (!validId(id)) return json({ error: "bad_id" }, 400);
    await store.delete("minutes/" + id);
    await store.setJSON("minutes-index", (await readIndex()).filter((x) => x.id !== id));
    return json({ ok: true });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: "/api/minutes" };
