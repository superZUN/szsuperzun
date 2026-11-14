// Step 10: cost — calls per minute of continuous speech by pace, prompt caching layout, daily limit, usage panel.
import { test, expect, app, startListening } from "../harness/fixtures";
import { mockAI, type AICall } from "../harness/ai-mock";
import type { Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";

const isAnalysis = (c: AICall) => c.system.includes("짧은 메시지로 던진다");
const isFix = (c: AICall) => c.system.includes("받아쓰기 교정기");
const SENTENCES = [
  "이번 주 Formation 라인 수율이 지난주보다 조금 떨어졌습니다", "원인은 IR 불량이 늘어난 것으로 보고 있습니다", "탭 용접 저항을 다시 측정해 봐야 할 것 같아요",
  "고객사 샘플 납기는 다음 주 금요일로 확정했습니다", "박지은 님이 재측정 결과를 정리해 주시기로 했고요", "충방전기 채널 교정도 같이 진행하겠습니다",
  "에이징 시간을 늘리면 OCV 편차가 줄어드는지 확인합시다", "다음 회의 때 데이터를 같이 보면 좋겠습니다",
];
/** one minute of someone talking: words appear every 300 ms, each sentence ends after ~4 s, short pauses between */
async function talkOneMinute(page: Page) {
  let t = 0, si = 0;
  while (t < 60000) {
    const s = SENTENCES[si++ % SENTENCES.length]; const words = s.split(" ");
    for (let k = 1; k <= words.length; k++) { await page.evaluate((x) => (window as any).__interim(x), words.slice(0, k).join(" ")); await page.clock.runFor(300); t += 300; await page.waitForTimeout(5); }
    await page.evaluate((x) => (window as any).__say(x), s); await page.clock.runFor(500); t += 500; await page.waitForTimeout(5);
  }
}
const results: Record<string, { analysis: number; fix: number; promptChars: number }> = {};

for (const pace of ["fast", "balanced", "save"] as const) {
  test(`1분 연속 발화 — ${pace}`, async ({ open, page }) => {
    test.setTimeout(120000);
    const ai = await mockAI(page, (c) => (isAnalysis(c) ? '[{"type":"kw","title":"수율"}]' : isFix(c) ? JSON.stringify(c.prompt.split("[교정할 문장]\n")[1].split("\n").map((l) => l.replace(/^\d+\.\s*/, ""))) : "[]"));
    await page.clock.install();
    await open({ key: true, storage: pace === "balanced" ? {} : { "ms.pace": pace } });
    await page.locator("#startBtn").dispatchEvent("click"); await page.clock.runFor(200);
    await talkOneMinute(page);
    const a = ai.calls.filter(isAnalysis), f = ai.calls.filter(isFix);
    results[pace] = { analysis: a.length, fix: f.length, promptChars: Math.round(a.reduce((s, c) => s + c.prompt.length, 0) / Math.max(1, a.length)) };
    console.log(pace, JSON.stringify(results[pace]));
    if (pace === "fast") expect(a.length).toBeGreaterThan(20);
    if (pace === "balanced") { expect(a.length).toBeLessThanOrEqual(21); expect(a.length).toBeGreaterThanOrEqual(8); expect(f.length).toBeLessThanOrEqual(7); }
    if (pace === "save") { expect(a.length).toBeLessThanOrEqual(11); expect(f.length).toBeLessThanOrEqual(4); }
    mkdirSync("test-results", { recursive: true });
    writeFileSync(`test-results/cost-${pace}.json`, JSON.stringify(results[pace]));
  });
}

test("캐시: 분석 요청의 고정 앞부분(system)은 매번 글자 하나 다르지 않음", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isAnalysis(c) ? '[{"type":"kw","title":"수율"}]' : "[]"));
  await open({ key: true, storage: { "ms.pace": "fast", "ms.fixOff": "1" } });
  await startListening(page);
  await page.evaluate(() => (window as any).__say("Formation 라인 수율이 지난주보다 조금 떨어졌습니다 원인을 봅시다"));
  await expect.poll(() => ai.calls.filter(isAnalysis).length).toBe(1);
  await page.waitForTimeout(1200);
  await page.evaluate(() => (window as any).__say("탭 용접 저항을 다시 측정해 봐야 할 것 같아요 박지은 님이 맡아 주세요"));
  await expect.poll(() => ai.calls.filter(isAnalysis).length).toBe(2);
  const [a, b] = ai.calls.filter(isAnalysis);
  expect(a.system).toBe(b.system);
  expect(a.prompt).not.toBe(b.prompt);
  expect(a.system.length).toBeGreaterThan(2000); // well above the 512-token cache minimum of Haiku/Sonnet 5.5
});

test("하루 한도: 넘으면 자동 절약 모드 + 알림 카드 + 키워드 자동 웹 검색 끔", async ({ open, page }) => {
  await mockAI(page, () => "연결됨");
  await open({ key: true, storage: { "ms.dailyLimit": "2", "ms.webMode": "always" } });
  await page.click("#tabSet");
  await page.click("#testKey"); await expect(page.locator("#keyMsg")).toContainText("연결 성공");
  expect(await app(page, "A.usage().calls")).toBe(1);
  await page.click("#testKey"); await expect.poll(() => app(page, "A.usage().calls")).toBe(2);
  await page.click("#tabLive");
  await expect(page.locator("#field .callout.t-risk", { hasText: "오늘 AI 사용 한도 도달" })).toHaveCount(1);
  await page.click("#tabSet");
  await expect(page.locator("#usageBox")).toContainText("오늘 AI 호출 2회 / 한도 2");
  await expect(page.locator("#usageBox")).toContainText("하루 한도를 넘어 자동 절약 중");
  expect(await app(page, "A.cfg.pace")).toBe("balanced"); // the user's own setting is kept; only the effective pace changes
});

test("비용 설정은 저장되고, 일상 대화 교정은 기본 끔·켜면 교정", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isFix(c) ? JSON.stringify(c.prompt.split("[교정할 문장]\n")[1].split("\n").map((l) => l.replace(/^\d+\.\s*/, ""))) : "[]"));
  await open({ key: true, storage: { "ms.appMode": "conv" } });
  await page.click("#tabSet");
  await page.selectOption("#pace", "save"); await page.fill("#dailyLimit", "1500"); await page.locator("#dailyLimit").dispatchEvent("change");
  expect(await page.evaluate(() => [localStorage.getItem("ms.pace"), localStorage.getItem("ms.dailyLimit")])).toEqual(["save", "1500"]);
  await page.check("#fixDaily");
  await page.click("#tabLive"); await startListening(page);
  for (let i = 1; i <= 4; i++) await page.evaluate((i) => (window as any).__say(`${i}번째 일상 이야기예요`), i);
  await expect.poll(() => ai.calls.filter(isFix).length, { timeout: 25000 }).toBe(1); // save: 6 sentences or 20 s
});
