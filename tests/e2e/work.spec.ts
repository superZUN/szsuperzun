// 업무 tab: morning briefing, Jay에게 묻기 over every record, the weekly report, and voice commands ("제이, …").
import { test, expect, startListening, app } from "../harness/fixtures";
import { mockAI, type AICall } from "../harness/ai-mock";
import type { Page } from "@playwright/test";

const ev = (page: Page, js: string) => page.evaluate(js);
const real = (page: Page) => page.locator("#field .callout:not(.example):not(.gone)");
const md = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
const key = (t = Date.now()) => { const d = new Date(t), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const monday = (t = Date.now()) => { const d = new Date(t); const back = (d.getDay() + 6) % 7; return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime(); };
const task = (id: string, text: string, o: Partial<{ owner: string; due: string; done: boolean; doneAt: number; result: string }> = {}) => ({ id, text, owner: o.owner || "", due: o.due || "", result: o.result || "", from: "주간회의", done: !!o.done, doneAt: o.doneAt || 0, at: Date.now() - 3600e3, updatedAt: Date.now() });
const TASKS = JSON.stringify([
  task("a", "견적서 회신", { due: md(Date.now() - 864e5), owner: "나" }),
  task("b", "샘플 재측정", { due: md(Date.now() + 864e5 * 0.4), owner: "박지은" }),
  task("c", "Formation 수율 보고", { done: true, doneAt: Date.now() - 600e3, result: "96.5% 보고 완료" }),
]);
const isBrief = (c: AICall) => c.prompt.includes("아침 브리핑");
const isReport = (c: AICall) => c.prompt.includes("주간 업무보고");
const isAskAll = (c: AICall) => c.system.includes("업무 비서 Jay");

test("음성 명령 해석: 할 일(기한·담당), 메모(앞 문장), 질문, 그리고 '제이'로 시작하지 않으면 무시", async ({ open, page }) => {
  await open({});
  const r = await page.evaluate(async () => {
    const v = await import("/src/work/voice.ts"); const now = new Date(2026, 10, 18, 10); // Wednesday 11/18
    return {
      fri: v.extractDue("금요일까지 견적서 보내기", now), nextTue: v.extractDue("다음 주 화요일까지 보고", now), tom: v.extractDue("내일까지 회신", now),
      date: v.extractDue("11월 25일까지 샘플", now), slash: v.extractDue("12/1 까지 정리", now),
      t1: v.parseCommand("제이, 견적서 보내기 할 일에 추가해 줘"), t2: v.parseCommand("Jay 박지은 님이 샘플 재측정 추가해 줘"),
      m1: v.parseCommand("제이 샘플 수량 300개 메모해 둬"), m2: v.parseCommand("제이야 방금 거 메모해 줘", "고객사 단가는 작년 기준 유지"),
      q: v.parseCommand("제이, 오늘 할 일 뭐야?"), no: v.parseCommand("견적서 보내기 추가해 줘"), name: v.parseCommand("제이슨이 그러던데요"),
    };
  });
  expect(r.fri).toEqual({ due: "11/20", rest: "견적서 보내기" });
  expect(r.nextTue).toEqual({ due: "11/24", rest: "보고" });
  expect(r.tom.due).toBe("11/19"); expect(r.date.due).toBe("11/25"); expect(r.slash.due).toBe("12/1");
  expect(r.t1).toEqual({ kind: "task", text: "견적서 보내기", owner: "", due: "" });
  expect(r.t2).toEqual({ kind: "task", text: "샘플 재측정", owner: "박지은", due: "" });
  expect(r.m1).toEqual({ kind: "memo", text: "샘플 수량 300개" });
  expect(r.m2).toEqual({ kind: "memo", text: "고객사 단가는 작년 기준 유지" });
  expect(r.q).toEqual({ kind: "ask", q: "오늘 할 일 뭐야?" });
  expect(r.no).toBeNull(); expect(r.name).toBeNull();
});

test("말로 할 일·메모·질문: '제이, 금요일까지 …추가해 줘' → 할 일 탭, '방금 거 메모' → 메모, 질문은 할 일 목록을 보고 답", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isAskAll(c) ? "기한 지난 일은 견적서 회신 1건입니다. (근거: 할 일)" : "[]"));
  await open({ key: true, storage: { "ms.tasks": TASKS, "ms.fixOff": "1" } });
  await startListening(page);
  await ev(page, "window.__say('제이, 금요일까지 고객사 견적서 보내기 할 일에 추가해 줘')");
  await expect.poll(() => app(page, "A.tasks.filter(t => !t.deleted && t.text === '고객사 견적서 보내기').map(t => t.due)")).toHaveLength(1);
  const due = (await app(page, "A.tasks.find(t => t.text === '고객사 견적서 보내기').due")) as string; expect(due).toMatch(/^\d{1,2}\/\d{1,2}$/);
  await expect(real(page).filter({ hasText: "음성 명령으로 할 일에 추가됨" })).toHaveCount(1);
  await ev(page, "window.__say('고객사 단가는 작년 기준으로 유지합니다')");
  await ev(page, "window.__say('제이 방금 거 메모해 줘')");
  await expect.poll(() => app(page, "A.S.notes.map(n => n.text)")).toContain("고객사 단가는 작년 기준으로 유지합니다");
  await ev(page, "window.__say('제이, 기한 지난 할 일 뭐야?')");
  await expect(real(page).filter({ hasText: "견적서 회신 1건" })).toHaveCount(1, { timeout: 8000 });
  const c = ai.calls.find(isAskAll)!; expect(c.prompt).toContain("견적서 회신 / 담당 나"); expect(c.prompt).toContain("(지남)"); expect(c.prompt).toContain("[질문] 기한 지난 할 일 뭐야?");
});

test("음성 명령을 끄면 '제이,'로 시작해도 평범한 말", async ({ open, page }) => {
  await open({ storage: { "ms.voiceOff": "1" } });
  await startListening(page);
  await ev(page, "window.__say('제이, 견적서 보내기 할 일에 추가해 줘')");
  await page.waitForTimeout(500);
  expect(await app(page, "A.tasks.filter(t => !t.deleted).length")).toBe(0);
});

test("아침 브리핑: 처음 열면 하루 한 번 자동으로 — 기한 지남·오늘·내일 묶음 + AI 정리, 카드 누르면 업무 탭", async ({ open, page }) => {
  test.skip(new Date().getHours() < 5, "새벽 5시 전에는 만들지 않음");
  const ai = await mockAI(page, (c) => (isBrief(c) ? "## 오늘 꼭 챙길 것\n- 견적서 회신 (기한 지남)\n- 샘플 재측정 확인\n## 핵심\n- 없음" : "[]"));
  await open({ key: true, storage: { "ms.tasks": TASKS, "ms.briefOff": "" } });
  await expect(real(page).filter({ hasText: "오늘 브리핑" })).toHaveCount(1, { timeout: 12000 });
  expect(ai.calls.filter(isBrief)).toHaveLength(1);
  const c = ai.calls.find(isBrief)!; expect(c.prompt).toContain("견적서 회신"); expect(c.prompt).not.toContain("Formation 수율 보고"); // done tasks stay out
  await real(page).filter({ hasText: "오늘 브리핑" }).click();
  await page.getByRole("button", { name: "열어 보기" }).click();
  await expect(page.locator("#workView")).toBeVisible();
  await expect(page.locator("#briefTasks")).toContainText("기한 지남 1");
  await expect(page.locator("#briefTasks")).toContainText("오늘·내일 1");
  await expect(page.locator("#briefOut")).toContainText("샘플 재측정 확인");
  expect(await ev(page, `!!localStorage.getItem('ms.brief.${key()}')`)).toBe(true);
  await page.reload(); await expect(page.locator("html[data-docs='1']")).toHaveCount(1); await page.waitForTimeout(7000);
  expect(ai.calls.filter(isBrief)).toHaveLength(1); // once a day
});

test("Jay에게 묻기: 날짜를 말하면 그 기간 기록을, 할 일은 늘 함께 보고 답함", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isAskAll(c) ? "## 정리\n- 샘플 납기 11/20 확정 (근거: 대화 기록)" : "[]"));
  await open({ key: true, storage: { "ms.tasks": TASKS, "ms.fixOff": "1" } });
  await startListening(page);
  await ev(page, "window.__say('샘플 납기는 11월 20일로 확정합니다 고객사에도 그렇게 통보하겠습니다')");
  await page.click("#startBtn");
  await page.click("#tabWork");
  await page.fill("#workAsk", "오늘 회의에서 정한 거 정리해줘"); await page.press("#workAsk", "Enter");
  await expect(page.locator("#workAnswer")).toContainText("샘플 납기 11/20 확정");
  const c = ai.calls.find(isAskAll)!;
  expect(c.prompt).toContain("[기록 — 오늘]"); expect(c.prompt).toContain("샘플 납기는 11월 20일로 확정합니다");
  expect(c.prompt).toContain("Formation 수율 보고 / 완료: 96.5% 보고 완료");
  await page.getByRole("button", { name: "밀린 일" }).click();
  await expect(page.locator("#workAnswer .waq")).toHaveCount(2);
  expect(ai.calls.filter(isAskAll).at(-1)!.prompt).toContain("[질문] 기한 지난 할 일 정리해줘");
});

test("주간 업무보고: 금요일 오후엔 자동(한 번), '이번 주 보고서 쓰기'로 다시 — 회의록 탭 '주간 보고', 목록", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isReport(c) ? "# 주간 업무보고\n## 1. 이번 주 요약\n- Formation 수율 96.5% 보고 완료\n## 4. 완료한 일\n- Formation 수율 보고" : "[]"));
  await open({ key: true, storage: { "ms.tasks": TASKS, "ms.fixOff": "1" } });
  await page.click("#tabWork");
  await expect(page.locator("#wrOut")).toContainText("금요일 오후 3시");
  const id = `wr-${key(monday())}`;
  // automatic: this week's Friday 4 p.m. → made once, with a card
  const fri = Math.max(monday() + 4 * 864e5 + 16 * 3600e3, Date.now() + 1000); // Friday 4 p.m. — or now, when that has passed (tasks were done just now)
  await app(page, "(A.cfg.reportOn = true)");
  await app(page, `A.autoReport(${fri})`);
  await expect.poll(() => app(page, `A.S.docs.some(d => d.id === '${id}')`), { timeout: 8000 }).toBe(true);
  await expect(real(page).filter({ hasText: "주간 업무보고" })).toHaveCount(1);
  await app(page, `A.autoReport(${fri + 60000})`);
  expect(ai.calls.filter(isReport)).toHaveLength(1);
  const c = ai.calls.find(isReport)!; expect(c.prompt).toContain("[이번 주 끝낸 할 일]\n- Formation 수율 보고");
  await expect(page.locator("#wrOut")).toContainText("Formation 수율 96.5% 보고 완료");
  // by hand: written again over the same week
  await page.click("#wrMake");
  await expect.poll(() => ai.calls.filter(isReport).length).toBe(2);
  expect(await app(page, `A.S.docs.filter(d => d.id === '${id}').map(d => d.name)`)).toEqual([expect.stringMatching(/^주간 업무보고 \d+\/\d+–\d+\/\d+$/)]);
  await expect(page.locator("#wrSel option")).toHaveCount(1);
  await page.click("#tabKb"); await expect(page.locator("#docList")).toContainText("주간 보고");
});
