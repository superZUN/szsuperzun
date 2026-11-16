// Speaker split: the meeting is recorded (MP3, this device only), sent to Gemini once when the minutes are written,
// names guessed from the attendee list, editable, used by the minutes; the recording is deleted afterwards.
import { test, expect, startListening, app } from "../harness/fixtures";
import { mockAI, type AICall } from "../harness/ai-mock";
import type { Page } from "@playwright/test";

const ev = (page: Page, js: string) => page.evaluate(js);
const geminiAudio = (c: AICall) => (c.body?.contents?.[0]?.parts || []).find((p: any) => p.inline_data || p.file_data);
const isDiar = (c: AICall) => c.prompt.includes("말한 사람(화자)별로 나눠");
const isWrite = (c: AICall) => c.prompt.includes("당신은 회의록 작성자입니다");
const DIAR = `[00:01] 화자1: 샘플 납기는 11월 20일로 확정합니다.\n[00:05] 화자2: 그럼 박지은 님이 재측정 맡아 주세요.\n[00:08] 화자1: 네, 제가 하겠습니다.\n⟦화자⟧ {"speakers":[{"id":"화자1","name":"박지은","why":"'박지은 님' 부른 뒤 대답"},{"id":"화자2","name":"","why":""}]}`;
function mocks(page: Page, diar: () => any = () => DIAR) {
  return mockAI(page, (c) => {
    if (isDiar(c)) return diar();
    if (c.system.includes("최종 기록본으로 다듬으세요")) return c.prompt.split("[본문]\n")[1];
    if (isWrite(c)) return "# 주간회의\n## 결정 사항\n- 납기 11/20 확정 (박지은)\n## 할 일 (Action Items)\n| 할 일 | 담당 | 기한 |\n|---|---|---|\n| 재측정 | 박지은 | 미정 |";
    if (c.prompt.includes("회의록 검수자")) return '{"ok":true,"issues":[]}';
    return "[]";
  });
}
const STORE = { "ms.key.gemini": "AIza-test", "ms.fixOff": "1" };
async function meeting(page: Page, secs = 6) {
  await page.evaluate(() => { (document.getElementById("pPeople") as HTMLTextAreaElement).value = "박지은 (품질)\n김민수 팀장"; });
  await startListening(page);
  await expect.poll(() => app(page, "A.cloud.node != null")).toBe(true);
  await ev(page, "window.__mic.set({ voice: 1 })");
  for (const l of ["샘플 납기는 11월 20일로 확정합니다", "그럼 박지은 님이 재측정 맡아 주세요", "네 제가 하겠습니다"]) { await page.waitForTimeout((secs * 1000) / 3); await ev(page, `window.__say('${l}')`); }
  await expect(page.locator("#recIndicator")).toContainText("● 녹음 0:0");
  await ev(page, "window.__mic.set({ voice: 0 })"); await page.click("#startBtn");
}
const audioParts = (page: Page) => page.evaluate(() => new Promise<number>((res) => { const r = indexedDB.open("meeting-copilot"); r.onsuccess = () => { const q = r.result.transaction("audio").objectStore("audio").count(); q.onsuccess = () => { res(q.result); r.result.close(); }; }; }));

test("회의 녹음 → 회의록 작성 때 Gemini로 화자 구분 → 이름 추정·회의록에 반영 → 확정 후 녹음 삭제", async ({ open, page }) => {
  const ai = await mocks(page);
  await open({ key: true, storage: STORE });
  await meeting(page);
  expect(await app(page, "A.recInfo().sec")).toBeGreaterThanOrEqual(5);
  expect(await audioParts(page)).toBeGreaterThan(0);
  await page.click("#minutesBtn");
  await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 15000 });
  const d = ai.calls.find(isDiar)!; const part = geminiAudio(d).inline_data;
  expect(part.mime_type).toBe("audio/mp3");
  const mp3 = Buffer.from(part.data, "base64"); expect(mp3[0]).toBe(0xff); expect(mp3[1] & 0xe0).toBe(0xe0); // MPEG frame sync
  expect(d.prompt).toContain("[참석자] 박지은 (품질), 김민수 팀장");
  const w = ai.calls.find(isWrite)!;
  expect(w.prompt).toContain("[화자별 기록]\n[00:01] 박지은(화자1): 샘플 납기는 11월 20일로 확정합니다.");
  expect(w.prompt).toContain("[00:05] 화자2: 그럼 박지은 님이");
  expect(w.prompt).toContain("[화자별 기록]을 근거로");
  expect(w.prompt).not.toContain("발언자를 단정하지 마세요");
  await expect(page.locator("#minSpk input[data-spk='화자1']")).toHaveValue("박지은");
  await expect(page.locator("#minSpk input[data-spk='화자2']")).toHaveValue("");
  expect(await app(page, "A.S.docs.find(d => d.status === 'final').text.includes('## 부록: 화자별 기록 (회의 녹음)')")).toBe(true);
  await expect.poll(() => audioParts(page)).toBe(0); // deleted after the record was confirmed
  expect(await app(page, "A.usage().stt.calls")).toBe(1);
});

test("이름을 고쳐 '다시 작성'하면 Gemini를 다시 부르지 않고 새 이름으로 회의록", async ({ open, page }) => {
  const ai = await mocks(page);
  await open({ key: true, storage: STORE });
  await meeting(page);
  await page.click("#minutesBtn");
  await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 15000 });
  await page.locator("#minSpk input[data-spk='화자2']").fill("김민수"); await page.locator("#minSpk input[data-spk='화자2']").dispatchEvent("change");
  await page.getByRole("button", { name: "이름 바꿔 다시 작성" }).click();
  await expect.poll(() => ai.calls.filter(isWrite).length, { timeout: 15000 }).toBe(2);
  expect(ai.calls.filter(isWrite)[1].prompt).toContain("[00:05] 김민수(화자2): 그럼 박지은 님이");
  expect(ai.calls.filter(isDiar)).toHaveLength(1);
});

test("녹음이 길면 Gemini 파일 업로드로 보냄", async ({ open, page }) => {
  const ai = await mocks(page);
  let uploaded = 0;
  await page.route("https://generativelanguage.googleapis.com/upload/v1beta/files", (r) => r.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "x-goog-upload-url", "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload-session/s1" }, body: "{}" }));
  await page.route("https://generativelanguage.googleapis.com/upload-session/**", async (r) => { uploaded = (r.request().postDataBuffer() || Buffer.alloc(0)).length; await r.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ file: { name: "files/abc", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc", state: "ACTIVE" } }) }); });
  await open({ key: true, storage: STORE });
  await app(page, "(A.SPEAKERS.inlineMax = 10, 1)");
  await meeting(page);
  await page.click("#minutesBtn");
  await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 15000 });
  expect(uploaded).toBeGreaterThan(1000);
  expect(geminiAudio(ai.calls.find(isDiar)!).file_data).toEqual({ mime_type: "audio/mp3", file_uri: "https://generativelanguage.googleapis.com/v1beta/files/abc" });
});

test("Gemini 키가 틀리면 화자 구분 없이 회의록은 그대로 만들고 알림", async ({ open, page }) => {
  const ai = await mocks(page, () => ({ status: 403, error: "API key not valid" }));
  await open({ key: true, storage: STORE });
  await meeting(page);
  await page.click("#minutesBtn");
  await expect(page.locator("#minStage .stpill")).toHaveText("확정", { timeout: 15000 });
  expect(ai.calls.find(isWrite)!.prompt).toContain("발언자를 단정하지 마세요");
  await expect(page.locator("#minMsg")).toContainText("최종 회의록으로 확정했습니다");
  expect(await audioParts(page)).toBeGreaterThan(0); // not used → kept
});

test("대화 모드·키 없음·설정 끔이면 녹음하지 않음, '비우기'는 녹음도 지움", async ({ open, page }) => {
  await open({ storage: { "ms.appMode": "conv", "ms.key.gemini": "AIza-test" } });
  await startListening(page); await ev(page, "window.__mic.set({ voice: 1 })"); await page.waitForTimeout(1500);
  expect(await app(page, "A.recInfo().sec")).toBe(0); await expect(page.locator("#recIndicator")).toBeHidden();
  await page.click("#startBtn"); await page.click("#modeMeet");
  await page.click("#tabSet"); await page.uncheck("#recMeet"); await page.click("#tabLive");
  await startListening(page); await page.waitForTimeout(1500);
  expect(await app(page, "A.recInfo().sec")).toBe(0);
  await page.click("#startBtn"); await page.click("#tabSet"); await page.check("#recMeet"); await page.click("#tabLive");
  await startListening(page); await ev(page, "window.__say('녹음 시작 확인')"); await page.waitForTimeout(2500); await page.click("#startBtn");
  await expect.poll(() => audioParts(page)).toBeGreaterThan(0);
  await page.click("#rawBtn"); await page.click("#clearBtn");
  await expect.poll(() => audioParts(page)).toBe(0);
});
