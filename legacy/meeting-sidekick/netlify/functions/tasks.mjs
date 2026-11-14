// To-do list for "회의 옆자리", stored in Netlify Blobs.
// GET /api/tasks              -> { items: [...], updatedAt }
// PUT /api/tasks { items }    -> { items: [...merged], updatedAt }
// Items are merged by id; the copy with the newer updatedAt wins, so two devices editing different tasks never overwrite each other.
// Deleted tasks travel as { id, deleted: true, updatedAt } and are dropped after 60 days.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const MAX_ITEMS = 3000;
const KEEP_DELETED_MS = 60 * 24 * 3600 * 1000;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const passOk = (given, expected) => {
  const a = Buffer.from(String(given || "")), b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
};
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const clean = (t) => ({
  id: str(t.id, 80), text: str(t.text, 500), owner: str(t.owner, 80), due: str(t.due, 40), result: str(t.result, 1000), from: str(t.from, 200),
  done: !!t.done, doneAt: Number(t.doneAt) || 0, at: Number(t.at) || 0, updatedAt: Number(t.updatedAt) || 0, deleted: !!t.deleted,
});

export default async (req) => {
  const expected = Netlify.env.get("SIDEKICK_PASSCODE");
  if (!expected) return json({ error: "not_configured" }, 503);
  if (!passOk(req.headers.get("x-passcode"), expected)) return json({ error: "unauthorized" }, 401);

  const store = getStore({ name: "sidekick", consistency: "strong" });
  const saved = (await store.get("tasks", { type: "json" })) || { items: [], updatedAt: 0 };

  if (req.method === "GET") return json(saved);

  if (req.method === "PUT") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!Array.isArray(b?.items)) return json({ error: "items_required" }, 400);
    const map = new Map(saved.items.map((t) => [t.id, t]));
    for (const raw of b.items.slice(0, MAX_ITEMS)) {
      const t = clean(raw || {});
      if (!t.id) continue;
      const old = map.get(t.id);
      if (!old || t.updatedAt >= old.updatedAt) map.set(t.id, t);
    }
    const now = Date.now();
    const items = [...map.values()].filter((t) => !(t.deleted && now - t.updatedAt > KEEP_DELETED_MS)).slice(-MAX_ITEMS);
    const out = { items, updatedAt: now };
    await store.setJSON("tasks", out);
    return json(out);
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: "/api/tasks" };
