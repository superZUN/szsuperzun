// Daily memory: the all-day conversation log, the day summary, term learning, AI-found actions as suggestions,
// and merging similar tasks.
import { test, expect, startListening, app, FAKES } from "../harness/fixtures";
import { mockAI, type AICall } from "../harness/ai-mock";
import type { Browser, Page } from "@playwright/test";

const ev = (page: Page, js: string) => page.evaluate(js);
const today = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const yesterday = () => { const d = new Date(Date.now() - 864e5), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const daylog = (page: Page) => app(page, `(A.flushLog(true), (A.S.docs.find(d => d.id.startsWith("day-${today()}-")) || {}).text || "")`) as Promise<string>;
const isSum = (c: AICall) => c.prompt.includes("하루 요약");
async function device(browser: Browser, ns: string, storage: Record<string, string>) {
  const ctx = await browser.newContext({ baseURL: "http://localhost:5173" }); const p = await ctx.newPage();
  await p.addInitScript({ path: FAKES }); await p.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort("failed"));
  await p.route("**/api/**", (r) => r.continue({ headers: { ...r.request().headers(), "x-test-ns": ns } }));
  await p.addInitScript((s) => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v as string); sessionStorage.setItem("__seeded", "1"); } }, storage);
  await p.goto("/"); await expect(p.locator("html[data-docs='1']")).toHaveCount(1); return p;
}

test.describe("하루 대화 기록", () => {
  test("모든 말·메모·★·모드가 날짜별 기록에 쌓이고, '새 회의'로 비워도 남음", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await ev(page, "window.__say('샘플 납기는 11월 20일로 확정합니다')");
    await page.fill("#memoInput", "고객사 통보 필요"); await page.press("#memoInput", "Enter");
    await page.click("#markNow");
    await page.click("#modeConv");
    await ev(page, "window.__say('점심은 김치찌개 어때요')");
    await page.click("#startBtn");
    await page.click("#tabPrep"); await page.click("#newMeeting"); await page.click("#newMeeting");
    expect(await app(page, "A.S.segs.length")).toBe(0);
    const log = await daylog(page);
    expect(log).toMatch(/\[\d\d:\d\d:\d\d\] \(회의\) 샘플 납기는 11월 20일로 확정합니다/);
    expect(log).toContain("(메모) 고객사 통보 필요");
    expect(log).toContain("(메모) ★ 중요 표시");
    expect(log).toContain("(일상) 점심은 김치찌개 어때요");
    await page.click("#tabKb");
    await expect(page.locator("#docList .doc", { hasText: `${today()} 대화 기록` }).locator(".dkind")).toHaveText("대화 기록");
  });

  test("교정이 끝난 문장으로 기록 (교정을 기다림)", async ({ open, page }) => {
    await mockAI(page, (c) => (c.system.includes("받아쓰기 교정기") ? JSON.stringify(c.prompt.split("[교정할 문장]\n")[1].split("\n").map((l) => l.replace(/^\d+\.\s*/, "").replace("팔십 프로", "80%"))) : "[]"));
    await open({ key: true, storage: { "ms.pace": "fast" } });
    await startListening(page);
    await ev(page, "window.__say('수율이 팔십 프로입니다')"); await ev(page, "window.__say('다음 주에 다시 봅시다')");
    await expect.poll(() => app(page, "A.S.segs.every(s => s.fix != null)")).toBe(true);
    expect(await daylog(page)).toContain("수율이 80%입니다");
  });

  test("방금 한 말이 오늘 기록과 겹쳐 RECALL 카드로 되돌아오지 않음", async ({ open, page }) => {
    await open({});
    await startListening(page);
    await ev(page, "window.__say('고객사 샘플 납기 1차 전달 날짜는 11월 12일입니다')");
    await daylog(page);
    await ev(page, "window.__say('고객사 샘플 납기 1차 전달 날짜')");
    await page.waitForTimeout(300);
    await expect(page.locator("#field .callout.t-past:not(.example)")).toHaveCount(0);
  });

  test("질문하면 오늘 앞서 한 대화(새 회의로 비운 뒤에도)를 근거로 씀, 질문과 답도 기록", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (c.prompt.includes("[질문]") ? "[보기] 없음\n11월 20일입니다." : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off", "ms.fixOff": "1" } });
    await startListening(page);
    await ev(page, "window.__say('고객사 샘플 납기는 11월 20일로 확정했습니다')");
    await page.click("#startBtn"); await daylog(page);
    await page.click("#tabPrep"); await page.click("#newMeeting"); await page.click("#newMeeting"); await page.click("#tabLive");
    await page.click("#modeAsk"); await page.fill("#askInput", "고객사 샘플 납기 언제로 확정했지"); await page.press("#askInput", "Enter");
    await expect.poll(() => ai.calls.length).toBeGreaterThan(0);
    const c = ai.calls.find((x) => x.prompt.includes("[질문]"))!;
    expect(c.prompt).toContain(`<<${today()} 대화 기록>>`);
    await expect.poll(() => daylog(page)).toContain("(답) 11월 20일입니다.");
    expect(await daylog(page)).toContain("(질문) 고객사 샘플 납기 언제로 확정했지");
  });

  test("서버에도 올라가고, 다른 기기는 더 쌓인 기록을 받아옴", async ({ open, page, browser, ns }) => {
    await open({ storage: { "ms.passcode": "test-pass" } });
    await startListening(page);
    await ev(page, "window.__say('첫 번째 기기에서 한 말입니다')");
    await daylog(page);
    const b = await device(browser, ns, { "ms.passcode": "test-pass" });
    await b.click("#tabKb"); await expect(b.locator("#docList .doc", { hasText: `${today()} 대화 기록` })).toContainText("☁");
    await ev(page, "window.__say('조금 뒤에 한 말입니다')");
    await expect.poll(() => daylog(page)).toContain("조금 뒤에 한 말입니다");
    await page.waitForTimeout(300);
    await b.click("#syncDocs");
    await expect.poll(() => b.evaluate(() => (window as any).__app.S.docs.find((d: any) => d.id.startsWith("day-"))?.text || "")).toContain("조금 뒤에 한 말입니다");
    await b.context().close();
  });

  test("설정에서 끄면 기록하지 않음", async ({ open, page }) => {
    await open({ storage: { "ms.dayLogOff": "1" } });
    await startListening(page);
    await ev(page, "window.__say('기록하지 말아야 할 말')");
    expect(await daylog(page)).toBe("");
  });
});

test.describe("하루 요약과 용어 학습", () => {
  test("지난 날 기록이 있으면 자동 요약 → 하루 요약 문서 + 알림 카드 + 용어 제안 → 등록", async ({ open, page }) => {
    const y = yesterday();
    const ai = await mockAI(page, (c) => (isSum(c) ? `# ${y} 하루 요약\n## 한 줄 요약\n- 샘플 납기를 11/20으로 확정한 날\n## 업무 — 결정·약속·숫자 (시각 포함)\n- 10:00 납기 확정\n⟦용어⟧ {"terms":[{"term":"셀 라인 3호기","note":"우리 공장 Formation 3번 라인","wrong":["쎌라인 삼호기"]}]}` : "[]"));
    await open({ key: true, idbDocs: [{ id: `day-${y}-dev1`, name: `${y} 대화 기록`, text: `# ${y} 대화 기록\n[10:00:00] (회의) 샘플 납기는 11월 20일로 확정합니다\n[10:01:00] (회의) 쎌라인 삼호기 점검도 같이 합시다\n`, added: Date.now() - 864e5 }] });
    await expect.poll(() => app(page, `!!A.S.docs.find(d => d.id === "sum-${y}")`), { timeout: 8000 }).toBe(true);
    expect(ai.calls.filter(isSum)).toHaveLength(1);
    expect(ai.calls.find(isSum)!.prompt).toContain("[10:01:00] (회의) 쎌라인 삼호기 점검도 같이 합시다");
    await expect(page.locator("#field .callout.t-info", { hasText: `${y} 하루 요약` })).toContainText("샘플 납기를 11/20으로 확정한 날");
    expect(await app(page, `A.S.docs.find(d => d.id === "sum-${y}").text.includes("⟦용어⟧")`)).toBe(false);
    await page.click("#tabSet");
    const row = page.locator("#learnBox .lrow", { hasText: "셀 라인 3호기" });
    await expect(row).toContainText("오인식: 쎌라인 삼호기");
    await row.getByRole("button", { name: "등록" }).click();
    await expect.poll(() => ev(page, "localStorage.getItem('ms.glossary')")).toBe("셀 라인 3호기 = 우리 공장 Formation 3번 라인 · 오인식: 쎌라인 삼호기");
    await expect(page.locator("#learnBox .lrow", { hasText: "셀 라인 3호기" })).toHaveCount(0);
    // already summarised: not again after a reload
    await page.reload(); await expect(page.locator("html[data-docs='1']")).toHaveCount(1); await page.waitForTimeout(3500);
    expect(ai.calls.filter(isSum)).toHaveLength(1);
  });

  test("'오늘 요약 만들기'로 오늘 것도 바로", async ({ open, page }) => {
    await mockAI(page, (c) => (isSum(c) ? "# 오늘 요약\n## 한 줄 요약\n- 테스트\n⟦용어⟧ {\"terms\":[]}" : "[]"));
    await open({ key: true });
    await startListening(page);
    await ev(page, "window.__say('오늘 회의에서 납기를 확정했고 견적은 다음 주에 회신합니다')");
    await page.click("#tabKb"); await page.click("#sumToday");
    await expect(page.locator("#sumMsg")).toHaveText(`${today()} 하루 요약을 저장했습니다.`);
    await expect(page.locator("#docList .doc", { hasText: `${today()} 하루 요약` }).locator(".dkind")).toHaveText("하루 요약");
  });

  test("교정기가 같은 말을 두 번 이상 고치면 오인식 등록을 제안, 무시하면 사라짐", async ({ open, page }) => {
    await mockAI(page, (c) => (c.system.includes("받아쓰기 교정기") ? JSON.stringify(c.prompt.split("[교정할 문장]\n")[1].split("\n").map((l) => l.replace(/^\d+\.\s*/, "").replace("쎌라인", "셀 라인"))) : "[]"));
    await open({ key: true, storage: { "ms.pace": "fast" } });
    await startListening(page);
    for (const s of ["쎌라인 점검이 필요합니다", "쎌라인 가동률은 어때요", "그리고 쎌라인 온도도요", "네 알겠습니다"]) await ev(page, `window.__say('${s}')`);
    await expect.poll(() => app(page, "A.S.segs.every(s => s.fix != null)")).toBe(true);
    await page.click("#tabSet");
    const row = page.locator("#learnBox .lrow", { hasText: "쎌라인 → 셀 라인" });
    await expect(row).toContainText("교정기가 3번 고친 말");
    await row.getByRole("button", { name: "무시" }).click();
    await expect(page.locator("#learnBox .lrow", { hasText: "쎌라인" })).toHaveCount(0);
  });
});

test.describe("비슷한 할 일 합치기", () => {
  async function add(page: Page, items: string[]) { await page.click("#tabTodo"); for (const t of items) { await page.fill("#todoInput", t); await page.press("#todoInput", "Enter"); } }
  test("비슷하거나 같은 할 일은 한 묶음으로, '합치기'로 하나로 (가장 자세한 문장·담당·가장 이른 기한), 되돌리기", async ({ open, page }) => {
    await open({});
    await add(page, ["탭 용접 저항 재측정", "탭 용접 저항 다시 측정 / 박지은 / 11/20", "견적 회신", "샘플 재측정 결과 보고 / / 11/25", "샘플 재측정 결과를 보고하기"]);
    const groups = page.locator("#todoList .tgroup");
    await expect(groups).toHaveCount(2);
    await expect(page.locator("#todoDup")).toHaveText("비슷한 할 일 묶음 2개");
    await expect(page.locator("#todoList > .tswipe")).toHaveCount(1); // 견적 회신 stays on its own
    const g = groups.filter({ hasText: "탭 용접" });
    await expect(g.locator(".tswipe")).toHaveCount(2);
    await g.getByRole("button", { name: "합치기" }).click();
    await expect(groups).toHaveCount(1);
    const merged = page.locator("#todoList .tswipe", { hasText: "탭 용접 저항 다시 측정" });
    await expect(merged).toContainText("담당 박지은"); await expect(merged).toContainText("기한 11/20");
    expect(await app(page, "A.tasks.filter(t => !t.deleted).length")).toBe(4);
    await expect(page.locator("#todoUndoMsg")).toContainText("2개를");
    await page.click("#todoUndoBtn");
    await expect(groups).toHaveCount(2);
    expect(await app(page, "A.tasks.filter(t => !t.deleted).length")).toBe(5);
  });

  test("'따로 두기'는 다시 묶지 않음(새로고침 후에도), 담당자가 다르면 묶지 않음", async ({ open, page }) => {
    await open({});
    await add(page, ["샘플 재측정 / 박지은", "샘플 재측정 / 김민수", "IR 불량 원인 분석", "IR 불량 원인을 분석"]);
    await expect(page.locator("#todoList .tgroup")).toHaveCount(1);
    await page.locator("#todoList .tgroup").getByRole("button", { name: "따로 두기" }).click();
    await expect(page.locator("#todoList .tgroup")).toHaveCount(0);
    await page.reload(); await expect(page.locator("html[data-docs='1']")).toHaveCount(1); await page.click("#tabTodo");
    await expect(page.locator("#todoList .tgroup")).toHaveCount(0);
    await expect(page.locator("#todoList .tswipe")).toHaveCount(4);
  });

  test("'따로 두기'와 합친 결과는 서버를 거쳐도 유지", async ({ open, page, browser, ns }) => {
    await open({ storage: { "ms.passcode": "test-pass" } });
    await add(page, ["견적서 회신", "견적서를 회신", "샘플 발송 준비", "샘플을 발송 준비"]);
    await page.locator("#todoList .tgroup", { hasText: "견적서" }).getByRole("button", { name: "따로 두기" }).click();
    await page.locator("#todoList .tgroup", { hasText: "샘플" }).getByRole("button", { name: "합치기" }).click();
    await expect(page.locator("#todoSync")).toContainText("서버와 동기화됨", { timeout: 4000 });
    const b = await device(browser, ns, { "ms.passcode": "test-pass" });
    await b.click("#tabTodo");
    await expect(b.locator("#todoList .tswipe")).toHaveCount(3, { timeout: 4000 });
    await expect(b.locator("#todoList .tgroup")).toHaveCount(0);
    await b.context().close();
  });
});
