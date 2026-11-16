// 마인드맵 tab: gathers minutes, day summaries, conversation logs by period/scope, draws the AI's tree, open/close,
// node detail with related passages and "이것에 대해 질문", saved per period, PNG and outline export.
import { test, expect, app, startListening } from "../harness/fixtures";
import { mockAI, type AICall } from "../harness/ai-mock";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const isMind = (c: AICall) => c.prompt.includes("마인드맵으로 정리하세요");
const TREE = { title: "이번 주 — 샘플 납기와 IR 불량", children: [
  { t: "고객사 샘플", n: "1차 샘플 납기 11/20 확정", s: ["11/13 주간회의 (회의록)"], c: [{ t: "납기 11/20 확정" }, { t: "추가 샘플 50셀" }] },
  { t: "IR 불량", c: [{ t: "원인: 탭 용접 저항", c: [{ t: "재측정 — 박지은" }, { t: "용접기 점검" }] }, { t: "불량률 1.8%→1.2%" }] },
  { t: "사람·일상", c: [{ t: "주말 제주 여행" }] },
] };
const d = (n: number) => { const x = new Date(Date.now() - n * 864e5), p = (k: number) => String(k).padStart(2, "0"); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };
const DOCS = [
  { id: "1-m", name: "11/13 주간회의 (회의록)", text: "# 주간회의\n- 고객사 샘플 납기 11/20 확정\n- IR 불량 원인은 탭 용접 저항\n\n## 부록: 최종 대화 기록 (교정본)\n부록은 보내지 않음", added: Date.now() - 2 * 864e5 },
  { id: `day-${d(3)}-dev`, name: `${d(3)} 대화 기록`, text: `# x\n[10:00:00] (업무) 견적 회신은 11월 18일까지 보내기로 했습니다\n[12:00:00] (일상) 주말에 가족이랑 제주 여행 가요\n[12:05:00] (일상) 아이 학교 행사는 금요일 오후 세 시래요\n`, added: Date.now() - 3 * 864e5 },
  { id: "old-m", name: "옛날 회의 (회의록)", text: "# 옛날\n- 작년 이야기", added: Date.now() - 60 * 864e5 },
];
const nodes = (page: Page) => page.locator("#mmSvg g.mmnode[data-id]");

test("기간 자료를 모아 한 번에 만들고(부록·기간 밖 제외), HUD 모양 트리로 그림", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isMind(c) ? JSON.stringify(TREE) : "[]"));
  await open({ key: true, idbDocs: DOCS });
  await page.click("#tabMind");
  await expect(page.locator("#mmEmpty")).toBeVisible();
  await page.click("#mmMake");
  await expect(page.locator("#mmMeta")).toContainText("최근 7일");
  await expect(page.locator("#mmMeta")).toContainText("자료 2개 · 주제 10개");
  const p = ai.calls.find(isMind)!.prompt;
  expect(p).toContain("<<11/13 주간회의 (회의록)>>"); expect(p).not.toContain("부록은 보내지 않음");
  expect(p).toContain("견적 회신은 11월 18일까지"); expect(p).not.toContain("작년 이야기");
  // root + 3 branches + their children (depth 2 shown; deeper ones folded)
  await expect(nodes(page)).toHaveCount(1 + 3 + 5);
  await expect(page.locator("#mmSvg text", { hasText: "이번 주 — 샘플 납기와 IR 불량" })).toHaveCount(1);
  await expect(page.locator("#mmSvg [data-knob]")).toHaveCount(1 + 3 + 1);
  expect(await page.locator("#mmSvg path").first().getAttribute("stroke")).toMatch(/^#/);
});

test("범위: 업무만이면 일상 줄을 빼고, 일상만이면 회의록을 뺌; 전체 기간이면 오래된 회의록도", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isMind(c) ? JSON.stringify(TREE) : "[]"));
  await open({ key: true, idbDocs: DOCS });
  await page.click("#tabMind");
  await page.selectOption("#mmScope", "work"); await page.click("#mmMake"); await expect(nodes(page).first()).toBeVisible();
  let p = ai.calls.filter(isMind).at(-1)!.prompt; expect(p).toContain("업무 이야기만"); expect(p).not.toContain("제주 여행");
  await page.selectOption("#mmScope", "daily"); await page.click("#mmMake"); await expect.poll(() => ai.calls.filter(isMind).length).toBe(2);
  p = ai.calls.filter(isMind).at(-1)!.prompt; expect(p).toContain("제주 여행"); expect(p).not.toContain("주간회의 (회의록)");
  await page.selectOption("#mmScope", "all"); await page.click("#mindView [data-range='all']"); await page.click("#mmMake"); await expect.poll(() => ai.calls.filter(isMind).length).toBe(3);
  expect(ai.calls.filter(isMind).at(-1)!.prompt).toContain("작년 이야기");
});

test("오늘 범위에는 지금 대화도 들어감", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isMind(c) ? JSON.stringify(TREE) : "[]"));
  await open({ key: true });
  await startListening(page);
  await page.evaluate(() => (window as any).__say("오늘 회의에서 충방전기 채널 교정을 다음 주에 하기로 했습니다"));
  await page.click("#tabMind"); await page.click("#mindView [data-range='today']"); await page.click("#mmMake");
  await expect.poll(() => ai.calls.filter(isMind).length).toBe(1);
  expect(ai.calls.find(isMind)!.prompt).toContain("충방전기 채널 교정");
});

test("손잡이로 펼치기·접기, 모두 펼치기/접기, 주제 누르면 상세(관련 대목) → 이것에 대해 질문", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isMind(c) ? JSON.stringify(TREE) : c.prompt.includes("[질문]") ? "[보기] 없음\n정리입니다." : "[]"));
  await open({ key: true, storage: { "ms.webMode": "off" }, idbDocs: DOCS });
  await page.click("#tabMind"); await page.click("#mmMake"); await expect(nodes(page)).toHaveCount(9);
  await page.locator("#mmSvg [data-knob]").filter({ has: page.locator("text", { hasText: "2" }) }).click();
  await expect(nodes(page)).toHaveCount(11);
  await page.click("#mmCollapse"); await expect(nodes(page)).toHaveCount(1 + 3);
  await page.click("#mmExpand"); await expect(nodes(page)).toHaveCount(11);
  await page.locator("#mmSvg g.mmnode[data-id]", { hasText: "고객사 샘플" }).click();
  await expect(page.locator("#focusCard")).toContainText("1차 샘플 납기 11/20 확정");
  await expect(page.locator("#focusCard")).toContainText("SRC // 11/13 주간회의 (회의록)");
  await expect(page.locator("#focusCard")).toContainText("관련 대목");
  await expect(page.locator("#focusCard")).toContainText("고객사 샘플 납기 11/20 확정");
  await page.getByRole("button", { name: "이것에 대해 질문" }).click();
  await expect(page.locator("#liveView")).toBeVisible();
  await expect(page.locator("#field .callout.t-answer:not(.gone)").last()).toContainText("정리입니다.");
  expect(ai.calls.find((c) => c.prompt.includes("[질문]"))!.prompt).toContain("고객사 샘플에 대해 지금까지 나온 내용을 정리해줘");
});

test("기간·범위별로 저장되어 다시 열면 AI 없이 보이고, 펼친 상태도 유지", async ({ open, page }) => {
  const ai = await mockAI(page, (c) => (isMind(c) ? JSON.stringify(TREE) : "[]"));
  await open({ key: true, idbDocs: DOCS });
  await page.click("#tabMind"); await page.click("#mmMake"); await expect(nodes(page)).toHaveCount(9);
  await page.click("#mmExpand");
  await page.reload(); await expect(page.locator("html[data-docs='1']")).toHaveCount(1);
  await page.click("#tabMind");
  await expect(nodes(page)).toHaveCount(11);
  await expect(page.locator("#mmMeta")).toContainText("저장본");
  await page.click("#mindView [data-range='30']");
  await expect(page.locator("#mmEmpty")).toBeVisible();
  expect(ai.calls.filter(isMind)).toHaveLength(1);
});

test("끌어서 둘러보기, ctrl+휠 확대, PNG 저장, 개요 복사", async ({ open, page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockAI(page, (c) => (isMind(c) ? JSON.stringify(TREE) : "[]"));
  await open({ key: true, idbDocs: DOCS });
  await page.click("#tabMind"); await page.click("#mmMake"); await expect(nodes(page)).toHaveCount(9);
  const v = (await page.locator("#mmView").boundingBox())!;
  const tf = () => page.locator("#mmPlane").getAttribute("transform");
  const t0 = await tf();
  await page.mouse.move(v.x + 30, v.y + 30); await page.mouse.down(); await page.mouse.move(v.x + 180, v.y + 90, { steps: 5 }); await page.mouse.up();
  expect(await tf()).not.toBe(t0);
  const s0 = await app(page, "A.mindState.scale") as number;
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -300); await page.keyboard.up("Control");
  expect(await app(page, "A.mindState.scale")).toBeGreaterThan(s0);
  const dl = page.waitForEvent("download"); await page.click("#mmPng");
  expect(readFileSync(await (await dl).path()).subarray(1, 4).toString()).toBe("PNG");
  await page.click("#mmCopy");
  await expect(page.locator("#mmMeta")).toHaveText("개요를 복사했습니다.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("# 이번 주 — 샘플 납기와 IR 불량\n- 고객사 샘플 — 1차 샘플 납기 11/20 확정\n  - 납기 11/20 확정");
});

test("자료가 없거나 키가 없거나 AI 답이 깨지면 사람 말로", async ({ open, page }) => {
  await mockAI(page, (c) => (isMind(c) ? "죄송합니다 JSON이 아닙니다" : "[]"));
  await open({ key: true, idbDocs: DOCS });
  await page.click("#tabMind");
  await page.click("#mindView [data-range='today']"); await page.click("#mmMake");
  await expect(page.locator("#mmMeta")).toHaveText("오늘에 정리할 회의·대화 내용이 거의 없습니다.");
  await page.click("#mindView [data-range='7']"); await page.click("#mmMake");
  await expect(page.locator("#mmMeta")).toContainText("마인드맵 형식을 읽지 못했습니다");
});
