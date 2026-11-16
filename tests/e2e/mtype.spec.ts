// 회의 유형 buttons (replacing the dropdown): one tap, English switches recognition, used by analysis and minutes, kept on reload.
import { test, expect, startListening } from "../harness/fixtures";
import { mockAI } from "../harness/ai-mock";

test("회의 유형은 버튼 4개, 한 번에 선택; 영어 회의는 인식 언어 EN; 분석에 반영; 대화 모드에선 숨김", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (c.system.includes("짧은 메시지로 던진다") ? '[{"type":"kw","title":"x"}]' : "[]"));
  await open({ key: true, storage: { "ms.pace": "fast", "ms.fixOff": "1" } });
  const btns = page.locator("#mtype [data-mt]");
  await expect(btns).toHaveText(["일반 회의", "영어 회의", "기술 논의", "고객·협력사 미팅"]);
  await expect(page.locator("#mtype [aria-checked='true']")).toHaveText("일반 회의");
  await page.getByRole("radio", { name: "영어 회의" }).click();
  await expect(page.locator("#mtype [aria-checked='true']")).toHaveText("영어 회의");
  await expect(page.locator("#lang")).toHaveValue("en-US");
  await page.getByRole("radio", { name: "고객·협력사 미팅" }).click();
  await expect(page.locator("#lang")).toHaveValue("ko-KR");
  await startListening(page);
  await page.evaluate(() => (window as any).__say("고객사와 지난번 합의한 단가를 다시 확인해야 합니다"));
  await expect.poll(() => ai.calls.length).toBeGreaterThan(0);
  expect(ai.calls[0].system).toContain("회의 유형: 고객·협력사 미팅. 과거 회의에서 합의한 내용과");
  await page.click("#startBtn"); await page.click("#modeConv");
  await expect(page.locator("#mtype")).toBeHidden();
});

test("고른 회의 유형은 새로고침해도 유지(자동 저장)", async ({ open, page }) => {
  await open({});
  await page.getByRole("radio", { name: "기술 논의" }).click();
  await page.fill("#memoInput", "유형 저장 확인"); await page.press("#memoInput", "Enter");
  await page.waitForTimeout(5500);
  await page.reload(); await expect(page.locator("html[data-docs='1']")).toHaveCount(1); await page.click("#tabLive");
  await expect(page.locator("#mtype [aria-checked='true']")).toHaveText("기술 논의");
});
