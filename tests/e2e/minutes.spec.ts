// Step 8: meeting manager (prep, agenda bar + alerts, actions, carry-over, closing check, autosave, new meeting)
// and the minutes confirmation flow (준비중 → 검토 필요 / 확정, replacement, reuse, server upload).
import { test, expect, startListening, app } from "../harness/fixtures";
import { mockAI, type AICall, type AIReply } from "../harness/ai-mock";
import type { Page } from "@playwright/test";

const ev = (page: Page, js: string) => page.evaluate(js);
const isRevise = (c: AICall) => c.system.includes("최종 기록본으로 다듬으세요");
const isWrite = (c: AICall) => c.prompt.includes("당신은 회의록 작성자입니다");
const isVerify = (c: AICall) => c.prompt.includes("당신은 회의록 검수자입니다");
const isFixMin = (c: AICall) => c.prompt.includes("[검수 결과]의 문제를 고쳐");
const echoRevise = (c: AICall) => c.prompt.split("[본문]\n")[1];
const MINUTES = "# 주간회의\n## 결정 사항\n- 샘플 납기 11/20 확정\n## 할 일 (Action Items)\n| 할 일 | 담당 | 기한 |\n|---|---|---|\n| 샘플 재측정 | 박지은 | 11/20 |";
function minutesAI(page: Page, opts: { verify?: () => string; write?: () => AIReply | string } = {}) {
  return mockAI(page, (c) => {
    if (isRevise(c)) return echoRevise(c);
    if (isWrite(c) || isFixMin(c)) return opts.write ? opts.write() : MINUTES;
    if (isVerify(c)) return opts.verify ? opts.verify() : '{"ok":true,"issues":[]}';
    if (c.prompt.includes("후속 메일 초안")) return "제목: 주간회의 후속\n\n안녕하세요.\n- 샘플 재측정 (박지은, 11/20)";
    if (c.prompt.includes("마무리 점검")) return "## 다루지 않았거나 결론이 안 난 안건\n- 차주 생산 계획";
    return "[]";
  });
}
async function speak(page: Page, lines: string[]) { await startListening(page); for (const l of lines) await ev(page, `window.__say(${JSON.stringify(l)})`); await page.click("#startBtn"); }
const TALK = ["샘플 납기는 11월 20일로 확정합니다", "박지은 님이 샘플 재측정을 맡아 주세요", "다음 회의는 다음 주 화요일입니다"];
const server = async (page: Page, ns: string) => (await (await page.request.get("/__test/blobs/dump", { headers: { "x-test-ns": ns } })).json()).sidekick || {};

test.describe("회의록 확정 절차", () => {
  test("교정 → 작성 → 검수 통과 → 확정: 회의록+부록 저장, 서버 업로드, 할 일 이월", async ({ open, page, ns }) => {
    const ai = await minutesAI(page);
    await open({ key: true, storage: { "ms.passcode": "test-pass", "ms.fixOff": "1" } });
    await speak(page, TALK);
    await page.click("#tabPrep"); await page.fill("#pTitle", "11/13 주간회의"); await page.click("#tabLive");
    await page.click("#modeAct"); await page.fill("#actInput", "샘플 재측정 / 박지은 / 11/20"); await page.press("#actInput", "Enter");
    await expect(page.locator("#endBar")).toBeVisible();
    await page.click("#minutesBtn");
    await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 8000 });
    await expect(page.locator("#minOut")).toContainText("샘플 납기 11/20 확정");
    await expect(page.locator("#minActions")).toBeVisible();
    expect(ai.calls.filter(isRevise)).toHaveLength(1);
    const w = ai.calls.find(isWrite)!;
    expect(w.prompt).toContain('제목 "11/13 주간회의"');
    expect(w.prompt).toContain("- 샘플 재측정 | 담당: 박지은 | 기한: 11/20");
    await page.click("#minClose"); await page.click("#tabKb");
    const row = page.locator("#docList .doc", { hasText: "11/13 주간회의 (회의록)" });
    await expect(row).toHaveCount(1); await expect(row.locator(".dbadge")).toHaveCount(0);
    await expect(row).toContainText("☁");
    const s = await server(page, ns);
    const id = Object.keys(s).find((k) => k.startsWith("minutes/"))!;
    expect(s[id].text).toContain("## 부록: 최종 대화 기록 (교정본)");
    expect(s[id].text).toContain("박지은 님이 샘플 재측정을 맡아 주세요");
    await page.click("#tabPrep");
    await expect(page.locator("#carryList")).toContainText("샘플 재측정 — 박지은, 11/20");
  });

  test("검수에서 문제가 남으면 '검토 필요' + 문제 목록, 서버·검색 색인 제외 → '이대로 확정'", async ({ open, page, ns }) => {
    const ai = await minutesAI(page, { verify: () => '{"ok":false,"issues":["담당자 이름이 받아쓰기와 다릅니다"]}' });
    await open({ key: true, storage: { "ms.passcode": "test-pass", "ms.fixOff": "1" } });
    await speak(page, TALK);
    await page.click("#minutesBtn");
    await expect(page.locator("#minStage .stpill")).toHaveText("검토 필요", { timeout: 8000 });
    await expect(page.locator("#minIssues li")).toHaveText(["담당자 이름이 받아쓰기와 다릅니다"]);
    expect(ai.calls.filter(isFixMin)).toHaveLength(1); // fixed once and checked again
    expect(ai.calls.filter(isVerify)).toHaveLength(2);
    expect(Object.keys(await server(page, ns)).filter((k) => k.startsWith("minutes/"))).toHaveLength(0);
    expect(await app(page, "A.S.docs.find(d => d.status === 'review') != null")).toBe(true);
    await page.click("#minClose"); await page.click("#tabKb");
    await expect(page.locator("#docList .dbadge.review")).toHaveText("검토 필요");
    await page.click("#tabLive"); await page.click("#rawBtn"); await page.click("#minutesBtn2");
    await page.click("#minAccept");
    await expect(page.locator("#minStage .stpill")).toHaveText("확정");
    await expect.poll(async () => Object.keys(await server(page, ns)).filter((k) => k.startsWith("minutes/")).length).toBe(1);
  });

  test("작성 중엔 '준비중', 새로고침되면 '검토 필요'로", async ({ open, page }) => {
    await minutesAI(page, { write: () => ({ text: MINUTES, delayMs: 4000 }) });
    await open({ key: true, storage: { "ms.fixOff": "1" } });
    await speak(page, TALK);
    await page.click("#minutesBtn");
    await expect(page.locator("#minStage .stpill")).toHaveText("준비중");
    await page.click("#minClose"); await page.click("#tabKb");
    await expect(page.locator("#docList .dbadge")).toHaveText("준비중");
    await page.reload(); await expect(page.locator("html[data-docs='1']")).toHaveCount(1);
    await page.click("#tabKb");
    await expect(page.locator("#docList .dbadge.review")).toHaveText("검토 필요");
  });

  test("같은 회의를 다시 쓰면 새 것이 확정될 때까지 이전 확정본 유지, 확정 시 교체", async ({ open, page }) => {
    let slow = false;
    await minutesAI(page, { write: () => (slow ? { text: MINUTES + "\n- v2", delayMs: 2500 } : MINUTES) });
    await open({ key: true, storage: { "ms.fixOff": "1" } });
    await speak(page, TALK);
    await page.click("#minutesBtn");
    await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 8000 });
    slow = true; await page.click("#minGo");
    await expect(page.locator("#minStage .stpill")).toHaveText("준비중");
    expect(await app(page, "A.S.docs.map(d => d.status || 'final').sort().join(',')")).toBe("final,pending");
    await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 8000 });
    expect(await app(page, "A.S.docs.length")).toBe(1);
    expect(await app(page, "A.S.docs[0].text.includes('- v2')")).toBe(true);
  });

  test("내용이 그대로면 다시 열어도 재사용, 받아쓰기를 직접 고치면 새로 작성", async ({ open, page }) => {
    const ai = await minutesAI(page);
    await open({ key: true, storage: { "ms.fixOff": "1" } });
    await speak(page, TALK);
    await page.click("#minutesBtn");
    await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 8000 });
    await page.click("#minClose");
    await page.click("#rawBtn"); await page.click("#minutesBtn2"); await page.waitForTimeout(400); await page.click("#minClose");
    expect(ai.calls.filter(isWrite)).toHaveLength(1);
    await page.fill("#transcript", "샘플 납기는 11월 27일로 변경합니다. 박지은 님이 재측정을 맡고, 다음 회의는 다음 주 화요일입니다."); await page.locator("#transcript").blur();
    await page.click("#minutesBtn2");
    await expect.poll(() => ai.calls.filter(isWrite).length, { timeout: 8000 }).toBe(2);
    expect(ai.calls.filter(isWrite)[1].prompt).toContain("11월 27일로 변경합니다");
  });

  test("교정이 ⟦⟧ 표시를 잃거나 길이가 이상하면 원문 사용, 중요 표시·메모는 ★ 중요 내용으로", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => { if (isRevise(c)) return "짧게 줄였습니다"; if (isWrite(c)) return MINUTES; if (isVerify(c)) return '{"ok":true,"issues":[]}'; return "[]"; });
    await open({ key: true, storage: { "ms.fixOff": "1" } });
    await startListening(page);
    await ev(page, "window.__say('샘플 납기는 11월 20일로 확정합니다')"); await page.click("#markNow");
    await ev(page, "window.__say('박지은 님이 샘플 재측정을 맡기로 했고 결과는 금요일에 공유합니다')");
    await page.fill("#memoInput", "고객사에 내일 통보"); await page.press("#memoInput", "Enter");
    await page.click("#startBtn");
    await page.click("#minutesBtn");
    await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 8000 });
    const w = ai.calls.find(isWrite)!;
    expect(w.prompt).toContain("⟦중요 구간 시작⟧ 샘플 납기는 11월 20일로 확정합니다");
    expect(w.prompt).toContain("⟦사용자 메모");
    expect(w.prompt).toContain("## ★ 중요 내용");
  });

  test("회사 양식이 있으면 그 구성으로", async ({ open, page }) => {
    const ai = await minutesAI(page);
    await open({ key: true, storage: { "ms.fixOff": "1", "ms.minTemplate": "1. 회의명\n2. 결론\n3. Action Item" } });
    await speak(page, TALK);
    await page.click("#minutesBtn");
    await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 8000 });
    expect(ai.calls.find(isWrite)!.prompt).toContain("[회사 양식]\n1. 회의명\n2. 결론\n3. Action Item");
  });

  test("후속 메일 초안: 제목·본문 채움", async ({ open, page }) => {
    await minutesAI(page);
    await open({ key: true, storage: { "ms.fixOff": "1" } });
    await speak(page, TALK);
    await page.click("#minutesBtn");
    await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 8000 });
    await page.click("#mailBtn");
    await expect(page.locator("#mailSubj")).toHaveValue("주간회의 후속");
    await expect(page.locator("#mailBody")).toHaveValue(/샘플 재측정 \(박지은, 11\/20\)/);
  });
});

test.describe("회의 매니저", () => {
  test("안건 '제목 10' = 10분, 안건 바 이동, 초과 알림은 회의 모드에서만", async ({ open, page }) => {
    await page.clock.install();
    await open({});
    await page.click("#tabPrep"); await page.fill("#pAgenda", "샘플 납기 현황 1\nIR NG 개선 대책 15"); await page.fill("#pDur", "2"); await page.click("#tabLive");
    await expect(page.locator("#prepCount")).toHaveText("2");
    await expect(page.locator("#agTitle")).toHaveText("시작 전 · 첫 안건: 샘플 납기 현황");
    await page.locator("#startBtn").dispatchEvent("click"); await page.clock.runFor(200);
    await expect(page.locator("#agPos")).toHaveText("AGENDA 1/2");
    await page.clock.runFor(61000);
    await expect(page.locator("#field .callout.t-risk", { hasText: "안건 1 시간 초과" })).toHaveCount(1);
    await expect(page.locator("#field .callout.t-risk", { hasText: "남은 시간 약" })).toHaveCount(0);
    await page.locator("#agNext").dispatchEvent("click");
    await expect(page.locator("#agTitle")).toHaveText("IR NG 개선 대책");
    await page.clock.runFor(36000); // 80 % of the planned 2 min
    await expect(page.locator("#field .callout.t-risk", { hasText: "남은 시간 약" })).toHaveCount(1);
    await page.clock.runFor(25000);
    await expect(page.locator("#field .callout.t-risk", { hasText: "예정 시간 종료" })).toHaveCount(1);
  });

  test("대화 모드에서는 안건 시간 알림 없음", async ({ open, page }) => {
    await page.clock.install();
    await open({ storage: { "ms.appMode": "conv" } });
    await page.evaluate(() => { (document.getElementById("pAgenda") as HTMLTextAreaElement).value = "안건 1"; (document.getElementById("pDur") as HTMLInputElement).value = "1"; });
    await page.locator("#startBtn").dispatchEvent("click"); await page.clock.runFor(200); await page.locator("#agNext").dispatchEvent("click");
    await page.clock.runFor(130000);
    await expect(page.locator("#field .callout.t-risk")).toHaveCount(0);
  });

  test("할 일 직접 입력: '할 일 / 담당 / 11/20' — 날짜 안의 슬래시는 날짜, 같은 일은 합침", async ({ open, page }) => {
    await open({});
    await page.click("#modeAct");
    await page.fill("#actInput", "샘플 재측정 / 박지은 / 11/20"); await page.press("#actInput", "Enter");
    await page.fill("#actInput", "샘플 재측정"); await page.press("#actInput", "Enter");
    expect(await app(page, "JSON.stringify(A.S.actions.map(a => [a.text, a.owner, a.due]))")).toBe('[["샘플 재측정","박지은","11/20"]]');
    await page.click("#actBtn");
    await expect(page.locator("#actList .aitem:not(.new) input").first()).toHaveValue("샘플 재측정");
    await page.locator("#actList .aitem:not(.new) input").nth(2).fill("11/27"); await page.locator("#actList .aitem:not(.new) input").nth(2).dispatchEvent("change");
    expect(await app(page, "A.tasks.find(t => t.text === '샘플 재측정').due")).toBe("11/27");
  });

  test("마무리 점검: 안건·할 일·이월 정보를 보내고 결과를 보여 줌", async ({ open, page }) => {
    const ai = await minutesAI(page);
    await open({ key: true, storage: { "ms.fixOff": "1" } });
    await page.evaluate(() => { (document.getElementById("pAgenda") as HTMLTextAreaElement).value = "샘플 납기 현황 10\n차주 생산 계획 5"; });
    await speak(page, TALK);
    await page.click("#chkBtn2");
    await expect(page.locator("#chkOut")).toContainText("차주 생산 계획");
    const c = ai.calls.find((x) => x.prompt.includes("마무리 점검"))!;
    expect(c.prompt).toContain("[안건과 실제 소요 시간]");
  });

  test("자동 저장 → 새로고침 후 복구 바, 큰 그림 데이터는 저장 안 함", async ({ open, page }) => {
    await open({});
    await speak(page, TALK);
    await page.fill("#memoInput", "중요 메모"); await page.press("#memoInput", "Enter");
    await page.evaluate(() => { const A = (window as any).__app; A.S.history.unshift({ id: 999, type: "visual", title: "큰 그림", body: "", source: "", links: [], kw: "", time: "", img: { src: "data:" + "x".repeat(130000), kind: "diagram" } }); });
    await page.waitForTimeout(5500);
    const saved = JSON.parse((await ev(page, "localStorage.getItem('ms.session')")) as string);
    expect(saved.segs).toHaveLength(3);
    expect(saved.history.find((d: any) => d.id === 999).img).toBeNull();
    await page.reload(); await expect(page.locator("html[data-docs='1']")).toHaveCount(1); await page.click("#tabLive");
    await expect(page.locator("#restoreBar")).toBeVisible();
    await expect(page.locator("#restoreMsg")).toContainText("받아쓰기 3문장, 메모 1개");
    expect(await app(page, "A.S.segs.length")).toBe(3);
  });

  test("회의록을 쓴 뒤 다시 시작하면 '새 회의?' 질문(회의 모드), 새로 시작하면 비움", async ({ open, page }) => {
    await minutesAI(page);
    await open({ key: true, storage: { "ms.fixOff": "1" } });
    await speak(page, TALK);
    await page.click("#minutesBtn");
    await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 8000 });
    await page.click("#minClose");
    await page.click("#startBtn");
    await expect(page.locator("#boundaryBar")).toBeVisible();
    await expect(page.locator("#startBtn")).toHaveText("시작");
    await page.click("#bNew");
    await expect(page.locator("#startBtn")).toHaveText("멈춤");
    expect(await app(page, "A.S.segs.length")).toBe(0);
  });

  test("대화 모드에서는 '새 회의?' 질문과 '회의록 작성' 바가 없음", async ({ open, page }) => {
    await open({ storage: { "ms.appMode": "conv" } });
    await speak(page, TALK);
    await expect(page.locator("#endBar")).toBeHidden();
    await page.click("#startBtn");
    await expect(page.locator("#boundaryBar")).toBeHidden();
    await expect(page.locator("#startBtn")).toHaveText("멈춤");
  });

  test("'새 회의'는 두 번 눌러야 비움", async ({ open, page }) => {
    await open({});
    await speak(page, TALK);
    await page.click("#tabPrep"); await page.fill("#pTitle", "지난 회의");
    await page.click("#newMeeting");
    await expect(page.locator("#newMeeting")).toHaveText("정말 비울까요? 한 번 더");
    expect(await app(page, "A.S.segs.length")).toBe(3);
    await page.click("#newMeeting");
    await expect(page.locator("#pTitle")).toHaveValue("");
    expect(await app(page, "A.S.segs.length")).toBe(0);
    expect(await ev(page, "localStorage.getItem('ms.session')")).toBeNull();
  });
});
