// Step 3: storage, settings (legacy keys keep working), the AI provider layer.
import { test, expect, app } from "../harness/fixtures";
import { mockAI } from "../harness/ai-mock";

test.describe("기존 데이터 이어 쓰기", () => {
  test("옛 Claude 전용 키(ms.apiKey)를 제공자별 키로 옮김, 다른 설정은 그대로", async ({ open, page }) => {
    await open({ storage: { "ms.apiKey": "sk-old", "ms.model": "claude-x", "ms.glossary": "NSE = NextStar Energy", "ms.appMode": "conv", "ms.power": "save", "ms.recRefreshMs": "45000", "ms.vadAutoOff": "1" } });
    const ls = await page.evaluate(() => ({ key: localStorage.getItem("ms.key.anthropic"), fast: localStorage.getItem("ms.fast.anthropic"), old: localStorage.getItem("ms.apiKey"), refresh: localStorage.getItem("ms.recRefreshMs"), auto: localStorage.getItem("ms.vadAutoOff") }));
    expect(ls).toEqual({ key: "sk-old", fast: "claude-x", old: null, refresh: null, auto: null });
    await page.click("#tabSet");
    await expect(page.locator("#apiKey")).toHaveValue("sk-old");
    await expect(page.locator("#model")).toHaveValue("claude-x");
    await expect(page.locator("#glossary")).toHaveValue("NSE = NextStar Energy");
    await expect(page.locator("#powerMode")).toHaveValue("save");
    await expect(page.locator("#modeConv")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#topicChip")).toBeVisible();
  });

  test("끄기 설정(ms.*Off)과 말머리 빈 값(__none__)이 유지됨", async ({ open, page }) => {
    await open({ key: true, storage: { "ms.baseOff": "1", "ms.wikiOff": "1", "ms.fixOff": "1", "ms.vadOff": "1", "ms.answerLead": "__none__", "ms.webMode": "off", "ms.allDay": "1", "ms.minTemplate": "1. 회의명" } });
    await page.click("#tabSet");
    await expect(page.locator("#baseOn")).not.toBeChecked();
    await expect(page.locator("#libOn")).toBeChecked();
    await expect(page.locator("#wikiOn")).not.toBeChecked();
    await expect(page.locator("#fixOn")).not.toBeChecked();
    await expect(page.locator("#vadOn")).not.toBeChecked();
    await expect(page.locator("#allDay")).toBeChecked();
    await expect(page.locator("#answerLead")).toHaveValue("");
    await expect(page.locator("#webMode")).toHaveValue("off");
    await expect(page.locator("#minTemplate")).toHaveValue("1. 회의명");
    await page.fill("#answerLead", ""); await page.locator("#answerLead").dispatchEvent("change");
    expect(await page.evaluate(() => localStorage.getItem("ms.answerLead"))).toBe("__none__");
  });

  test("기존 IndexedDB 회의록(meeting-copilot/docs)이 회의록 탭에 보임", async ({ open, page }) => {
    await open({ idbDocs: [
      { id: "1-m", name: "10/14 고객사 주간회의 (회의록)", text: "# 회의록\n- 샘플 납기 11/12", added: Date.now() - 864e5 },
      { id: "2-p", name: "옛 자료", text: "Formation 수율 96.5%", added: Date.now() - 2 * 864e5, synced: true },
    ] });
    await page.click("#tabKb");
    await expect(page.locator("#kbCount")).toHaveText("2");
    await expect(page.locator("#docList .doc")).toHaveCount(2);
    await expect(page.locator("#docList")).toContainText("☁ 옛 자료");
  });

  test("기본 사전 76 + 235개, 목록 검색", async ({ open, page }) => {
    await open({ key: true });
    await page.click("#tabSet");
    await expect(page.locator("#baseCount")).toHaveText("76");
    await expect(page.locator("#libCount")).toHaveText("235");
    await page.click("#libShow"); await page.fill("#libList .dsearch", "SEI");
    await expect(page.locator("#libList .bterm").first()).toContainText("SEI");
  });
});

test.describe("AI 연결", () => {
  test("Claude: 고정 앞부분은 system + cache_control, 빠른 모델 thinking 끔, 오늘 날짜 포함", async ({ open, page }) => {
    const ai = await mockAI(page, () => '[{"type":"kw","title":"SEI"}]');
    await open({ key: true, storage: { "ms.pace": "fast" } });
    await page.click("#tabLive");
    await page.click("#rawBtn"); await page.fill("#transcript", "Formation 공정에서 SEI 형성 조건을 다시 확인하기로 했습니다. 수율 96.5% 목표입니다.");
    await page.click("#analyzeBtn");
    await expect.poll(() => ai.calls.length).toBeGreaterThan(0);
    const b = ai.calls[0].body;
    expect(b.model).toBe("claude-haiku-5-5");
    expect(b.stream).toBe(true);
    expect(b.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(b.system[0].text).toContain("[용어 사전]");
    expect(b.system[0].text).toContain("Formation");
    expect(b.thinking).toEqual({ type: "disabled" });
    expect(b.output_config).toEqual({ effort: "low" });
    const d = new Date();
    expect(b.system[0].text).toContain(`오늘은 ${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`);
    expect(ai.calls[0].prompt).toContain("[새로 들어온 부분]");
    expect(ai.calls[0].prompt).not.toContain("[용어 사전] 이 회의");
  });

  test("모델 세대별 thinking 설정: Sonnet 5.5 = between_tools, Opus 5.5 = 생략", async ({ open, page }) => {
    const ai = await mockAI(page, () => "연결됨");
    await open({ storage: { "ms.key.anthropic": "k", "ms.fast.anthropic": "claude-sonnet-5-5" } });
    await page.click("#tabSet"); await page.click("#testKey");
    await expect(page.locator("#keyMsg")).toContainText("연결 성공");
    expect(ai.calls[0].body.thinking).toEqual({ type: "between_tools" });
    await page.fill("#model", "claude-opus-5-5"); await page.click("#testKey");
    await expect.poll(() => ai.calls.length).toBe(2);
    expect(ai.calls[1].body.thinking).toBeUndefined();
    expect(ai.calls[1].body.output_config).toEqual({ effort: "low" });
  });

  test("선택 옵션을 거부(400)하면 빼고 한 번 다시 보냄", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (c.body.thinking ? { status: 400, error: "thinking is not supported" } : "연결됨"));
    await open({ key: true });
    await page.click("#tabSet"); await page.click("#testKey");
    await expect(page.locator("#keyMsg")).toContainText("연결 성공");
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1].body.thinking).toBeUndefined();
  });

  test("오류는 사람 말로: 키 틀림 / 요청 많음 / 모델 이름", async ({ open, page }) => {
    let status = 401;
    await mockAI(page, () => ({ status, error: status === 404 ? "model not found" : "x" }));
    await open({ key: true });
    await page.click("#tabSet"); await page.click("#testKey"); await expect(page.locator("#keyMsg")).toContainText("API 키가 맞지 않습니다");
    status = 429; await page.click("#testKey"); await expect(page.locator("#keyMsg")).toContainText("요청이 많아");
    status = 529; await page.click("#testKey"); await expect(page.locator("#keyMsg")).toContainText("요청이 많아");
    status = 404; await page.click("#testKey"); await expect(page.locator("#keyMsg")).toContainText("모델 이름을 찾을 수 없습니다");
  });

  test("OpenAI·Gemini·호환 API 스트리밍, 모델 목록", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => `${c.provider} 연결됨`, { compatBase: "https://compat.test/v1" });
    await open({ key: true });
    await page.click("#tabSet"); await page.selectOption("#provider", "openai"); await page.fill("#apiKey", "sk-o"); await page.click("#saveKey");
    await page.click("#testKey"); await expect(page.locator("#keyMsg")).toContainText("openai 연결됨");
    expect(ai.calls.at(-1)!.body.reasoning_effort).toBe("none");
    expect(ai.calls.at(-1)!.body.max_completion_tokens).toBeGreaterThan(0);
    await page.click("#listModels"); await expect(page.locator("#keyMsg")).toContainText("2개 모델");
    await page.selectOption("#provider", "gemini"); await page.fill("#apiKey", "AIza"); await page.click("#saveKey");
    await page.click("#testKey"); await expect(page.locator("#keyMsg")).toContainText("gemini 연결됨");
    expect(ai.calls.at(-1)!.url).toContain(":streamGenerateContent?alt=sse");
    await page.selectOption("#provider", "compat"); await expect(page.locator("#baseWrap")).toBeVisible();
    await page.fill("#apiKey", "c"); await page.fill("#baseUrl", "https://compat.test/v1/"); await page.fill("#model", "m1"); await page.click("#saveKey");
    await page.click("#testKey"); await expect(page.locator("#keyMsg")).toContainText("compat 연결됨");
    // each provider keeps its own key
    await page.selectOption("#provider", "openai"); await expect(page.locator("#apiKey")).toHaveValue("sk-o");
  });

  test("사용량: 호출 수와 캐시 토큰이 오늘 사용량에 쌓임", async ({ open, page }) => {
    await mockAI(page, () => "연결됨");
    await open({ key: true });
    await page.click("#tabSet"); await page.click("#testKey"); await expect(page.locator("#keyMsg")).toContainText("연결 성공");
    await page.click("#tabLive"); await page.click("#tabSet");
    await expect(page.locator("#usageBox")).toContainText("오늘 AI 호출 1회");
    expect(await app(page, "A.usage().inTok")).toBe(100);
  });
});
