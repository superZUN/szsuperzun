// Every prompt the app sends, in one place. Wording is the legacy app's (tuned through real use);
// changes are marked. Builders take plain inputs, so tests can check them through the AI mock.
//
// Cache layout (Claude): `system` = the part that stays identical call after call (instructions + full Formation
// dictionary + user glossary), `prompt` = what changes (the conversation, terms heard, meeting info).
import { todayLine } from "./client";
import { glossBlock, glossStable, glossVarying } from "../library/dict";

export const MODE: Record<string, string> = {
  general: "일반 업무 회의. 결정사항, 숫자, 일정, 담당자를 놓치지 않게 돕는다.",
  english: "영어로 진행되는 회의. 사용자는 한국어 화자다. 어려운 영어 표현·관용구·약어의 뜻을 한국어로 짧게 풀고, 사용자가 쓸 만한 영어 응답 문장을 제안한다.",
  tech: "기술 논의. 전문 용어, 단위, 수치, 표준·규격을 짧게 설명하고 앞뒤가 맞지 않는 수치를 짚는다.",
  client: "고객·협력사 미팅. 과거 회의에서 합의한 내용과 지금 발언이 다른 부분, 약속·리스크를 짚는다.",
  conv: "자유 대화. 일, 일상, 취미, 여행, 음식, 뉴스, 아이들 이야기 등 무엇이든 나올 수 있고 모두 정상적인 대화다. 대화에 나온 것에 대해 곁에서 알면 좋은 정보(배경, 의미, 수치, 최근 소식, 재미있는 사실)를 짧은 메시지로 건넨다.",
};

/** remarks that judge the conversation instead of helping with it — such cards are dropped */
export const OFFTOPIC = /무관|관련(이)?\s*없|관계(가)?\s*없|상관(이)?\s*없|주제(와|에서)\s*(다르|벗어|무관)|회의\s*(주제|안건)(와|과|에서)|잡담|오프\s*토픽|off[- ]?topic|맥락(이|을)?\s*(파악할 수 없|불분명|없)|내용이\s*(부족|불분명)|판단하기\s*어렵|알 수 없는\s*(대화|내용)/i;

/* ---------------- live analysis ---------------- */
export interface AnalyzeIn {
  conv: boolean; daily: boolean; work: boolean; meetingType: string; visAuto: boolean;
  fresh: string; recent: string; past: string; shown: string[]; meetingBlock: string; focusBlock: string;
}
export function analyzePrompt(a: AnalyzeIn): { system: string; prompt: string } {
  const { conv, daily, work } = a;
  const system = `${conv ? "사용자가 누군가와 대화하는 동안 옆에서 돕는 비서 Jay. " + MODE.conv : "회의 중 사용자 옆에서 돕는 비서 Jay. 회의 유형: " + (MODE[a.meetingType] || MODE.general)}
[최근 대화]는 실시간 음성 인식(오인식 가능). [새로 들어온 부분]의 맥락을 파악해, 사용자가 지금 바로 알면 좋은 것을 짧은 메시지로 던진다.${daily ? `
- 이것은 회의가 아니라 그냥 대화다. 주제가 회의·업무·배터리와 상관없어도 정상이다. '주제와 무관', '회의와 관련 없음', '잡담', '오프토픽' 같은 지적·경고·평가는 절대 하지 말 것.
- 대화의 흐름에 맞춰 도움이 되는 정보만 건넨다. 인사·맞장구·짧은 잡담처럼 덧붙일 게 없으면 kw도 빈 문자열로 두고 카드 없이 끝낸다.
- 용어 사전·지난 회의 발췌는 지금 대화가 정말 그 내용을 말할 때만 쓰고, 일상 단어를 전문 용어로 끌어다 붙이지 말 것.` : ""}${work ? `
- 대화 도중 업무 이야기가 나오고 있다. 이 대목은 회의처럼 다룬다: 결정·숫자·일정·담당·약속을 정확히 짚고, 용어 사전·[지난 회의 발췌]와 연결하고, 오인식된 전문 용어는 바로잡아 이해한다.
- 그래도 회의는 아니니 '주제와 무관' 같은 평가는 하지 말 것. 업무와 섞여 나오는 일상 이야기는 그냥 넘긴다.` : ""}${conv ? `
- 첫 원소에 "topic"을 넣는다: [새로 들어온 부분]이 일·업무(회사, 고객, 생산, 품질, 일정, 돈, 결정 등) 이야기면 "work", 그 밖의 일상 이야기면 "daily".` : ""}
- ${todayLine()} 최신 제품·가격·직책·순위·뉴스처럼 시간이 지나면 바뀌는 사실은 기억으로 단정하지 말 것('최신은 ○○' 같은 말 금지). 그런 대상은 kw로만 넘긴다(웹 검색이 따로 확인한다).
- 질문을 제안하지 말 것. '~를 물어보세요', '~를 확인해 보세요' 같은 권유 금지. 대신 정보·사실·연결고리를 직접 말한다.
- 첫 원소는 반드시 {"type":"kw","title":"이 대목의 핵심 키워드 1~3개를 쉼표로"} (고유명사·전문용어·제품·숫자가 붙은 대상 위주).
- 그다음 카드 최대 2개. type: ${daily ? "info(배경·의미·관련 정보·재미있는 사실) term(낯선 용어 풀이) fact(수치·사실·최근 소식) past(지난 회의·자료와 분명히 같은 이야기일 때만, source에 이름)" : "info(맥락 요약·배경 정보·의미) term(용어 풀이) fact(수치·사실·계산) past(지난 회의 내용과의 연결·달라진 점, [지난 회의 발췌]에 있는 것만, source에 회의 이름) risk(놓치면 곤란한 약속·모순) action(새로 정해진 할 일: title=할 일, owner, due, body=한 줄)"}
- title 18자 안팎, body 1~2문장, 한국어. 이미 보여준 것과 겹치면 빼고, 쓸 게 없으면 kw만.
JSON 배열만: [{"type":"kw","title":""${conv ? ',"topic":"daily|work"' : ""}},{"type":"","title":"","body":"","source":""${daily ? "" : ',"owner":"","due":""'}}]
${glossStable()}`;
  // changed from legacy: the visual option moved here (it switches on and off by the minute, so it must not break the cache)
  const prompt = `${a.visAuto ? '- 이번에는 type visual도 쓸 수 있다: 지금 대목이 공정 흐름·구조·인과·단계·비교처럼 그림 한 장이 말보다 훨씬 이해를 돕는 경우에만. title=그릴 대상, body=무엇을 어떤 그림으로 그릴지 한 줄\n' : ""}${glossVarying(a.fresh + " " + a.recent.slice(-300), { maxDefs: 4 })}${conv ? "" : a.meetingBlock}${a.focusBlock}${daily ? "[대화 상대 정보·안건 없음 — 회의 기준으로 판단하지 말 것]\n" : ""}[이미 보여준 것] ${a.shown.slice(-12).join(" / ") || "(없음)"}
${a.past ? "\n[지난 회의 발췌]\n" + a.past + "\n" : ""}
[최근 대화]
${a.recent}

[새로 들어온 부분]
${a.fresh || a.recent.slice(-300)}`;
  return { system, prompt };
}

/* ---------------- live transcript corrector ---------------- */
export function fixPrompt(o: { daily: boolean; conv: boolean; before: string; lines: string[] }): { system: string; prompt: string } {
  const system = `당신은 실시간 음성 인식 받아쓰기 교정기입니다. [교정할 문장]의 각 줄은 ${o.daily ? "일상 대화(어떤 주제든 가능)" : o.conv ? "대화(지금은 업무 이야기)" : "회의 대화"}를 음성 인식한 결과입니다.${o.daily ? "\n일상 대화이므로 용어 사전 단어로 바꾸는 것은 문맥상 그 전문 용어가 분명할 때만 하세요. 평범한 말을 전문 용어로 바꾸지 마세요." : ""}
바로잡을 것: 발음이 비슷해 잘못 받아쓴 단어, 용어 사전에 있는 고유 용어의 표기, 숫자·단위 표기(예: 팔십 프로 → 80%, 삼호기 → 3호기), 띄어쓰기.
하지 말 것: 말한 내용을 바꾸거나 요약·보충·번역하기, 존댓말·어순 다듬기. 확신이 없으면 그대로 둡니다.
줄 수와 순서를 그대로 지켜 JSON 문자열 배열만 출력하세요. 예: ["첫 줄","둘째 줄"]
${glossStable()}`;
  const prompt = `${glossVarying(o.before + " " + o.lines.join(" "), { defs: false })}
[앞 문맥 (교정하지 말 것)]
${o.before || "(없음)"}

[교정할 문장]
${o.lines.map((s, i) => i + 1 + ". " + s).join("\n")}`;
  return { system, prompt };
}

/* ---------------- keyword web search ---------------- */
export const keywordSearchPrompt = (k: string, ctx: string) =>
  `${todayLine()}\n대화 중 나온 키워드 "${k}"에 대해 반드시 웹 검색을 해서 최신·정확한 정보를 찾아, 지금 대화에 바로 도움이 되도록 한국어 2문장으로 요약하세요. 대화 맥락: ${ctx || "(없음)"}. 머리말·출처 목록 없이 본문만 쓰세요.`;

/* ---------------- questions ---------------- */
export const TIME_RE = /최신|최근|요즘|현재|지금\s*(나와|파는|쓰는|기준|시점)|올해|작년|내년|이번\s*(달|주|해|분기)|가격|얼마|시세|환율|주가|금리|출시|발표|신제품|새로\s*나온|신형|몇\s*세대|모델명|뉴스|소식|순위|1위|대표|사장|회장|ceo|대통령|총리|장관|결과|우승|날씨|버전|업데이트|latest|newest|current|price|release/i;
export const timeSensitive = (q: string) => TIME_RE.test(q);
export const needsThinking = (q: string) => /계산|몇\s*(%|퍼|개|배|분|시간)|퍼센트|비율|평균|합계|총합|차이가|얼마나|환산|곱하|나누|증감|추정|비교해서/.test(q);
export interface AskIn {
  q: string; conv: boolean; convWork: boolean; launched: boolean; canSearch: boolean; tail: string; full: string;
  focusBlock: string; meetingBlock: string; notes: string; prev: string; pastBlock: string; earlier: string;
}
export function askPrompt(a: AskIn): { system: string; prompt: string } {
  const system = glossStable();
  const prompt = `당신은 사용자 곁의 비서 Jay입니다. ${a.conv ? "사용자가 누군가와 대화하면서 휴대폰으로 빠르게 묻는 질문입니다. 질문의 의도(무엇을 알고 싶은지, 무엇을 보고 싶은지)를 먼저 파악하세요. 일·업무에 관한 질문이면 회의록·자료·용어 사전을 근거로 정확히 답하고, 일상적인 질문이면 회의록·용어 사전과 억지로 엮지 말고 그냥 답하세요. '대화 주제와 관련 없다' 같은 말은 하지 마세요." + (a.convWork ? " (지금은 업무 이야기 중)" : "") : "회의 중인 사용자가 휴대폰을 보며 빠르게 묻는 질문입니다."} 한국어로 답하세요.
- 맨 첫 줄에는 화면에 함께 띄울 것을 하나만 쓰세요: [보기] 없음 / [보기] 사진: 검색어 / [보기] 다이어그램: 그릴 내용 / [보기] 도면: 그릴 대상 / [보기] 차트: 그릴 내용.
  사진=실물·제품·장소·생김새가 궁금할 때, 다이어그램=과정·구조·관계, 도면=형상·단면·부품 배치, 차트=숫자 비교·추이. 글로 충분하면 없음.${a.launched ? " (이번 질문의 그림은 이미 띄우고 있으니 [보기] 없음)" : ""}
- ${todayLine()}${timeSensitive(a.q) ? (a.canSearch ? " 이 질문은 시점에 따라 답이 바뀌는 질문이니, 기억으로 답하지 말고 반드시 웹 검색을 먼저 한 뒤 검색 결과로 답하세요." : " 이 질문은 시점에 따라 답이 바뀌는데 지금은 웹 검색을 쓸 수 없으니, 아는 범위로 답하되 끝에 '(학습 시점 기준 — 최신 정보는 확인 필요)'를 붙이세요.") : ""}
- 이 질문이 회의·대화·자료 내용에 관한 것인데 아래 자료에서 답을 찾지 못했으면, 답 맨 끝에 ⟪더찾기⟫ 를 붙이세요(앱이 더 넓게 찾아 봅니다). 일반 지식·웹으로 답한 질문에는 붙이지 마세요.
- 둘째 줄부터 답. 첫 문장에 바로 결론, 필요하면 근거 1~3개. 전체 5문장 이내. 그림만 원하는 요청이면 한 줄 설명으로 끝내세요.
- 근거 뒤에 출처를 괄호로: (지금 대화 HH:MM) / (회의록: 이름) / (메모) / (용어 사전)${a.canSearch ? " / (웹: 사이트명)" : ""}.
${a.canSearch ? "- 이번 대화·회의록 자료에 답이 있으면 그것으로 답하세요. 자료에 없으면 '자료에 없다'는 말은 하지 말고 곧바로 웹 검색을 한 번 해서 답하세요. 웹에도 없으면 모른다고 짧게 말하세요. 지어내지 마세요." : "- 자료에 없으면 '자료에 없다'는 말 없이 일반 지식으로 바로 답하세요. 확실하지 않은 수치는 지어내지 마세요."}
- 받아쓰기는 음성 인식이라 오인식이 있으니 용어 사전을 보고 바로잡아 이해하세요.
- '방금', '아까', '그거'처럼 가리키는 말은 [최근 대화]와 [이전 질문과 답]으로 해석하세요.
${glossVarying(a.q + " " + a.tail.slice(-800), { maxDefs: 6 })}${a.focusBlock}${a.conv ? "" : a.meetingBlock}${a.notes ? "\n[사용자 메모]\n" + a.notes + "\n" : ""}
${a.prev ? "[이전 질문과 답]\n" + a.prev + "\n\n" : ""}[과거 회의록 발췌]
${a.pastBlock}
${a.earlier ? "\n[이번 대화 앞부분 중 질문과 관련된 대목]\n" + a.earlier + "\n" : ""}
[최근 대화]
${a.tail || "(아직 받아쓴 대화 없음)"}

[질문]
${a.q}`;
  return { system, prompt };
}
export const ASK_RETRY_SEARCH = "\n\n[중요] 앞선 답은 웹 검색 없이 기억으로 썼습니다. 이번에는 반드시 web_search 도구로 먼저 검색하고, 검색 결과에 근거해 답하세요.";

/* ---------------- deep (wide) search ---------------- */
export const deepExpandPrompt = (q: string) => `회의록과 대화 기록에서 아래 질문의 답을 찾으려 합니다. 기록에는 질문과 다른 말로 적혀 있을 수 있습니다.
같은 뜻의 다른 표현, 관련 전문용어(한국어·영어·약어), 관련 대상·사람·숫자 단위를 12~18개 만들어 쉼표로만 출력하세요.
${glossBlock(q, { defs: false, fullBase: false })}질문: ${q}`;
export function deepAnswerPrompt(o: { q: string; terms: string[]; mat: string; conv: { text: string; all?: boolean }; tail: string; canSearch: boolean }) {
  return `사용자가 회의·대화 중에 물은 질문입니다. 빠른 검색으로는 답이 부족해서, 같은 뜻의 다른 표현까지 넓혀 회의록·자료 전체와 지금 대화 전체에서 관련 대목을 모았습니다. 이 자료를 모두 살펴 한국어로 답하세요.
- ${todayLine()}
- 첫 문장에 결론. 여러 회의·자료에 흩어진 내용이면 시간 순서로 묶어 정리하고, 바뀐 점이 있으면 짚으세요. 전체 8문장 이내.
- 근거마다 출처를 괄호로: (회의록: 이름) / (지금 대화 HH:MM)${o.canSearch ? " / (웹: 사이트명)" : ""}.
- 넓게 찾아도 자료에 없으면 '회의록·대화 어디에도 없습니다'라고 분명히 말하세요${o.canSearch ? ". 외부·일반 정보가 필요한 질문이면 그때 웹 검색을 한 번 쓰세요" : ""}. 지어내지 마세요.
${glossBlock(o.q + " " + o.terms.join(" "), { maxDefs: 6 })}
[넓힌 검색어] ${o.terms.join(", ") || "(없음)"}

[넓게 찾은 회의록·자료 발췌]
${o.mat || "(찾은 것 없음)"}

[지금 대화에서 찾은 대목${o.conv.all ? " — 대화 전체" : ""}]
${o.conv.text || "(없음)"}

[최근 대화]
${o.tail || "(없음)"}

[질문]
${o.q}`;
}

/* ---------------- pictures ---------------- */
export function diagramPrompt(o: { subject: string; ctx: string; answer?: string; kind: "diagram" | "chart" }) {
  const what = o.kind === "chart" ? `차트: xychart-beta(막대·선, 숫자 비교·추이) 또는 pie(비율). [자료]에 나온 숫자만 쓰고, 숫자가 없으면 대신 flowchart로 관계를 그리세요.` :
    `종류 하나: flowchart LR/TD(공정·절차·인과·구조), sequenceDiagram(주고받는 순서), stateDiagram-v2(상태 변화), mindmap(개념 정리), timeline(일정).`;
  return `[그릴 것]을 Mermaid 다이어그램 하나로 그리세요. ${what}
- 노드 4~12개, 라벨은 짧은 한국어(전문용어는 영어 병기 가능). flowchart 라벨은 A["라벨"]처럼 큰따옴표로.
- [자료]와 확실한 일반 지식만. 모르는 수치는 넣지 마세요.
- Mermaid 코드만 출력(설명·\`\`\` 없이, 첫 줄은 다이어그램 종류).
${glossBlock(o.subject, { maxDefs: 3, fullBase: false })}${o.answer ? "[참고 답변]\n" + o.answer.slice(0, 600) + "\n" : ""}[자료 — 최근 대화]
${(o.ctx || "(없음)").slice(-600)}

[그릴 것]
${o.subject}`;
}
export const diagramRetry = (code: string, err: string) => `\n\n[이전 코드 — 오류가 났으니 문법을 고쳐 다시 출력]\n${code}\n[오류]\n${err.slice(0, 300)}`;
export const drawingPrompt = (subject: string, ctx: string) => `[그릴 것]의 형상·단면·구조를 보여 주는 간단한 기술 도면을 SVG 하나로 그리세요.
- <svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg"> 로 시작. 배경은 칠하지 말 것(투명).
- 선 #6FE7FF(굵기 1.5~2), 면은 fill="#0b2a33" 또는 반투명 rgba(111,231,255,.12), 강조 #FFB547, 글자 #E6F6FA 14~16px.
- 부품마다 지시선과 한국어 라벨(전문용어는 영어 병기 가능). 실제 치수를 확실히 알 때만 치수선을 넣고, 모르면 넣지 마세요.
- <script>, 이미지, 외부 링크 금지. 요소는 앞에서부터 큰 윤곽 → 세부 → 라벨 순서로.
- SVG 코드만 출력(설명·\`\`\` 없이).
${glossBlock(subject, { maxDefs: 3, fullBase: false })}[자료 — 최근 대화]
${(ctx || "(없음)").slice(-500)}

[그릴 것]
${subject}`;

/* ---------------- minutes ---------------- */
export function revisePrompt(part: string, before: string, after: string): { system: string; prompt: string } {
  const system = `아래 [본문]은 회의를 실시간 음성 인식으로 받아쓴 기록입니다. 앞뒤 맥락과 용어 사전을 보고 최종 기록본으로 다듬으세요.
바로잡을 것: 발음이 비슷해 잘못 받아쓴 단어, 고유명사·전문용어 표기(용어 사전 기준), 숫자·단위·날짜 표기, 띄어쓰기, 문장 부호.
지킬 것: 말한 내용·순서·의미를 바꾸지 말고 요약·삭제·추가하지 마세요. 뜻을 확정할 수 없는 부분은 그대로 두고 뒤에 (?)를 붙이세요. ⟦ ⟧ 표시와 [시각] 표시는 그대로 두세요.
다듬은 [본문]만 출력하세요.
${glossStable()}`;
  const prompt = `${glossVarying(part, { defs: false })}
[앞 맥락 — 출력하지 말 것]
${before || "(없음)"}
[뒤 맥락 — 출력하지 말 것]
${after || "(없음)"}

[본문]
${part}`;
  return { system, prompt };
}
export interface MinutesIn {
  text: string; title: string; conv: boolean; hasFocus: boolean; template: string; hasPeople: boolean; hasAgenda: boolean; hasCarry: boolean;
  typeLabel: string; when: string; actualMin: number; plannedMin: number; facts: string; cards: string; past: string;
  /** "[MM:SS] 이름(화자N): …" from the meeting recording, when there is one */
  speakers?: string;
}
export function minutesPrompt(m: MinutesIn) {
  const focusRule = m.hasFocus ? `
중요 표시와 메모
- [받아쓰기]의 ⟦중요 구간 시작⟧~⟦중요 구간 끝⟧은 사용자가 회의 중 '중요' 버튼을 눌러 표시한 부분(누른 시점 앞뒤 30초)이고, ⟦사용자 메모⟧는 사용자가 직접 적은 메모입니다.
- 이 둘은 회의록에서 가장 중요하게 다루세요. 개요 바로 다음에 '## ★ 중요 내용' 절을 두고, 중요 구간마다 무엇이 논의·결정됐는지 시각과 함께 정리하고, 메모는 원문 그대로 살려 반영하세요.
- 다른 절(결정 사항, 할 일 등)에서도 중요 구간·메모에서 나온 항목 앞에는 ★를 붙이세요.
- 메모가 받아쓰기와 다르면 메모를 더 신뢰하되, 차이가 있으면 '(확인 필요)'로 표시하세요.` : "";
  const format = m.template ? `아래 [회사 양식]의 구성과 순서를 그대로 따르세요.${m.hasFocus ? " 양식에 중요 내용 항목이 없으면 맨 앞에 '★ 중요 내용' 절을 추가하세요." : ""}\n[회사 양식]\n${m.template.slice(0, 3000)}` :
    `다음 구성으로 쓰세요.
# ${m.title}
- 일시 / ${m.conv ? "대화" : "회의 유형"} / 주요 주제 (한 줄씩)${m.hasPeople ? " / 참석자" : ""}${m.hasFocus ? "\n## ★ 중요 내용\n(중요 표시 구간과 사용자 메모. 시각 포함)" : ""}
## 결정 사항
## 할 일 (Action Items)
| 할 일 | 담당 | 기한 |
## 주요 논의 내용
(${m.hasAgenda ? "[안건] 순서대로 ### 안건명, 아래 글머리표. 다루지 못한 안건은 '(미논의)'로 표시" : "안건별로 ### 소제목, 아래 글머리표"})
## 미결 사항 · 다음에 확인할 것${m.hasCarry ? "\n## 지난 회의 할 일 점검\n| 할 일 | 담당 | 상태 |" : ""}
## 지난 회의와 달라진 점
(과거 회의록 발췌와 비교해 바뀐 합의가 있을 때만. 없으면 이 절은 빼세요.)`;
  const spk = !!m.speakers;
  return `당신은 회의록 작성자입니다. 아래 [받아쓰기]는 실시간 음성 인식 기록을 맥락에 맞게 한 번 교정한 회의 대화 기록이며, 누가 말했는지는 구분되어 있지 않습니다.${spk ? " [화자별 기록]은 같은 회의의 녹음을 말한 사람별로 나눠 받아쓴 것입니다(이름은 추정이며 사용자가 확인함)." : ""} 이를 바탕으로 한국어 회의록을 Markdown으로 작성하세요.

규칙
- 원문에 근거한 내용만 쓰세요. 추측으로 채우지 마세요. 불분명하면 '(확인 필요)'를 붙이세요.
${spk ? "- 누가 무엇을 말했는지는 [화자별 기록]을 근거로 쓰세요. 이름이 붙은 화자는 그 사람의 발언으로, 이름 없는 화자는 '화자N'으로 적으세요. 결정·할 일마다 제안하거나 맡은 사람을 적고, 기한은 대화에 날짜가 나온 경우에만(없으면 '미정')." : "- 발언자를 단정하지 마세요. 담당자와 기한은 대화에 실제로 이름·날짜가 나온 경우에만 채우고, 없으면 '미정'으로 쓰세요."}
- (?)가 붙은 말은 확정되지 않은 표현이니 회의록에 옮길 때 '(확인 필요)'로 표시하세요.
- 잡담·반복·추임새는 빼고, 결정과 숫자·일정은 빠짐없이 담으세요.
- 문장은 간결한 개조식으로 쓰세요.
- Markdown 제목(#), 글머리표(-), 표(|)만 쓰세요. 회의록 본문만 출력하세요. ⟦ ⟧ 표시는 회의록에 그대로 옮기지 마세요.
${focusRule}

${format}

회의 정보: 제목 "${m.title}", 일시 ${m.when}, 유형 ${m.typeLabel}${m.actualMin ? `, 실제 ${m.actualMin}분` : ""}${m.plannedMin ? ` (예정 ${m.plannedMin}분)` : ""}
${m.facts}
${glossBlock(m.text, { maxDefs: 25 })}
[회의 중 띄운 분석 카드 (참고용)]
${m.cards || "(없음)"}

[과거 회의록 발췌 (참고용)]
${m.past}
${spk ? `\n[화자별 기록]\n${m.speakers!.length > 80000 ? m.speakers!.slice(-80000) : m.speakers}\n` : ""}
[받아쓰기]
${m.text}`;
}
export const verifyPrompt = (minutes: string, text: string, speakers = "") => `당신은 회의록 검수자입니다. [회의록]이 [받아쓰기]${speakers ? "와 [화자별 기록]" : ""}에 충실한지 검사하세요.${speakers ? " 발언자·담당자 이름은 [화자별 기록]에 그 이름으로 나오면 근거가 있는 것으로 봅니다." : ""}
문제로 볼 것: 받아쓰기에 없는 내용(지어낸 사실), 숫자·날짜·이름·담당자 오류, 받아쓰기에 분명히 나온 결정·할 일·숫자의 누락, ⟦ ⟧ 표시가 그대로 남은 것, 깨진 형식.
문제로 보지 않을 것: 표현 차이, 요약 수준, '(확인 필요)' 표시, 사소한 문체.
JSON 하나만 출력: {"ok":true|false,"issues":["문제를 한 줄씩, 최대 6개"]}
${glossBlock(text.slice(0, 4000), { defs: false, fullBase: false })}
[회의록]
${minutes}

${speakers ? `[화자별 기록]\n${speakers.slice(-60000)}\n\n` : ""}[받아쓰기]
${text.length > 100000 ? text.slice(-100000) : text}`;
export const fixMinutesPrompt = (issues: string[], minutes: string, revised: string) => `[검수 결과]의 문제를 고쳐 회의록 전체를 다시 출력하세요. 받아쓰기에 근거한 내용만 쓰고, 근거가 없으면 지우거나 '(확인 필요)'로 표시하세요. 회의록 본문만 출력하세요.
[검수 결과]
${issues.map((x) => "- " + x).join("\n")}

[회의록]
${minutes}

[받아쓰기]
${revised.length > 100000 ? revised.slice(-100000) : revised}`;

export function checkPrompt(o: { ann: string; hasCarry: boolean; title: string; elapsedMin: number; plannedMin: number; facts: string; current: string }) {
  return `당신은 회의 진행자를 돕는 비서입니다. 회의를 끝내기 전에 놓친 것이 없는지 '마무리 점검' 목록을 한국어 Markdown으로 짧게 만드세요.
다음 절을 이 순서로 쓰고, 해당 사항이 없으면 '- 없음'으로 쓰세요. 근거 없는 내용은 쓰지 마세요.
## 다루지 않았거나 결론이 안 난 안건
## 담당·기한이 빠진 할 일
## 결론 없이 끝난 논의
${o.hasCarry ? "## 지난 회의 할 일 점검 (진행 상황이 언급되지 않은 항목)\n" : ""}## 끝내기 전에 물어볼 것
(최대 3개. 진행자가 그대로 읽을 수 있는 짧은 질문 문장)
${glossBlock(o.ann.slice(-6000), { maxDefs: 10 })}
회의 정보: ${o.title}, 경과 ${o.elapsedMin}분${o.plannedMin ? ` / 예정 ${o.plannedMin}분` : ""}
${o.facts}${o.current ? `\n지금 진행 중인 안건: ${o.current}` : ""}

[받아쓰기 (⟦⟧는 안건 시작·사용자 메모·중요 표시)]
${o.ann.length > 60000 ? "(앞부분 생략)\n" + o.ann.slice(-60000) : o.ann}`;
}
export const mailPrompt = (minutes: string, people: string[]) => `아래 회의록으로 참석자에게 보낼 후속 메일 초안을 한국어 비즈니스 메일로 쓰세요.
- 첫 줄은 '제목: '으로 시작하는 제목, 한 줄 띄고 본문.
- 본문: 짧은 인사 → 회의 요약 2~3줄 → 결정 사항 → 할 일(담당·기한, 목록) → 다음 단계·회신 요청 → 맺음말. 서명은 '[이름]'으로 남기세요.
- Markdown 기호(#, |, **) 없이 일반 텍스트로. 회의록에 없는 내용은 쓰지 마세요.
${people.length ? "참석자: " + people.join(", ") : ""}

[회의록]
${minutes}`;

/* ---------------- one day's summary (하루 요약) + term candidates ---------------- */
export const TERMS_MARK = "⟦용어⟧";
export const daySummaryPrompt = (day: string, log: string) => `아래 [하루 대화 기록]은 사용자(배터리 셀 Formation·EOL 엔지니어)가 ${day} 하루 동안 회의·업무 대화·일상 대화를 실시간 음성 인식으로 받아쓴 기록입니다(오인식이 섞여 있음). 줄마다 [시각] (회의|업무|일상|메모|질문|답) 표시가 있습니다.
나중에 다시 찾아보고 기억하기 좋게 한국어 Markdown으로 정리하세요.
# ${day} 하루 요약
## 한 줄 요약
## 업무 — 결정·약속·숫자 (시각 포함)
## 할 일 후보 (할 일 / 담당 / 기한 — 대화에 나온 것만)
## 사람·일상에서 기억할 것 (약속, 가족·지인 일정, 관심사)
## 새로 알게 된 것·용어
## 다음에 확인할 것
규칙: 기록에 있는 것만 쓰고 지어내지 마세요. 불확실하면 '(확인 필요)'. 해당 없는 절은 '- 없음'. 개조식으로 짧게.
맨 끝에 ${TERMS_MARK} 를 쓰고, 그 뒤에 용어 사전에 넣을 만한 후보를 JSON 한 줄로: {"terms":[{"term":"올바른 표기","note":"짧은 설명","wrong":["받아쓰기에서 틀리게 나온 형태"]}]} — 회사·제품·사람 이름, 전문 용어, 자주 틀리게 받아써진 말 위주로 최대 8개. 없으면 {"terms":[]}.
${glossBlock("", { defs: false })}
[하루 대화 기록]
${log}`;

/* ---------------- mind map of everything said ---------------- */
export const mindmapPrompt = (rangeLabel: string, scope: string, material: string) => `아래 [자료]는 사용자(배터리 셀 Formation·EOL 엔지니어)의 ${rangeLabel} 회의록·하루 요약·대화 기록입니다(음성 인식이라 오인식이 섞여 있음).
이 내용을 한눈에 보는 마인드맵으로 정리하세요. 범위: ${scope === "work" ? "업무 이야기만" : scope === "daily" ? "일상 이야기만(업무는 빼기)" : "업무와 일상 모두"}.
- 가운데 주제(title)는 기간을 한 줄로 요약한 말.
- 첫 단계 가지 5~9개: 프로젝트·고객사·품질 이슈·일정·사람·일상처럼 실제로 많이 나온 큰 주제. 비슷한 것은 하나로 합치세요.
- 각 가지 아래 2~6개, 최대 4단계. 결정·숫자·날짜·담당은 잎(leaf)에 구체적으로.
- t(라벨)는 18자 이내 명사형, n(설명)은 한 문장(선택), s는 근거가 된 자료 이름 목록(<<이름>>에 있는 것, 최대 3개).
- 자료에 있는 것만. 지어내지 마세요.
JSON 하나만 출력: {"title":"","children":[{"t":"","n":"","s":[""],"c":[{"t":"","n":"","s":[""],"c":[]}]}]}

[자료]
${material}`;

/* ---------------- speakers (Gemini, whole meeting recording) ---------------- */
export const SPK_MARK = "⟦화자⟧";
export const speakersPrompt = (people: string[], hints: string[]) => `이 회의 녹음 전체를 말한 사람(화자)별로 나눠 받아쓰세요.
- 줄마다 형식: [MM:SS] 화자N: 말한 내용   (MM:SS는 녹음 시작부터의 시각, N은 1부터. 같은 사람은 녹음 끝까지 같은 번호)
- 한국어와 영어가 섞이면 들린 언어 그대로, 영어 용어는 영어 철자로. 숫자·단위는 아라비아 숫자로. 아래 [용어] 표기를 따르세요.
- 추임새·잡음은 빼되 내용은 요약하지 말고 말한 그대로.
- 맨 끝에 ${SPK_MARK} 를 쓰고 그 뒤에 JSON 한 줄: {"speakers":[{"id":"화자1","name":"추정 이름 또는 빈 문자열","why":"그렇게 본 근거 한 줄"}]}
  이름은 [참석자] 명단과 대화 맥락(이름을 부르고 그 사람이 대답함, 자기소개 등)으로 확실할 때만. 모르면 "".
[참석자] ${people.length ? people.join(", ") : "(명단 없음)"}
[용어] ${hints.join(", ")}`;

/* ---------------- 업무 tab: morning briefing, weekly report, questions over every record ---------------- */
const ROLE = "사용자(배터리 셀 Formation·EOL 엔지니어)";
export const briefPrompt = (o: { today: string; weekday: string; tasks: string; lastDay: string; lastText: string }) => `오늘은 ${o.today}(${o.weekday})입니다. ${ROLE}의 아침 브리핑을 한국어 Markdown으로 짧게 쓰세요. 출근길에 1분 안에 읽을 분량입니다.
## 오늘 꼭 챙길 것
(기한 지남·오늘·내일 기한인 할 일과, 어제 기록에서 오늘 해야 한다고 한 것 — 최대 5개, 중요한 순)
## ${o.lastDay ? o.lastDay + " " : ""}핵심
(결정·약속·숫자 위주 최대 4개)
## 오늘 준비하면 좋은 것
(회의 준비, 확인할 자료, 연락할 사람 — 최대 3개, 근거가 있을 때만)
규칙: [할 일]과 [지난 기록]에 있는 것만 쓰고 지어내지 마세요. 해당 없는 절은 '- 없음'. 개조식, 한 줄에 한 가지, 담당·기한·숫자는 그대로.
[할 일]
${o.tasks || "(없음)"}
[지난 기록${o.lastDay ? " — " + o.lastDay : ""}]
${o.lastText || "(없음)"}`;

export const weeklyReportPrompt = (o: { label: string; material: string; done: string; added: string; open: string }) => `아래는 ${ROLE}의 ${o.label} 한 주 동안의 회의록·하루 요약·대화 기록(음성 인식이라 오인식이 섞여 있음)과 할 일 목록입니다.
이것으로 팀장에게 낼 '주간 업무보고'를 한국어 Markdown으로 쓰세요. 회사 보고서 문체(~함, ~예정)로 간결하게.
# 주간 업무보고 (${o.label})
## 1. 이번 주 요약
(3줄 이내)
## 2. 주요 업무 진행
(업무·프로젝트·고객사별로 묶어 '- 항목: 진행 내용 → 결과/현황' — 숫자·날짜·담당 그대로)
## 3. 회의·결정 사항
## 4. 완료한 일
## 5. 다음 주 계획
(진행 중인 할 일과 기록에 나온 다음 단계)
## 6. 이슈·리스크 / 지원 요청
규칙: 자료에 있는 것만 쓰고 지어내지 마세요. 일상·사적인 이야기는 빼세요. 불확실하면 '(확인 필요)'. 해당 없는 절은 '- 없음'.
[이번 주 끝낸 할 일]
${o.done || "(없음)"}
[이번 주 새로 생긴 할 일]
${o.added || "(없음)"}
[진행 중인 할 일]
${o.open || "(없음)"}
[자료]
${o.material}`;

export const askAllPrompt = (o: { q: string; now: string; tasks: string; material: string; span: string; current: string; prev: string }) => ({
  system: `당신은 ${ROLE}의 업무 비서 Jay입니다. 사용자의 회의록·하루 요약·대화 기록·할 일 목록을 근거로 질문에 답합니다.
규칙: 기록에 있는 것만 근거로 답하고, 답 끝에 근거를 '(근거: 자료 이름 또는 날짜)'로 짧게 붙이세요. 기록에서 찾지 못하면 지어내지 말고 '기록에서 찾지 못했어요'라고 말한 뒤 어디를 보면 될지 한 줄로 제안하세요.
날짜·숫자·담당·기한은 그대로. 한국어로 짧고 바로 쓸 수 있게 — 목록이 필요하면 개조식. 할 일을 묻는 질문은 [할 일]에서 기한 순으로.`,
  prompt: `지금: ${o.now}
${o.prev ? `[앞선 질문과 답]\n${o.prev}\n` : ""}[할 일]
${o.tasks || "(없음)"}
${o.current ? `[지금 진행 중인 대화]\n${o.current}\n` : ""}[기록${o.span ? " — " + o.span : ""}]
${o.material || "(관련 기록 없음)"}

[질문] ${o.q}`,
});
