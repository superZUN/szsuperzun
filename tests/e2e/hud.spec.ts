// Step 5: HUD cards, gestures, the instant keyword layer (no AI), keyword detail.
import { test, expect, startListening, app } from "../harness/fixtures";
import { mockWiki } from "../harness/ai-mock";
import type { Page } from "@playwright/test";

const ev = (page: Page, js: string) => page.evaluate(js);
const live = (page: Page) => page.locator("#field .callout:not(.gone):not(.flung)");
async function addCards(page: Page, n: number) {
  await page.evaluate((n) => { for (let i = 0; i < n; i++) (window as any).__testAdd?.(i); }, n);
}
/** make n real cards through memos (no AI needed) */
async function memos(page: Page, n: number, prefix = "메모") {
  for (let i = 0; i < n; i++) { await page.fill("#memoInput", `${prefix} ${i + 1}`); await page.press("#memoInput", "Enter"); }
}
async function settled(page: Page, sel = "#field .callout.lead") {
  const loc = page.locator(sel); await expect(loc).toBeVisible();
  let prev = ""; for (let i = 0; i < 40; i++) { const b = JSON.stringify(await loc.boundingBox()); if (b === prev) break; prev = b; await page.waitForTimeout(60); }
  return (await loc.boundingBox())!;
}

test.describe("즉시 키워드 레이어", () => {
  test("사전 용어는 AI 없이 0.3초 안에 DEF 카드 + KEYWORDS 바", async ({ open, page }) => {
    await open({});
    await startListening(page);
    const ms = await page.evaluate(() => new Promise<number>((res) => {
      const t0 = performance.now();
      const ob = new MutationObserver(() => { if (document.querySelector("#field .callout.t-term")) { ob.disconnect(); res(performance.now() - t0); } });
      ob.observe(document.getElementById("field")!, { childList: true });
      (window as any).__say("오늘 Formation 라인 수율을 봅시다");
    }));
    expect(ms).toBeLessThan(300);
    await expect(page.locator("#field .callout.t-term")).toContainText("Formation");
    const chip = page.locator("#kwList .kw", { hasText: "Formation" });
    await expect(chip).toHaveCount(1);
    await expect(chip.locator(".kt")).toHaveText("DEF");
    // the same keyword again: no second DEF card, the bar counts it
    await ev(page, "window.__say('Formation 다시 확인')");
    await expect(page.locator("#field .callout.t-term")).toHaveCount(1);
    await expect(chip.locator(".kt")).toHaveText("DEF ×2");
  });

  test("말하는 중(interim)에도 키워드가 뜸, 너무 흔한 용어(전압·용량)는 제외", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await ev(page, "window.__interim('전압이랑 용량은 괜찮고 리튬 석출이')");
    await expect(page.locator("#kwList .kw")).toHaveCount(1);
    await expect(page.locator("#kwList")).toContainText("석출");
    await expect(page.locator("#kwList")).not.toContainText("전압");
  });

  test("지난 회의록 강한 일치 → RECALL 카드, 같은 문장은 15분에 한 번", async ({ open, page }) => {
    await open({ idbDocs: [
      { id: "9-m", name: "10/14 고객사 주간회의 (회의록)", text: "# 회의록\n- 고객사 샘플 납기는 11월 12일까지 1차 샘플 전달로 합의했다.\n- 다음 회의는 11월 4일.", added: Date.now() - 864e5 },
      { id: "8-m", name: "설비 점검", text: "충방전기 채널 교정 일정과 온도 센서 교체 계획을 정리했다.", added: Date.now() - 2 * 864e5 },
      { id: "7-m", name: "품질 회의", text: "IR 불량 원인은 탭 용접 저항으로 추정되며 재측정 후 보고하기로 했다.", added: Date.now() - 3 * 864e5 },
      { id: "6-m", name: "인사 공지", text: "연말 휴가 신청은 다음 달 말까지 시스템에 등록한다.", added: Date.now() - 4 * 864e5 },
    ] });
    await startListening(page);
    await ev(page, "window.__say('고객사 샘플 납기 1차 전달 날짜가 언제였죠')");
    await expect(page.locator("#field .callout.t-past:not(.example)")).toHaveCount(1);
    await expect(page.locator("#field .callout.t-past:not(.example)")).toContainText("11월 12일");
    await ev(page, "window.__say('고객사 샘플 납기 1차 전달 날짜')");
    await page.waitForTimeout(300);
    await expect(page.locator("#field .callout.t-past:not(.example)")).toHaveCount(1);
  });

  test("키워드 상세: 정의·나온 대목·버튼, 위키백과는 제목이 맞을 때만", async ({ open, page }) => {
    const wiki = await mockWiki(page, { ko: { "포메이션": { title: "엉뚱한 문서", extract: "관계없는 내용" } } });
    await open({});
    await startListening(page);
    await ev(page, "window.__say('SEI 막이 두꺼워졌어요')");
    await page.locator("#kwList .kw").first().click();
    await expect(page.locator("#focusCard")).toContainText("DEF · 용어 사전");
    await expect(page.locator("#focusCard")).toContainText("Solid Electrolyte Interphase");
    await expect(page.locator("#focusCard")).toContainText("CONTEXT · 나온 대목");
    await expect(page.getByRole("button", { name: "사진 찾기" })).toBeVisible();
    await page.getByRole("button", { name: "위키백과" }).click();
    await expect(page.getByRole("button", { name: "위키백과에 없음" })).toBeVisible();
    expect(wiki.hits.length).toBeGreaterThan(0);
  });

  test("일상 대화에서는 평범한 말에 사전 카드를 붙이지 않음", async ({ open, page }) => {
    await open({ storage: { "ms.appMode": "conv" } });
    await startListening(page);
    await ev(page, "window.__say('어제 활성화 된 앱이 있어서 충전을 했어')");
    await page.waitForTimeout(300);
    await expect(page.locator("#field .callout.t-term")).toHaveCount(0);
  });
});

test.describe("카드와 손동작", () => {
  test("넓은 화면은 좌우 2열 최대 6장, 3번째부터 축소, 새 카드는 빈 쪽 열", async ({ open, page }) => {
    await open({});
    await memos(page, 8);
    await expect(live(page)).toHaveCount(6);
    await expect(page.locator("#field .callout.compact:not(.gone)")).toHaveCount(4);
    await page.waitForTimeout(800);
    const xs = await live(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left));
    const left = xs.filter((x) => x < 400).length, right = xs.filter((x) => x > 700).length;
    expect([left, right]).toEqual([3, 3]);
    expect(await app(page, "A.S.history.length")).toBe(8); // the log keeps all
  });

  test("좁은 화면은 위아래 최대 4장", async ({ open, page }) => {
    await page.setViewportSize({ width: 420, height: 860 });
    await open({});
    await memos(page, 6);
    await expect(live(page)).toHaveCount(4);
  });

  test("한 번 탭 = 크게 보기 (0.3초 뒤), 두 번 탭 = 고정, 다시 두 번 탭 = 해제", async ({ open, page }) => {
    await open({});
    await memos(page, 1, "탭 시험");
    const b = await settled(page);
    await page.mouse.click(b.x + 40, b.y + 20);
    await expect(page.locator("#focusVeil")).toBeVisible();
    await expect(page.locator("#focusCard")).toContainText("탭 시험 1");
    await page.getByRole("button", { name: "닫기" }).click();
    await page.mouse.click(b.x + 40, b.y + 20); await page.waitForTimeout(80); await page.mouse.click(b.x + 40, b.y + 20);
    await expect(page.locator("#field .callout.pinned")).toHaveCount(1);
    await page.waitForTimeout(400); await expect(page.locator("#focusVeil")).toBeHidden(); // a double tap does not also open
    await page.mouse.click(b.x + 40, b.y + 20); await page.waitForTimeout(80); await page.mouse.click(b.x + 40, b.y + 20);
    await expect(page.locator("#field .callout.pinned")).toHaveCount(0);
  });

  test("끌기 = 따라오다 놓으면 제자리로, 고정된 카드는 옮긴 자리에 남음 + 상세에서 '고정 해제'", async ({ open, page }) => {
    await open({});
    await memos(page, 1, "끌기");
    const b = await settled(page);
    await page.mouse.move(b.x + 40, b.y + 20); await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(b.x + 40 + i * 20, b.y + 20 + i * 15); await page.waitForTimeout(16); }
    const mid = (await page.locator("#field .callout.lead").boundingBox())!;
    expect(mid.x).toBeGreaterThan(b.x + 150);
    await page.waitForTimeout(150); await page.mouse.up(); // the finger stopped before lifting: not a throw
    const back = await settled(page);
    expect(Math.abs(back.x - b.x)).toBeLessThan(4);
    // pin, then drag: it stays where it was put
    await page.mouse.click(b.x + 40, b.y + 20); await page.waitForTimeout(80); await page.mouse.click(b.x + 40, b.y + 20);
    await page.mouse.move(b.x + 40, b.y + 20); await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(b.x + 40 + i * 25, b.y + 20 + i * 10); await page.waitForTimeout(16); }
    await page.waitForTimeout(150); await page.mouse.up();
    const moved = await settled(page, "#field .callout.pinned");
    expect(moved.x).toBeGreaterThan(b.x + 200);
    await page.mouse.click(moved.x + 40, moved.y + 20);
    await page.getByRole("button", { name: "고정 해제" }).click();
    await expect(page.locator("#field .callout.pinned")).toHaveCount(0);
  });

  test("던지기 = 날아가 사라지고 화면에 없던 가장 최근 카드가 들어옴 (기록에는 남음)", async ({ open, page }) => {
    await open({});
    await memos(page, 7, "던지기");
    await expect(live(page)).toHaveCount(6);
    const b = await settled(page);
    await page.mouse.move(b.x + 40, b.y + 20); await page.mouse.down();
    for (let i = 1; i <= 4; i++) { await page.mouse.move(b.x + 40 + i * 40, b.y + 20, { steps: 1 }); await page.waitForTimeout(8); } // thrown towards the middle (stays on screen)
    await page.mouse.up();
    await expect(page.locator("#field .callout.flung")).toHaveCount(0, { timeout: 2000 });
    await expect(live(page)).toHaveCount(6);
    await expect(live(page).filter({ hasText: "던지기 7" })).toHaveCount(0);
    await expect(live(page).filter({ hasText: "던지기 1" })).toHaveCount(1); // the oldest came back in
    expect(await app(page, "A.S.history.length")).toBe(7);
    expect(await app(page, "A.S.history.find(d => d.body === '던지기 7').dismissed")).toBe(true);
  });

  test("중요 표시: 흰 충격파, 카드, 30초 앞뒤 기록", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await ev(page, "window.__say('납기를 11월 20일로 확정합니다')");
    await page.click("#markNow");
    await expect(page.locator("#markCount")).toHaveText("1");
    await expect(page.locator("#field .callout.t-mark")).toContainText("앞: 납기를 11월 20일로 확정합니다");
    expect(await app(page, "performance.now() - A.S.markFlash < 2000")).toBe(true);
  });

  test("카드 제목 디코드는 260ms 안에 끝남, 예시 카드는 실제 카드가 오면 사라짐", async ({ open, page }) => {
    await open({});
    await expect(page.locator("#field .callout.example")).toHaveCount(3, { timeout: 3000 });
    await memos(page, 1, "실제");
    await expect(page.locator("#field .callout.example:not(.gone)")).toHaveCount(0);
    await ev(page, "window.__say && 0");
    await page.click("#tabSet"); await page.click("#tabLive");
    await page.evaluate(() => { const i = document.getElementById("memoInput") as HTMLInputElement; i.value = "제목 확인"; });
    await page.click("#modeAct"); await page.fill("#actInput", "샘플 재측정 / 박지은 / 11/20"); await page.press("#actInput", "Enter");
    const card = page.locator("#field .callout.t-action").first();
    await page.waitForTimeout(320);
    await expect(card.locator(".title")).toHaveText("샘플 재측정");
  });
});
