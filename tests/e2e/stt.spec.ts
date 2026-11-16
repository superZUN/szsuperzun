// Gemini transcription: only speech is sent (as 16 kHz WAV), Gemini-only and hybrid modes, restoring what Safari missed,
// the 5-times rule that teaches the glossary, falling back to Safari when Gemini keeps failing.
import { test, expect, startListening, app } from "../harness/fixtures";
import { mockAI, type AICall } from "../harness/ai-mock";
import type { Page } from "@playwright/test";

const ev = (page: Page, js: string) => page.evaluate(js);
const isStt = (c: AICall) => (c.body?.contents?.[0]?.parts || []).some((p: any) => p.inline_data);
const transcript = (page: Page) => app(page, "A.S.segs.map(s => s.fix ?? s.raw).filter(Boolean).join(' | ')") as Promise<string>;
/** someone speaks for `ms`, then stops (the gauge decides what is speech) */
const speak = async (page: Page, ms = 1500, during?: string) => {
  await expect.poll(() => app(page, "A.cloud.node != null"), { timeout: 5000 }).toBe(true); // capture is attached to the microphone
  await ev(page, "window.__mic.set({ voice: 1 })"); await page.waitForTimeout(ms / 2);
  if (during) await ev(page, during);
  await page.waitForTimeout(ms / 2); await ev(page, "window.__mic.set({ voice: 0 })");
};
const GEM = { "ms.key.gemini": "AIza-test" };

test("Gemini만: Safari 인식은 켜지 않고, 말소리 구간만 WAV로 보내 받아쓴 글자를 기록", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isStt(c) ? "고객사 샘플 납기는 11월 20일입니다. Formation 3호기 수율은 96.5%예요." : "[]"));
  await open({ storage: { ...GEM, "ms.sttMode": "cloud" } });
  await page.click("#startBtn");
  await expect(page.locator("#recState")).toHaveText("Gemini 받아쓰기");
  expect(await ev(page, "window.__sr.instances.length")).toBe(0);
  await speak(page);
  await expect.poll(() => transcript(page), { timeout: 6000 }).toBe("고객사 샘플 납기는 11월 20일입니다. Formation 3호기 수율은 96.5%예요.");
  const c = ai.calls.find(isStt)!;
  expect(c.url).toContain("/models/gemini-2.5-flash-lite:streamGenerateContent");
  const part = c.body.contents[0].parts.find((p: any) => p.inline_data).inline_data;
  expect(part.mime_type).toBe("audio/wav");
  const wav = Buffer.from(part.data, "base64");
  expect(wav.subarray(0, 4).toString()).toBe("RIFF"); expect(wav.readUInt32LE(24)).toBe(16000);
  expect(wav.length).toBeGreaterThan(16000 * 2 * 0.8); // at least ~0.8 s of audio incl. the lead-in
  expect(c.prompt).toContain("한국어와 영어가 섞여 있으면 들린 언어 그대로");
  expect(c.prompt).toMatch(/\[용어\] .*Formation/);
  expect(await app(page, "A.usage().stt.calls")).toBe(1);
  expect(await app(page, "A.usage().calls")).toBe(0); // not counted against the daily AI-call limit
  await expect(page.locator("#field .callout.t-term", { hasText: "Formation" })).toHaveCount(1); // instant keywords still work
});

test("조용함·웅웅거림은 보내지 않음 (비용 없음)", async ({ open, page }) => {
  const ai = await mockAI(page, () => "x");
  await open({ storage: { ...GEM, "ms.sttMode": "cloud" } });
  await page.click("#startBtn");
  await ev(page, "window.__mic.set({ hum: 1 })"); await page.waitForTimeout(2500); await ev(page, "window.__mic.set({ hum: 0 })"); await page.waitForTimeout(1200);
  expect(ai.calls.filter(isStt)).toHaveLength(0);
});

test("같이 쓰기: Safari 글자가 바로 보이고, Gemini 글자로 바뀜 (한 문장으로)", async ({ open, page }) => {
  await mockAI(page, (c) => (isStt(c) ? { text: "셀 라인 3호기 점검이 필요합니다", delayMs: 300 } : "[]"));
  await open({ storage: { ...GEM, "ms.sttMode": "hybrid" } });
  await startListening(page);
  await speak(page, 1600, "window.__say('쎌라인 삼호기 점검이'); window.__say('필요합니다')");
  expect(await transcript(page)).toBe("쎌라인 삼호기 점검이 | 필요합니다");
  await expect.poll(() => transcript(page), { timeout: 6000 }).toBe("셀 라인 3호기 점검이 필요합니다");
  expect(await app(page, "A.S.segs.filter(s => (s.fix ?? s.raw)).length")).toBe(1);
  expect(await app(page, "A.S.segs[0].raw")).toBe("쎌라인 삼호기 점검이");
});

test("같이 쓰기: Safari가 놓친 구간은 Gemini 글자로 채움", async ({ open, page }) => {
  await mockAI(page, (c) => (isStt(c) ? "놓칠 뻔한 문장입니다" : "[]"));
  await open({ storage: { ...GEM, "ms.sttMode": "hybrid" } });
  await startListening(page);
  await speak(page);
  await expect.poll(() => transcript(page), { timeout: 6000 }).toBe("놓칠 뻔한 문장입니다");
});

test("Safari와 Gemini가 같은 단어를 5번 다르게 들으면 용어 사전에 자동 등록 + 알림", async ({ open, page }) => {
  test.setTimeout(60000);
  const W = ["오전", "오후", "내일", "모레", "금요일"]; let n = 0;
  await mockAI(page, (c) => (isStt(c) ? `셀 라인 ${W[n++]} 점검합니다` : "[]"));
  await open({ storage: { ...GEM, "ms.sttMode": "hybrid", "ms.glossary": "SOH = State of Health" } });
  await startListening(page);
  for (let i = 1; i <= 5; i++) { // different sentences each time (Safari drops a sentence repeated word for word)
    await speak(page, 1400, `window.__say('쎌라인 ${W[i - 1]} 점검합니다')`);
    await expect.poll(() => app(page, "A.S.segs.filter(s => s.cloud).length"), { timeout: 6000 }).toBe(i);
    if (i === 4) expect(await ev(page, "localStorage.getItem('ms.glossary')")).toBe("SOH = State of Health");
  }
  await expect.poll(() => ev(page, "localStorage.getItem('ms.glossary')")).toBe("SOH = State of Health\n셀 라인 · 오인식: 쎌라인");
  await expect(page.locator("#field .callout", { hasText: "용어 사전에 자동 등록: 셀 라인" })).toHaveCount(1);
});

test("Gemini가 3번 연속 실패하면 사람 말로 알리고 Safari 인식으로 계속 들음", async ({ open, page }) => {
  await mockAI(page, (c) => (isStt(c) ? { status: 403, error: "API key not valid" } : "[]"));
  await open({ storage: { ...GEM, "ms.sttMode": "cloud" } });
  await page.click("#startBtn");
  for (let i = 0; i < 3; i++) { await speak(page, 1200); await page.waitForTimeout(900); }
  await expect(page.locator("#aiNote")).toContainText("Gemini 키가 맞지 않아요");
  await expect(page.locator("#aiNote")).toContainText("Safari 음성 인식으로 바꿔 계속 들어요");
  await expect.poll(() => ev(page, "!!window.__sr.live")).toBe(true);
});

test("설정: 엔진·키·모델 저장, 연결 확인, 키 없으면 Safari로", async ({ open, page }) => {
  const ai = await mockAI(page, () => "ok");
  await open({});
  await page.click("#tabSet");
  await page.selectOption("#sttMode", "cloud");
  await page.fill("#sttKey", "AIza-new"); await page.locator("#sttKey").dispatchEvent("change");
  await page.fill("#sttModel", "gemini-3.8-flash"); await page.locator("#sttModel").dispatchEvent("change");
  expect(await page.evaluate(() => [localStorage.getItem("ms.sttMode"), localStorage.getItem("ms.key.gemini"), localStorage.getItem("ms.sttModel")])).toEqual(["cloud", "AIza-new", "gemini-3.8-flash"]);
  await page.click("#sttTest");
  await expect(page.locator("#sttMsg")).toHaveText("연결 성공 · gemini-3.8-flash");
  expect(ai.calls.at(-1)!.url).toContain("/models/gemini-3.8-flash");
  // no key: Gemini mode cannot run, Safari recognition is used
  await page.fill("#sttKey", ""); await page.locator("#sttKey").dispatchEvent("change");
  await page.click("#tabLive"); await startListening(page);
});
