// Weekly mind map: on Monday from 6 a.m. (or later that week), last Monday–Sunday is mapped once, kept in the archive,
// announced with a card, shown in the mind map tab; synced as a document.
import { test, expect, app } from "../harness/fixtures";
import { mockAI, type AICall } from "../harness/ai-mock";

const isMind = (c: AICall) => c.prompt.includes("마인드맵으로 정리하세요");
const isSum = (c: AICall) => c.prompt.includes("하루 요약");
const TREE = { title: "지난주 — 샘플 납기와 IR 불량", children: [{ t: "고객사 샘플", n: "납기 11/20 확정", c: [{ t: "추가 샘플 50셀" }] }, { t: "IR 불량", c: [{ t: "탭 용접 저항" }] }] };
// Monday 16 Nov 2026; last week = 9–15 Nov
const MON_9 = new Date(2026, 10, 16, 9, 0), MON_5 = new Date(2026, 10, 16, 5, 0);
const DOCS = [
  { id: "day-2026-11-10-dev", name: "2026-11-10 대화 기록", text: "# x\n[10:00:00] (회의) 고객사 샘플 납기는 11월 20일로 확정했습니다\n[11:00:00] (업무) IR 불량은 탭 용접 저항이 원인으로 보입니다\n", added: new Date(2026, 10, 10).getTime() },
  { id: "day-2026-11-16-dev", name: "2026-11-16 대화 기록", text: "# x\n[08:00:00] (일상) 이번 주 월요일 아침 이야기는 지난주 맵에 들어가면 안 됩니다\n", added: new Date(2026, 10, 16).getTime() },
  { id: "day-2026-11-02-dev", name: "2026-11-02 대화 기록", text: "# x\n[08:00:00] (일상) 지지난주 이야기도 빠져야 합니다 아주 오래전 이야기\n", added: new Date(2026, 10, 2).getTime() },
];

test("월요일 아침: 지난주(월~일)만 모아 한 번 만들고, 카드 → '마인드맵 보기', 보관함·회의록 탭에 남음", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isMind(c) ? JSON.stringify(TREE) : isSum(c) ? "# 요약\n- 짧음\n⟦용어⟧ {\"terms\":[]}" : "[]"));
  await page.clock.install({ time: MON_9 });
  await open({ key: true, idbDocs: DOCS });
  await page.clock.runFor(6000);
  await expect.poll(() => ai.calls.filter(isMind).length).toBe(1);
  const p = ai.calls.find(isMind)!.prompt;
  expect(p).toContain("지난주(11/9–11/15)");
  expect(p).toContain("고객사 샘플 납기는 11월 20일로 확정");
  expect(p).not.toContain("월요일 아침 이야기"); expect(p).not.toContain("지지난주");
  const card = page.locator("#field .callout.t-info", { hasText: "지난주 마인드맵 · 11/9–11/15" });
  await expect(card).toContainText("고객사 샘플 · IR 불량");
  await card.click();
  await page.getByRole("button", { name: "마인드맵 보기", exact: true }).click();
  await expect(page.locator("#mindView")).toBeVisible();
  await expect(page.locator("#mmMeta")).toContainText("주간 마인드맵 11/9–11/15");
  await expect(page.locator("#mmSvg text", { hasText: "지난주 — 샘플 납기와 IR 불량" })).toHaveCount(1);
  await expect(page.locator("#mmWeek option")).toHaveText(["주간 보관함 (1)", "주간 11/9–11/15"]);
  await page.click("#tabKb");
  await expect(page.locator("#docList .doc", { hasText: "주간 마인드맵 11/9–11/15" }).locator(".dkind")).toHaveText("마인드맵");
  // later checks the same week do nothing
  await page.clock.fastForward(11 * 60000);
  expect(ai.calls.filter(isMind)).toHaveLength(1);
});

test("월요일 6시 전에는 기다렸다가 6시가 지나면 만듦; 탭을 처음 열면 새 주간 맵을 보여 줌", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isMind(c) ? JSON.stringify(TREE) : isSum(c) ? "# 요약\n- 짧음\n⟦용어⟧ {\"terms\":[]}" : "[]"));
  await page.clock.install({ time: MON_5 });
  await open({ key: true, idbDocs: DOCS });
  await page.clock.runFor(6000);
  expect(ai.calls.filter(isMind)).toHaveLength(0);
  await page.clock.fastForward(61 * 60000); // jump past 6 a.m. (the 10-minute check fires)
  await expect.poll(() => ai.calls.filter(isMind).length).toBe(1);
  await page.click("#tabMind");
  await expect(page.locator("#mmMeta")).toContainText("주간 마인드맵 11/9–11/15");
  expect(await page.evaluate(() => localStorage.getItem("ms.mm.unseen"))).toBeNull();
  // switching to a period leaves the archive view
  await page.click("#mindView [data-range='30']");
  await expect(page.locator("#mmEmpty")).toBeVisible();
  await page.selectOption("#mmWeek", "mm-2026-11-09");
  await expect(page.locator("#mmMeta")).toContainText("주간 마인드맵 11/9–11/15");
});

test("지난주에 기록이 없으면 AI를 부르지 않고 카드도 없음", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isMind(c) ? JSON.stringify(TREE) : isSum(c) ? "# 요약\n- 짧음\n⟦용어⟧ {\"terms\":[]}" : "[]"));
  await page.clock.install({ time: MON_9 });
  await open({ key: true, idbDocs: [DOCS[1], DOCS[2]] });
  await page.clock.runFor(6000); await page.waitForTimeout(300);
  expect(ai.calls.filter(isMind)).toHaveLength(0);
  await expect(page.locator("#field .callout", { hasText: "지난주 마인드맵" })).toHaveCount(0);
});

test("다른 기기가 이미 만든 주(문서가 있음)는 다시 만들지 않고, 개요에서 맵을 복원해 보여 줌", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isMind(c) ? JSON.stringify(TREE) : isSum(c) ? "# 요약\n- 짧음\n⟦용어⟧ {\"terms\":[]}" : "[]"));
  await page.clock.install({ time: MON_9 });
  await open({ key: true, idbDocs: [...DOCS, { id: "mm-2026-11-09", name: "주간 마인드맵 11/9–11/15", text: "# 다른 기기에서 만든 맵\n- 고객사 샘플 — 납기 11/20\n  - 추가 샘플\n- IR 불량\n", added: new Date(2026, 10, 16).getTime(), synced: true }] });
  await page.clock.runFor(6000); await page.waitForTimeout(300);
  expect(ai.calls.filter(isMind)).toHaveLength(0);
  await page.click("#tabMind"); await page.selectOption("#mmWeek", "mm-2026-11-09");
  await expect(page.locator("#mmSvg text", { hasText: "다른 기기에서 만든 맵" })).toHaveCount(1);
  await expect(page.locator("#mmSvg g.mmnode[data-id]")).toHaveCount(4);
});

test("요일 계산: 일요일 밤은 그 주의 월요일이 시작", async ({ open, page }) => {
  await open({});
  const mod = await page.evaluate(async () => { const m = await import("/src/mindmap/mindmap.ts"); const sun = new Date(2026, 10, 15, 23, 0).getTime(); const d = new Date(m.weekStart(sun)); return [d.getMonth() + 1, d.getDate(), d.getHours(), m.weekLabel("mm-2026-11-09")]; });
  expect(mod).toEqual([11, 9, 0, "11/9–11/15"]);
  expect(await app(page, "typeof A.weeklyMindmap")).toBe("function");
});
