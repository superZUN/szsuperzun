// Step 6: live analysis cards, the transcript corrector, everyday/work topic judgment in conversation mode.
import { test, expect, startListening, app } from "../harness/fixtures";
import { mockAI, type AICall } from "../harness/ai-mock";
import type { Page } from "@playwright/test";

const ev = (page: Page, js: string) => page.evaluate(js);
const isAnalysis = (c: AICall) => c.system.includes("짧은 메시지로 던진다");
const isFix = (c: AICall) => c.system.includes("받아쓰기 교정기");
const real = (page: Page) => page.locator("#field .callout:not(.example):not(.gone)");

test.describe("실시간 분석", () => {
  test("JSON 스트림: 첫 원소 kw → 키워드 바, 이어지는 카드가 완성되는 대로 뜸, 할 일은 할 일 목록으로", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isAnalysis(c) ? { text: JSON.stringify([
      { type: "kw", title: "IR 불량, 탭 용접" },
      { type: "info", title: "IR 불량 원인 후보", body: "탭 용접 저항이 원인일 수 있습니다." },
      { type: "action", title: "탭 용접 저항 재측정", body: "재측정", owner: "박지은", due: "11/20" },
    ]), chunk: 20 } : "[]"));
    await open({ key: true, storage: { "ms.pace": "fast", "ms.fixOff": "1" } });
    await startListening(page);
    await ev(page, "window.__say('IR 불량이 늘었는데 탭 용접 쪽을 봐야 할 것 같아요 박지은 님이 재측정해 주세요')");
    await expect(real(page).filter({ hasText: "IR 불량 원인 후보" })).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator("#kwList")).toContainText("IR 불량");
    await expect(page.locator("#kwList")).toContainText("탭 용접");
    await expect(real(page).filter({ hasText: "탭 용접 저항 재측정" })).toContainText("담당 박지은 · 기한 11/20");
    await expect(page.locator("#actCount")).toHaveText("1");
    expect(await app(page, "A.tasks.filter(t => !t.deleted).map(t => t.text)")).toContain("탭 용접 저항 재측정");
    const c = ai.calls.find(isAnalysis)!;
    expect(c.prompt).toContain("[새로 들어온 부분]");
    expect(c.system).toContain("질문을 제안하지 말 것");
  });

  test("'주제와 무관'·'잡담' 같은 평가 카드는 버리고, 질문 제안(ask)은 맥락 카드로, 같은 제목은 한 번만", async ({ open, page }) => {
    await mockAI(page, (c) => (isAnalysis(c) ? JSON.stringify([{ type: "kw", title: "" }, { type: "risk", title: "주제와 무관한 대화", body: "회의와 관련 없는 잡담입니다." }, { type: "ask", title: "단가 확인", body: "단가 기준은 작년 계약입니다." }, { type: "info", title: "단가 확인", body: "중복" }]) : "[]"));
    await open({ key: true, storage: { "ms.pace": "fast", "ms.fixOff": "1" } });
    await page.click("#rawBtn"); await page.fill("#transcript", "단가 이야기를 잠깐 했는데요 작년 계약 기준으로 다시 봐야 합니다");
    await page.click("#analyzeBtn");
    await expect(real(page).filter({ hasText: "단가 확인" })).toHaveCount(1);
    await expect(real(page).filter({ hasText: "단가 확인" })).toHaveClass(/t-info/);
    await expect(real(page).filter({ hasText: "무관" })).toHaveCount(0);
  });

  test("일상 대화: 경고·할 일 카드 없음, 일상용 지시문, 회의 정보 안 보냄", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isAnalysis(c) ? JSON.stringify([{ type: "kw", title: "제주도", topic: "daily" }, { type: "risk", title: "약속", body: "x" }, { type: "action", title: "예약", body: "x" }, { type: "info", title: "제주 날씨", body: "11월 제주는 선선합니다." }]) : "[]"));
    await open({ key: true, storage: { "ms.appMode": "conv", "ms.pace": "fast" } });
    await page.evaluate(() => { (document.getElementById("pAgenda") as HTMLTextAreaElement).value = "비밀 안건 10"; });
    await startListening(page);
    await ev(page, "window.__say('이번 주말에 가족이랑 제주도 여행 가려고 해요 날씨가 어떨까')");
    await expect(real(page).filter({ hasText: "제주 날씨" })).toHaveCount(1, { timeout: 6000 });
    await expect(real(page).locator(".code", { hasText: "ALERT" })).toHaveCount(0);
    await expect(real(page).filter({ hasText: "예약" })).toHaveCount(0);
    const c = ai.calls.find(isAnalysis)!;
    expect(c.system).toContain("이것은 회의가 아니라 그냥 대화다");
    expect(c.prompt).not.toContain("[안건]");
    expect(ai.calls.filter(isFix)).toHaveLength(0); // no correction in everyday talk (default)
    await expect(page.locator("#endBar")).toBeHidden();
  });

  test("분석 간격: '균형'은 3초 안에 다시 부르지 않음, '빠르게'는 1초", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isAnalysis(c) ? '[{"type":"kw","title":"수율"}]' : "[]"));
    await open({ key: true, storage: { "ms.fixOff": "1" } });
    await startListening(page);
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) { await ev(page, `window.__say('Formation 수율이 지난주보다 ${i}% 떨어졌고 원인을 찾고 있습니다')`); await page.waitForTimeout(400); }
    await page.waitForTimeout(3500);
    const at = ai.calls.filter(isAnalysis).map((c) => c.at - t0);
    expect(at.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(2900);
  });
});

test.describe("받아쓰기 교정기", () => {
  test("빠르게: 2문장씩 일괄 교정, 길이가 이상한 결과는 버림, 원문/교정본 보기", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => {
      if (!isFix(c)) return "[]";
      const lines = c.prompt.split("[교정할 문장]\n")[1].split("\n");
      return JSON.stringify(lines.map((l) => l.replace(/^\d+\.\s*/, "").replace("팔십 프로", "80%").replace("삼호기", "3호기").replace("짧게", "이것은 터무니없이 길게 늘어난 문장으로 원래 문장의 두 배를 훨씬 넘어서는 결과입니다 정말로 깁니다 아주 아주 깁니다")));
    });
    await open({ key: true, storage: { "ms.pace": "fast" } });
    await startListening(page);
    await ev(page, "window.__say('수율이 팔십 프로입니다')"); await ev(page, "window.__say('삼호기 점검 짧게')");
    await expect.poll(() => app(page, "A.S.segs.map(s => s.fix).join(' | ')")).toBe("수율이 80%입니다 | 삼호기 점검 짧게");
    expect(ai.calls.filter(isFix)).toHaveLength(1);
    expect(ai.calls.filter(isFix)[0].system).toContain("[용어 사전]");
    await page.click("#rawBtn");
    await expect(page.locator("#transcript")).toHaveValue("수율이 80%입니다 삼호기 점검 짧게");
    await page.click("#viewRaw");
    await expect(page.locator("#rawView")).toHaveText("수율이 팔십 프로입니다 삼호기 점검 짧게");
    await expect(page.locator("#fixStat")).toHaveText("교정 완료");
  });

  test("균형: 4문장이 모이면 한 번에 교정", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isFix(c) ? JSON.stringify(c.prompt.split("[교정할 문장]\n")[1].split("\n").map((l) => l.replace(/^\d+\.\s*/, ""))) : "[]"));
    await open({ key: true });
    await startListening(page);
    for (let i = 1; i <= 4; i++) await ev(page, `window.__say('${i}번째 문장입니다')`);
    await expect.poll(() => ai.calls.filter(isFix).length).toBe(1);
    expect(ai.calls.filter(isFix)[0].prompt).toContain("4. 4번째 문장입니다");
  });

  test("오인식 등록: 고친 말을 사전에 추가하고 지금까지의 받아쓰기도 바로잡음", async ({ open, page }) => {
    await open({ storage: { "ms.glossary": "SOH = State of Health" } });
    await startListening(page);
    await ev(page, "window.__say('쎌라인 점검이 필요합니다')"); await ev(page, "window.__say('쎌라인 가동률')");
    await page.click("#rawBtn"); await page.click("#markBtn");
    await page.fill("#markWrong", "쎌라인"); await page.fill("#markRight", "셀 라인"); await page.click("#markAdd");
    await expect(page.locator("#markMsg")).toContainText("2곳 바로잡음");
    expect(await ev(page, "localStorage.getItem('ms.glossary')")).toBe("SOH = State of Health\n셀 라인 · 오인식: 쎌라인");
    await expect(page.locator("#transcript")).toHaveValue("셀 라인 점검이 필요합니다 셀 라인 가동률");
  });
});

test.describe("대화 주제 판단 (대화 모드)", () => {
  test("업무 말이 쌓이면 즉시 '업무'로, 바뀌는 순간 다시 분석", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isAnalysis(c) ? '[{"type":"kw","title":"납기","topic":"work"}]' : "[]"));
    await open({ key: true, storage: { "ms.appMode": "conv", "ms.pace": "save" } });
    await startListening(page);
    await expect(page.locator("#topicChip")).toHaveText("일상");
    await ev(page, "window.__say('고객사 납기 일정이 다음 주로 당겨져서 견적을 다시 봐야 해요')");
    await expect(page.locator("#topicChip")).toHaveText("일상"); // one sentence (score 4) is not enough
    await ev(page, "window.__say('팀장님이 불량 수율 데이터도 같이 정리하라고 하셨어요')");
    await expect(page.locator("#topicChip")).toHaveText("업무");
    await expect.poll(() => ai.calls.filter(isAnalysis).length).toBeGreaterThan(0);
    expect(ai.calls.filter(isAnalysis)[0].system).toContain("대화 도중 업무 이야기가 나오고 있다");
  });

  test("AI가 work라고 보면 업무로, 칩을 누르면 5분 동안 수동 고정", async ({ open, page }) => {
    await mockAI(page, (c) => (isAnalysis(c) ? '[{"type":"kw","title":"이야기","topic":"work"}]' : "[]"));
    await open({ key: true, storage: { "ms.appMode": "conv", "ms.pace": "fast" } });
    await startListening(page);
    await ev(page, "window.__say('그 건은 내일 오전까지 정리해서 보내 드릴게요')");
    await expect(page.locator("#topicChip")).toHaveText("업무", { timeout: 5000 });
    await page.click("#topicChip");
    await expect(page.locator("#topicChip")).toHaveText("일상");
    await expect(page.locator("#topicChip")).toHaveClass(/manual/);
    await ev(page, "window.__say('고객사 납기 견적 불량 수율 공정 라인 일정 회의')");
    await page.waitForTimeout(300);
    await expect(page.locator("#topicChip")).toHaveText("일상");
  });

  test("업무에서 일상으로는 1분간 업무 말이 없어야 돌아감", async ({ open, page }) => {
    await page.clock.install();
    await open({ storage: { "ms.appMode": "conv" } });
    await page.click("#startBtn"); await page.clock.runFor(100);
    await ev(page, "window.__say('고객사 납기 일정과 견적 불량 수율을 같이 보죠')");
    await ev(page, "window.__say('팀장님 보고서 마감은 금요일입니다')");
    await expect(page.locator("#topicChip")).toHaveText("업무");
    await page.clock.runFor(30000); await ev(page, "window.__say('점심은 뭐 먹을까')");
    await expect(page.locator("#topicChip")).toHaveText("업무");
    await page.clock.runFor(30000); await ev(page, "window.__say('날씨가 좋네요')"); // 60 s without work talk, but the score has not decayed yet
    await expect(page.locator("#topicChip")).toHaveText("업무");
    await page.clock.runFor(60000); await ev(page, "window.__say('산책 갈까요')");
    await expect(page.locator("#topicChip")).toHaveText("일상");
  });

  test("회의 모드에는 칩이 없고, 모드 전환 시 초기화", async ({ open, page }) => {
    await open({});
    await expect(page.locator("#topicChip")).toBeHidden();
    await page.click("#modeConv");
    await expect(page.locator("#topicChip")).toBeVisible();
    expect(await ev(page, "localStorage.getItem('ms.appMode')")).toBe("conv");
    await page.click("#modeMeet");
    expect(await ev(page, "localStorage.getItem('ms.appMode')")).toBeNull();
  });
});
