// Netlify Functions (glossary / minutes / tasks) against the in-memory Blobs store.
import { test, expect } from "../harness/fixtures";
import type { APIRequestContext } from "@playwright/test";

const H = (ns: string, extra: Record<string, string> = {}) => ({ "x-test-ns": ns, "x-passcode": "test-pass", "content-type": "application/json", ...extra });
const call = (r: APIRequestContext, ns: string, method: string, path: string, data?: any, extra?: Record<string, string>) =>
  r.fetch(path, { method, headers: H(ns, extra), data: data === undefined ? undefined : JSON.stringify(data) });

test.describe("인증", () => {
  for (const path of ["/api/glossary", "/api/minutes", "/api/tasks"]) {
    test(`${path}: 서버 암호 미설정 503, 틀리면 401`, async ({ request, ns }) => {
      const a = await call(request, ns, "GET", path, undefined, { "x-test-env-pass": "-" });
      expect(a.status()).toBe(503);
      expect((await a.json()).error).toBe("not_configured");
      const b = await call(request, ns, "GET", path, undefined, { "x-passcode": "wrong" });
      expect(b.status()).toBe(401);
      const c = await call(request, ns, "GET", path, undefined, { "x-passcode": "" });
      expect(c.status()).toBe(401);
    });
  }
});

test("용어 사전: 비어 있으면 빈 값, 저장 후 읽기, 2만 자 제한", async ({ request, ns }) => {
  expect(await (await call(request, ns, "GET", "/api/glossary")).json()).toEqual({ text: "", updatedAt: 0 });
  const put = await (await call(request, ns, "PUT", "/api/glossary", { text: "SOH = State of Health" })).json();
  expect(put.text).toBe("SOH = State of Health");
  expect(put.updatedAt).toBeGreaterThan(0);
  expect((await (await call(request, ns, "GET", "/api/glossary")).json()).text).toBe("SOH = State of Health");
  expect((await call(request, ns, "PUT", "/api/glossary", { text: "x".repeat(20001) })).status()).toBe(413);
  expect((await call(request, ns, "PUT", "/api/glossary", { nope: 1 })).status()).toBe(400);
});

test("회의록: 올리기·목록·읽기·바꾸기·지우기", async ({ request, ns }) => {
  expect((await (await call(request, ns, "GET", "/api/minutes")).json()).items).toEqual([]);
  await call(request, ns, "PUT", "/api/minutes", { id: "1-m", name: "주간회의", text: "본문", added: 5 });
  await call(request, ns, "PUT", "/api/minutes", { id: "2-m", name: "두 번째", text: "둘", added: 6 });
  let items = (await (await call(request, ns, "GET", "/api/minutes")).json()).items;
  expect(items.map((x: any) => x.id).sort()).toEqual(["1-m", "2-m"]);
  expect(items.find((x: any) => x.id === "1-m")).toMatchObject({ name: "주간회의", added: 5, size: 2 });
  await call(request, ns, "PUT", "/api/minutes", { id: "1-m", name: "주간회의 v2", text: "새 본문", added: 5 });
  items = (await (await call(request, ns, "GET", "/api/minutes")).json()).items;
  expect(items.filter((x: any) => x.id === "1-m")).toHaveLength(1);
  expect(await (await call(request, ns, "GET", "/api/minutes?id=1-m")).json()).toMatchObject({ name: "주간회의 v2", text: "새 본문" });
  expect((await (await call(request, ns, "DELETE", "/api/minutes?id=1-m")).json()).ok).toBe(true);
  expect((await call(request, ns, "GET", "/api/minutes?id=1-m")).status()).toBe(404);
  expect((await (await call(request, ns, "GET", "/api/minutes")).json()).items.map((x: any) => x.id)).toEqual(["2-m"]);
  expect((await call(request, ns, "GET", "/api/minutes?id=../x")).status()).toBe(400);
  expect((await call(request, ns, "PUT", "/api/minutes", { id: "a b", name: "x", text: "y" })).status()).toBe(400);
});

test("회의록: 본문 없는 색인 항목은 GET 때 404 + 색인에서 정리", async ({ request, ns }) => {
  await call(request, ns, "PUT", "/api/minutes", { id: "ghost", name: "유령", text: "x", added: 1 });
  await call(request, ns, "PUT", "/api/minutes", { id: "keep", name: "남을 것", text: "y", added: 2 });
  // the body disappears but the index still lists it (what a lagging store would look like)
  await request.post("/__test/blobs/delete?store=sidekick&key=minutes/ghost", { headers: { "x-test-ns": ns } });
  expect((await (await call(request, ns, "GET", "/api/minutes")).json()).items.map((x: any) => x.id).sort()).toEqual(["ghost", "keep"]);
  expect((await call(request, ns, "GET", "/api/minutes?id=ghost")).status()).toBe(404);
  expect((await (await call(request, ns, "GET", "/api/minutes")).json()).items.map((x: any) => x.id)).toEqual(["keep"]);
});

test("할 일: 항목별 updatedAt 병합 — 두 기기가 서로 덮어쓰지 않음", async ({ request, ns }) => {
  const a = { id: "t1", text: "샘플 재측정", owner: "박지은", due: "11/20", updatedAt: 100 };
  const b = { id: "t2", text: "견적 회신", updatedAt: 100 };
  await call(request, ns, "PUT", "/api/tasks", { items: [a, b] });
  // device 2 edits t2 only, and still has an older t1
  await call(request, ns, "PUT", "/api/tasks", { items: [{ ...a, text: "옛 내용", updatedAt: 50 }, { ...b, done: true, updatedAt: 200 }] });
  const got = (await (await call(request, ns, "GET", "/api/tasks")).json()).items;
  expect(got.find((t: any) => t.id === "t1").text).toBe("샘플 재측정");
  expect(got.find((t: any) => t.id === "t2").done).toBe(true);
});

test("할 일: 삭제 묘비는 남고, 60일 지난 묘비는 정리", async ({ request, ns }) => {
  const old = Date.now() - 61 * 864e5;
  await call(request, ns, "PUT", "/api/tasks", { items: [
    { id: "gone", deleted: true, updatedAt: Date.now() },
    { id: "ancient", deleted: true, updatedAt: old },
    { id: "", text: "id 없음" },
  ] });
  const ids = (await (await call(request, ns, "GET", "/api/tasks")).json()).items.map((t: any) => t.id);
  expect(ids).toEqual(["gone"]);
  expect((await call(request, ns, "PUT", "/api/tasks", { nope: 1 })).status()).toBe(400);
});
