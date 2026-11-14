// The app starts, the vendor libraries are served from our own site, and the test harness fakes behave like the real APIs.
import { test, expect } from "../harness/fixtures";
import { mockAI, mockWiki } from "../harness/ai-mock";

test("앱이 오류 없이 뜬다", async ({ open }) => {
  const page = await open();
  await expect(page).toHaveTitle("Jay");
  await expect(page.locator(".brand h1")).toHaveText("Jay");
  await expect(page.locator("#status")).toHaveText("STANDBY");
});

test("외부 라이브러리는 직접 호스팅", async ({ request }) => {
  for (const f of ["mermaid.min.js", "pdf.min.js", "pdf.worker.min.js", "jszip.min.js"]) {
    const r = await request.get("/vendor/" + f);
    expect(r.status(), f).toBe(200);
    expect((await r.body()).length, f).toBeGreaterThan(50_000);
  }
});

test("하네스: 가짜 음성 인식 — 시작·중간·확정·대안·끝·오류·권한 거부", async ({ open }) => {
  const page = await open();
  const log = await page.evaluate(async () => {
    const w = window as any, out: string[] = [];
    const r = new w.webkitSpeechRecognition(); r.continuous = true; r.interimResults = true; r.maxAlternatives = 3;
    r.onstart = () => out.push("start");
    r.onresult = (e: any) => { const x = e.results[e.resultIndex]; out.push(`${x.isFinal ? "final" : "interim"}:${x[0].transcript}${x.length > 1 ? "|" + x[1].transcript : ""}`); };
    r.onerror = (e: any) => out.push("error:" + e.error);
    r.onend = () => out.push("end");
    r.start();
    let threw = false; try { r.start(); } catch { threw = true; } out.push("double-start-throws:" + threw);
    await new Promise((s) => setTimeout(s, 60));
    w.__interim("안녕하"); w.__say("안녕하세요", { alts: ["안녕 하세요"] });
    w.__end(); await new Promise((s) => setTimeout(s, 20));
    w.__sr.denyStarts = 1; r.start(); await new Promise((s) => setTimeout(s, 60));
    r.start(); await new Promise((s) => setTimeout(s, 60)); w.__err("network"); await new Promise((s) => setTimeout(s, 20));
    return { out, starts: w.__recStarts };
  });
  expect(log.out).toEqual(["double-start-throws:true", "start", "interim:안녕하", "final:안녕하세요|안녕 하세요", "end",
    "error:not-allowed", "end", "start", "error:network", "end"]);
  expect(log.starts).toBe(3);
});

test("하네스: 가짜 마이크 — 음량 조절, 60Hz 웅웅거림, 권한 거부", async ({ open }) => {
  const page = await open();
  const r = await page.evaluate(async () => {
    const w = window as any;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext(); await ctx.resume();
    const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(1024);
    const rms = async () => { await new Promise((s) => setTimeout(s, 250)); an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
    const quiet = await rms();
    w.__mic.set({ voice: 1 }); const loud = await rms();
    w.__mic.set({ voice: 0, hum: 1 }); const hum = await rms();
    w.__mic.deny = true; let denied = ""; try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e: any) { denied = e.name; }
    return { quiet, loud, hum, denied, opened: w.__mic.opened };
  });
  expect(r.quiet).toBeLessThan(0.001);
  expect(r.loud).toBeGreaterThan(0.05);
  expect(r.hum).toBeGreaterThan(0.05);
  expect(r.denied).toBe("NotAllowedError");
  expect(r.opened).toBe(1);
});

test("하네스: 가짜 Wake Lock — 시스템이 풀면 release 이벤트", async ({ open }) => {
  const page = await open();
  const r = await page.evaluate(async () => {
    const w = window as any; let released = 0;
    const s = await (navigator as any).wakeLock.request("screen"); s.addEventListener("release", () => released++);
    w.__wake.release(); return { released, requests: w.__wake.requests, active: w.__wake.active };
  });
  expect(r).toEqual({ released: 1, requests: 1, active: null });
});

test("하네스: AI 모킹 — 4개 제공자 SSE, 웹 검색, 오류 상태", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => c.prompt.includes("오류") ? { status: 429, error: "busy" }
    : { text: `${c.provider} 답변입니다`, searched: c.webSearch ? [{ title: "출처", url: "https://example.com/a" }] : undefined }, { compatBase: "https://compat.test/v1" });
  await open();
  const r = await page.evaluate(async () => {
    const read = async (res: Response) => { const t = await res.text(); return t.split("\n").filter((l) => l.startsWith("data:")).length; };
    const post = (u: string, b: any) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return {
      ant: await read(await post("https://api.anthropic.com/v1/messages", { stream: true, messages: [{ role: "user", content: "질문" }], tools: [{ type: "web_search_20250305" }] })),
      oai: await read(await post("https://api.openai.com/v1/chat/completions", { messages: [{ role: "user", content: "질문" }] })),
      gem: await read(await post("https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse", { contents: [{ parts: [{ text: "질문" }] }], tools: [{ google_search: {} }] })),
      cmp: await read(await post("https://compat.test/v1/chat/completions", { messages: [{ role: "user", content: "질문" }] })),
      err: (await post("https://api.anthropic.com/v1/messages", { messages: [{ role: "user", content: "오류" }] })).status,
      models: (await (await fetch("https://api.anthropic.com/v1/models?limit=1")).json()).data.length,
    };
  });
  expect(r.ant).toBeGreaterThan(3);
  expect(r.oai).toBeGreaterThan(1);
  expect(r.gem).toBeGreaterThan(1);
  expect(r.cmp).toBeGreaterThan(1);
  expect(r.err).toBe(429);
  expect(r.models).toBe(2);
  expect(ai.calls.map((c) => c.provider)).toEqual(["anthropic", "openai", "gemini", "compat", "anthropic"]);
  expect(ai.calls[0].webSearch).toBe(true);
  expect(ai.calls[2].webSearch).toBe(true);
});

test("하네스: 위키백과·Commons 모킹, 그 밖의 외부 요청은 차단", async ({ open, page }) => {
  const wiki = await mockWiki(page, { ko: { "파우치": { title: "파우치형 전지", extract: "파우치 셀", thumb: "https://upload.wikimedia.org/a.png" } } });
  await open();
  const r = await page.evaluate(async () => {
    const j = await (await fetch("https://ko.wikipedia.org/w/api.php?action=query&gsrsearch=%ED%8C%8C%EC%9A%B0%EC%B9%98&origin=*")).json();
    let blocked = false; try { await fetch("https://example.org/"); } catch { blocked = true; }
    return { title: (Object.values(j.query.pages)[0] as any).title, blocked };
  });
  expect(r).toEqual({ title: "파우치형 전지", blocked: true });
  expect(wiki.hits).toEqual(["ko:파우치"]);
});
