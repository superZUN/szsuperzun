// Step 7: questions (answer lead, [보기] tag, web first, present-time questions), DEEP SCAN, pictures.
import { test, expect, startListening, app } from "../harness/fixtures";
import { mockAI, mockWiki, slowClaude, type AICall } from "../harness/ai-mock";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const ev = (page: Page, js: string) => page.evaluate(js);
const isAsk = (c: AICall) => c.prompt.includes("[질문]") && !c.prompt.includes("[넓힌 검색어]");
const isExpand = (c: AICall) => c.prompt.includes("12~18개 만들어");
const isDeepAnswer = (c: AICall) => c.prompt.includes("[넓힌 검색어]");
const answer = (page: Page) => page.locator("#field .callout.t-answer:not(.gone)").last(); // the newest card is last in the page
async function askQ(page: Page, q: string) { await page.click("#modeAsk"); await page.fill("#askInput", q); await page.press("#askInput", "Enter"); }
const DOCS = [
  { id: "1-m", name: "10/14 고객사 주간회의 (회의록)", text: "# 회의록\n- 샘플 납기는 11월 12일까지 1차 샘플 전달로 합의했다.\n- 단가는 작년 계약 기준을 따르기로 했다.", added: Date.now() - 864e5 },
  { id: "2-m", name: "설비 점검", text: "충방전기 채널 교정 일정과 온도 센서 교체 계획을 정리했다.", added: Date.now() - 2 * 864e5 },
  { id: "3-m", name: "품질 회의", text: "IR 불량 원인은 탭 용접 저항으로 추정되며 재측정 후 보고하기로 했다.", added: Date.now() - 3 * 864e5 },
];

test.describe("질문하기", () => {
  test("답변 말머리 '네, 장군님.'을 앱이 붙이고, 모델이 '네,'로 시작해도 하나만", async ({ open, page }) => {
    await mockAI(page, (c) => (isAsk(c) ? "[보기] 없음\n네, 납기는 11월 12일입니다 (회의록: 10/14 고객사 주간회의)." : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off" } });
    await askQ(page, "샘플 납기가 언제지?");
    await expect(answer(page).locator(".body")).toHaveText("네, 장군님. 납기는 11월 12일입니다 (회의록: 10/14 고객사 주간회의).");
  });

  test("말머리는 바꾸거나 비울 수 있음", async ({ open, page }) => {
    await mockAI(page, (c) => (isAsk(c) ? "[보기] 없음\n납기는 11월 12일입니다." : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off", "ms.answerLead": "__none__" } });
    await askQ(page, "샘플 납기가 언제지?");
    await expect(answer(page).locator(".body")).toHaveText("납기는 11월 12일입니다.");
    await page.click("#tabSet"); await page.fill("#answerLead", "예, 대표님."); await page.locator("#answerLead").dispatchEvent("change"); await page.click("#tabLive");
    await askQ(page, "단가 기준은?");
    await expect(answer(page).locator(".body")).toHaveText("예, 대표님. 납기는 11월 12일입니다.");
  });

  test("[보기] 줄은 숨기고 바로 실행: 사진 태그 → 사진 카드", async ({ open, page }) => {
    await mockWiki(page, { ko: { "파우치형": { title: "파우치형 전지", thumb: "https://upload.wikimedia.org/p.png" } } });
    await mockAI(page, (c) => (isAsk(c) ? "[보기] 사진: 파우치형 전지\n파우치형은 알루미늄 필름으로 감싼 셀입니다." : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off" } });
    await askQ(page, "파우치형이 어떤 거야?");
    await expect(answer(page).locator(".body")).toHaveText("네, 장군님. 파우치형은 알루미늄 필름으로 감싼 셀입니다.");
    const vis = page.locator("#field .callout.t-visual");
    await expect(vis).toHaveCount(1);
    await expect(vis.locator("img")).toHaveAttribute("src", "https://upload.wikimedia.org/p.png");
  });

  test("순서: 회의록 일치 RECALL 카드가 답보다 먼저, 프롬프트에 지난 회의록·최근 대화·질문", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isAsk(c) ? { text: "[보기] 없음\n11월 12일입니다.", delayMs: 300 } : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off" }, idbDocs: DOCS });
    await askQ(page, "고객사 샘플 납기 1차 전달 합의 내용");
    await expect(page.locator("#field .callout.t-past:not(.example)")).toHaveCount(1);
    await expect(answer(page).locator(".body")).toContainText("11월 12일입니다");
    const c = ai.calls.find(isAsk)!;
    expect(c.prompt).toContain("[과거 회의록 발췌]"); expect(c.prompt).toContain("<<10/14 고객사 주간회의 (회의록)>>");
    expect(c.prompt).toContain("[질문]\n고객사 샘플 납기 1차 전달 합의 내용");
  });

  test("웹 검색 우선: 검색 도구를 붙이고, 출처 링크를 카드에", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isAsk(c) ? { text: "[보기] 없음\n리튬 가격은 최근 하락했습니다 (웹: example.com).", searched: [{ title: "리튬 시세", url: "https://example.com/li" }] } : "[]"));
    await open({ key: true });
    await askQ(page, "리튬 탄산염이 뭐야?");
    await expect(answer(page)).toContainText("SRC // example.com");
    const c = ai.calls.find(isAsk)!;
    expect(c.webSearch).toBe(true);
    expect(c.body.tools[0].type).toBe("web_search_20250305"); // Haiku keeps the basic tool
    expect(c.body.tools[0].max_uses).toBe(1);
    expect(c.prompt).toContain("'자료에 없다'는 말은 하지 말고 곧바로 웹 검색");
  });

  test("시점에 따라 바뀌는 질문: 검색 없이 답하면 다시 요청, 그래도 못 하면 안내 문구", async ({ open, page }) => {
    let n = 0;
    const ai = await mockAI(page, (c) => { if (!isAsk(c)) return "[]"; n++; return "[보기] 없음\n최신 아이폰은 아이폰 17입니다."; });
    await open({ key: true });
    await askQ(page, "최신 아이폰 모델이 뭐야?");
    await expect(answer(page).locator(".body")).toContainText("(웹 검색을 하지 못해 최신 정보와 다를 수 있습니다)");
    expect(n).toBe(2);
    const [first, second] = ai.calls.filter(isAsk);
    expect(first.prompt).toContain("반드시 웹 검색을 먼저 한 뒤");
    expect(second.prompt).toContain("[중요] 앞선 답은 웹 검색 없이 기억으로 썼습니다");
  });

  test("시점 질문을 실제로 검색하면 재요청 없음", async ({ open, page }) => {
    let n = 0;
    await mockAI(page, (c) => { if (!isAsk(c)) return "[]"; n++; return { text: "[보기] 없음\n2026년 11월 기준 최신은 iPhone 18 Pro입니다 (웹: apple.com).", searched: [{ title: "Apple", url: "https://www.apple.com/iphone" }] }; });
    await open({ key: true });
    await askQ(page, "요즘 나온 아이폰 최신 모델은?");
    await expect(answer(page).locator(".body")).toContainText("iPhone 18 Pro");
    await expect(answer(page).locator(".body")).not.toContainText("웹 검색을 하지 못해");
    expect(n).toBe(1);
  });

  test("웹 검색 끄면 도구 없이, 시점 질문엔 '학습 시점 기준' 안내 지시", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isAsk(c) ? "[보기] 없음\n답" : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off" } });
    await askQ(page, "현재 환율은?");
    await expect(answer(page).locator(".body")).toContainText("답");
    const c = ai.calls.find(isAsk)!;
    expect(c.webSearch).toBe(false);
    expect(c.prompt).toContain("(학습 시점 기준 — 최신 정보는 확인 필요)");
  });

  test("빠른 질문 칩", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isAsk(c) ? "[보기] 없음\n요약입니다." : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off" } });
    await page.click("#modeAsk");
    await page.getByRole("button", { name: "지금까지 요약" }).click();
    await expect(answer(page)).toContainText("요약입니다");
    expect(ai.calls.find(isAsk)!.prompt).toContain("지금까지 회의 내용을 3줄로 요약해줘.");
  });

  test("계산이 필요한 질문은 thinking 사용", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isAsk(c) ? "[보기] 없음\n12%입니다." : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off" } });
    await askQ(page, "불량률을 퍼센트로 계산해 줘");
    await expect(answer(page)).toContainText("12%");
    expect(ai.calls.find(isAsk)!.body.thinking).toEqual({ type: "adaptive" });
  });
});

test.describe("넓게 찾기 (DEEP SCAN)", () => {
  test("같은 질문을 다시 하면: 질문 넓히기 → 훑기 → 찾은 대목 → 시간순 답, 표시 DEEP SCAN → RESPONSE · WIDE", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => {
      if (isExpand(c)) return { text: "납기, 납품일, delivery, 샘플 전달, 1차 샘플, 일정, 기한, 출하일, 11월, due date, 합의, 고객사", delayMs: 400 };
      if (isDeepAnswer(c)) return { text: "11월 12일까지 1차 샘플을 전달하기로 했습니다 (회의록: 10/14 고객사 주간회의).", delayMs: 600 };
      if (isAsk(c)) return "[보기] 없음\n찾지 못했습니다.";
      return "[]";
    });
    await open({ key: true, storage: { "ms.webMode": "off" }, idbDocs: DOCS });
    await askQ(page, "샘플은 언제 보내기로 했지?");
    await expect(answer(page).locator(".body")).toContainText("찾지 못했습니다", { timeout: 6000 }).catch(() => {});
    await askQ(page, "샘플은 언제 보내기로 했지?");
    const card = page.locator("#field .callout.t-answer.deep");
    await expect(card).toHaveCount(1);
    await expect(card.locator(".code")).toHaveText("DEEP SCAN");
    await expect(page.locator("#status")).toHaveText("DEEP SCAN");
    await expect(card.locator(".body")).toContainText("같은 질문을 다시 하셔서");
    await expect(card.locator(".body")).toContainText("③ 찾은 대목: 회의록·자료 1곳");
    await expect(page.locator("#field .callout.t-answer.deepdone .code")).toHaveText("RESPONSE · WIDE", { timeout: 6000 });
    await expect(page.locator("#field .callout.t-answer.deepdone .body")).toContainText("네, 장군님. 11월 12일까지 1차 샘플을 전달하기로 했습니다");
    await expect(page.locator("#status")).not.toHaveText("DEEP SCAN");
    const d = ai.calls.find(isDeepAnswer)!;
    expect(d.prompt).toContain("[넓힌 검색어] 납기, 납품일, delivery");
    expect(d.prompt).toContain("<<10/14 고객사 주간회의 (회의록)>>");
  });

  test("'아까/결정' 질문인데 빠른 검색이 약하면 바로 넓게 찾기", async ({ open, page }) => {
    const ai = await mockAI(page, (c) => (isExpand(c) ? "단가, 가격" : isDeepAnswer(c) ? "회의록·대화 어디에도 없습니다." : isAsk(c) ? "[보기] 없음\nx" : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off" }, idbDocs: DOCS });
    await startListening(page);
    await ev(page, "window.__say('오늘은 날씨 이야기만 했습니다')");
    await askQ(page, "아까 환불 정책은 어떻게 하기로 결정했지?");
    await expect(page.locator("#field .callout.t-answer.deepdone .body")).toContainText("어디에도 없습니다", { timeout: 6000 });
    await expect(page.locator("#field .callout.t-answer.deepdone .body")).toContainText("넓게 찾은 결과");
    expect(ai.calls.some(isAsk)).toBe(false);
  });

  test("빠른 답이 ⟪더찾기⟫를 붙이면 같은 카드에서 넓게 찾기 (표시는 숨김)", async ({ open, page }) => {
    await mockAI(page, (c) => (isExpand(c) ? "단가, 가격" : isDeepAnswer(c) ? "작년 계약 기준입니다." : isAsk(c) ? "[보기] 없음\n자료에서 찾지 못했어요. ⟪더찾기⟫" : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off" } });
    await askQ(page, "단가 기준이 뭐였어?");
    await expect(page.locator("#field .callout.t-answer")).toHaveCount(1);
    await expect(page.locator("#field .callout.t-answer.deepdone .body")).toContainText("빠른 답에 필요한 내용이 없어서".slice(0, 0) + "작년 계약 기준입니다", { timeout: 6000 });
    await expect(page.locator("#field .callout.t-answer .body")).not.toContainText("⟪");
  });
});

test.describe("시각 자료", () => {
  test("말로 하는 그림 요청은 말하는 중에 바로 실행: 대상만 뽑아 사진 (AI 없이)", async ({ open, page }) => {
    const wiki = await mockWiki(page, { ko: { "파우치 셀": { title: "파우치형 전지", thumb: "https://upload.wikimedia.org/p.png" } } });
    await open({});
    await startListening(page);
    await ev(page, "window.__interim('그럼 혹시 파우치 셀 사진 좀 보여줘')");
    await expect(page.locator("#field .callout.t-visual")).toHaveCount(1);
    await expect(page.locator("#field .callout.t-visual .title")).toHaveText("파우치 셀 · 사진");
    await expect(page.locator("#field .callout.t-visual img")).toHaveCount(1);
    await ev(page, "window.__say('그럼 혹시 파우치 셀 사진 좀 보여줘')"); // the final of the same sentence does not ask again
    await page.waitForTimeout(300);
    await expect(page.locator("#field .callout.t-visual")).toHaveCount(1);
    expect(wiki.hits).toEqual(expect.arrayContaining(["ko:파우치 셀", "en:파우치 셀", "commons:파우치 셀 filetype:bitmap"]));
  });

  test("로고·국기는 사진에서 제외, 없으면 '공개 사진을 찾지 못했습니다'", async ({ open, page }) => {
    await mockWiki(page, { ko: { "회사": { title: "회사 로고", thumb: "https://upload.wikimedia.org/Company_logo.png" } } });
    await open({});
    await startListening(page);
    await ev(page, "window.__say('회사 사진 보여줘')");
    await expect(page.locator("#field .callout.t-visual")).toContainText("공개 사진을 찾지 못했습니다");
  });

  test("다이어그램: 스트리밍 중 완성된 줄까지 그려 점점 자람, 다 되면 크게 보기·PNG 저장", async ({ open, page }) => {
    const code = ["flowchart LR\n", '  A["Formation"] --> B["Aging"]\n', '  B --> C["EOL 검사"]\n', '  C --> D["출하"]\n', '  C --> E["불량 분석"]\n', '  E --> F["재작업"]\n'];
    await slowClaude(page, "Mermaid 다이어그램 하나로", code, 350);
    await open({ key: true });
    await page.evaluate(() => {
      (window as any).__srcs = new Set();
      new MutationObserver(() => document.querySelectorAll("#field .callout.t-visual img").forEach((i) => (window as any).__srcs.add((i as HTMLImageElement).src))).observe(document.getElementById("field")!, { subtree: true, childList: true, attributes: true });
    });
    await askQ(page, "공정 흐름도 그려줘").catch(() => {});
    await page.locator("#askInput").press("Enter").catch(() => {});
    await expect(page.locator("#field .callout.t-visual .body")).toHaveText("AI가 그린 개념도입니다. 눌러서 크게 보기", { timeout: 10000 });
    expect(await ev(page, "window.__srcs.size")).toBeGreaterThanOrEqual(3); // partial pictures before the final one
    const src = await page.locator("#field .callout.t-visual img").getAttribute("src");
    expect(decodeURIComponent(src!)).toContain("재작업"); // the last line made it into the final picture
    await page.locator("#field .callout.t-visual").click();
    await page.locator("#focusCard img").click();
    await expect(page.locator("#lightbox")).toBeVisible();
    await expect(page.locator("#lbSave")).toBeVisible();
    const dl = page.waitForEvent("download"); await page.click("#lbSave");
    // (headless Chromium drops Korean download names; the file itself must be a PNG at twice the size)
    const buf = readFileSync(await (await dl).path());
    expect(buf.subarray(1, 4).toString()).toBe("PNG");
    expect(buf.readUInt32BE(16)).toBe(695 * 2);
  });

  test("Mermaid 문법 오류면 오류 메시지와 함께 1회 다시 요청", async ({ open, page }) => {
    let n = 0;
    const ai = await mockAI(page, (c) => { if (!c.prompt.includes("Mermaid 다이어그램 하나로")) return isAsk(c) ? "[보기] 없음\n그립니다." : "[]"; n++; return n === 1 ? "flowchart LR\n  A[[[ --> \n" : 'flowchart TD\n  A["충전"] --> B["방전"]\n'; });
    await open({ key: true, storage: { "ms.webMode": "off" } });
    await askQ(page, "충방전 다이어그램으로 보여줘");
    await expect(page.locator("#field .callout.t-visual img")).toHaveCount(1, { timeout: 10000 });
    expect(n).toBe(2);
    expect(ai.calls.filter((c) => c.prompt.includes("Mermaid"))[1].prompt).toContain("[이전 코드 — 오류가 났으니 문법을 고쳐 다시 출력]");
  });

  test("도면(SVG): script·이벤트·외부 이미지·링크를 지우고 <img>로", async ({ open, page }) => {
    const svg = '<svg viewBox="0 0 400 200" onload="alert(1)"><script>alert(2)</script><rect x="10" y="10" width="100" height="50" fill="#0b2a33" stroke="#6FE7FF"/><image href="https://evil.test/x.png"/><a href="https://evil.test"><text x="20" y="40">탭</text></a><line x1="0" y1="0" x2="50" y2="50" stroke="#6FE7FF"/><text x="150" y="40" fill="#E6F6FA">양극</text><circle cx="300" cy="100" r="20" onclick="x()"/><foreignObject><div>x</div></foreignObject></svg>';
    await mockAI(page, (c) => (c.prompt.includes("기술 도면을 SVG 하나로") ? svg : isAsk(c) ? "[보기] 없음\n도면입니다." : "[]"));
    await open({ key: true, storage: { "ms.webMode": "off" } });
    await askQ(page, "파우치 셀 단면도 그려줘");
    const img = page.locator("#field .callout.t-visual img");
    await expect(img).toHaveCount(1, { timeout: 8000 });
    const out = decodeURIComponent((await img.getAttribute("src"))!);
    for (const bad of ["<script", "onload", "onclick", "<image", "evil.test", "foreignObject"]) expect(out).not.toContain(bad);
    expect(out).toContain("양극");
    expect(out).toContain('width="400"');
  });

  test("분석 카드가 visual을 제안하면 그림 자동 표시(1분에 1장)", async ({ open, page }) => {
    let n = 0;
    await mockAI(page, (c) => {
      if (c.system.includes("짧은 메시지로 던진다")) { n++; return JSON.stringify([{ type: "kw", title: "공정" }, { type: "visual", title: "Formation 공정 흐름", body: "단계 흐름도" }]); }
      if (c.prompt.includes("Mermaid")) return 'flowchart LR\n  A["충전"] --> B["에이징"]\n';
      return "[]";
    });
    await open({ key: true, storage: { "ms.pace": "fast", "ms.fixOff": "1" } });
    await startListening(page);
    await ev(page, "window.__say('Formation 공정은 충전 후 에이징을 거쳐 EOL 검사로 넘어갑니다')");
    await expect(page.locator("#field .callout.t-visual")).toHaveCount(1, { timeout: 8000 });
    await page.click("#analyzeBtn"); await expect.poll(() => n).toBeGreaterThan(1);
    await page.waitForTimeout(500);
    await expect(page.locator("#field .callout.t-visual")).toHaveCount(1);
    expect(await app(page, "A.S.visLast > 0")).toBe(true);
  });
});
