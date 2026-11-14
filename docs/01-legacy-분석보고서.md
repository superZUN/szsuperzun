# 1단계 · 기존 앱(legacy) 분석 보고서

대상: `legacy/meeting-sidekick/` — `public/index.html`(2,766줄, 33만 자), `netlify/functions/{glossary,minutes,tasks}.mjs`, `public/vendor/`(mermaid 11.4.1, pdf.js, pdf.worker, JSZip 3.10.1).
결론: **명세 3장의 기능은 거의 모두 기존 앱에 그대로 있습니다.** 명세와 다른 곳 8군데, 명세에 없는 기능 6개, 새로 만들 것(비용 관리·테스트)을 아래에 정리했습니다.

---

## 1. 기능 대조표 (명세 ↔ 기존 앱)

✅ = 명세와 같음 · ⚠️ = 다름(아래 2장) · 🆕 = 기존 앱에 없음(새로 만듦)

| 명세 | 상태 | 기존 앱에서 확인한 것 |
|---|---|---|
| 3.1 AI 제공자 4종·빠른/꼼꼼한 모델·SSE·400 재시도 | ✅ | `claude()`·`sendWithFallback()`. Anthropic thinking/effort, OpenAI reasoning_effort→max_completion_tokens→max_tokens 순으로 뺌, Gemini thinkingLevel |
| 3.1 웹 검색(searched 반환)·오늘 날짜·45초 예열 | ✅ | `searchCall()`, `todayLine()`, `keepWarm()`(사용 중 또는 2분 내 조작 시만) |
| 3.2 인식: onend 시 60ms 재사용→실패 시 새 인스턴스 | ✅ | `makeRec().onend` (network 오류 뒤엔 1.5초) |
| 3.2 주기적 새로 고침 재시작 **안 함** | ⚠️ | **기존 앱은 Safari에서 45초마다 새 인스턴스로 갈아끼움**(`REC_REFRESH`) |
| 3.2 무반응 30초 / 게이지 있으면 말소리+12초 → 새 인스턴스 | ✅ | 1초 간격 감시 타이머 |
| 3.2 멈춘 interim 2초 → 확정만, 중복 제거(접두어·바이그램 0.7·이전 문장 재전송) | ✅ | `committed`, `simText`, `lastHeardText` |
| 3.2 권한 거부·도중 not-allowed 3회 재시도·느린 시작 2회 → 영구 허용 안내 | ✅ | `permRetries`, `slowStarts`, `showMicHint()` |
| 3.2 Wake Lock release 시 재획득·보이면 재시작 | ✅ | `holdScreen()` |
| 3.2 대안 3개 중 용어 많은 것·phrases 120개·말로 하는 그림 요청 | ✅ | `bestAlt()`, `hintPhrases()`, `voiceVisual()`(6초 쿨다운) |
| 3.3 게이지 문구·말소리 판정(900Hz, 45%, 바닥×3, 0.4초) | ✅ | `vadTick()`, `renderGauge()` |
| 3.3 글자 없음 3초 → 재시작(8초 1회), **2번** 소용없으면 2분 쉼 | ⚠️ | 기존 앱은 **3번**째에 2분 쉼 |
| 3.3 audio-capture → 게이지 끄고 양보·영구 자동 끔 없음 | ✅ | 그 세션에서만 끔 (`vad.failed`) |
| 3.3 마이크 점검(5초 레벨 / 6초 인식 / 4가지 판정 + "게이지 끄고 인식만") | ✅ | `micCheck()` |
| 3.4 하루 종일 켜두기·대기·깨어남·`ms.sleepAfterMs` | ✅ | `enterStandby()`/`wakeUp()` |
| 3.5 회의/대화, 일상/업무 점수·45초 반감기·히스테리시스·5분 수동 | ✅ | `workScore()`, `updateTopic()`, `aiTopic()` |
| 3.5 대화 모드에서 이어쓰기 질문·회의록 바 숨김, 무관 지적 필터 | ✅ | `needsBoundary()`, `updateEndBar()`, `OFFTOPIC` |
| 3.6 기본 사전 76 + 235개, 사용자 사전, DEF/RECALL 즉시, 흔한 용어 제외 | ✅ | 개수 일치 확인. `instantScan()`, `GENERIC` |
| 3.6 KEYWORDS 바·키워드 상세·위키·웹 검색(15초 1회, 최신 우선) | ✅ | `renderKwBar()`, `openKw()`, `pumpWeb()` |
| 3.7 분석 0.4초 멈춤/15자/1초 간격, kw 첫 원소, 최대 2장 | ✅ | `analyze()`. 단 말이 이어지면 **최소 4초마다** 강제 분석(`MAX_WAIT_MS`) — 명세에 없음 |
| 3.7 교정기(2문장 또는 0.7초, 길이 0.4~2배)·원문/교정본·오인식 등록 | ✅ | `runFix()`, `plausible()`, `addToGlossary()` |
| 3.8 HUD·카드 배치·손동작(탭/두 번 탭/끌기/던지기 0.7px/ms) | ✅ | 고정 카드는 **최대 4장**(넘으면 가장 오래된 것 해제) — 명세에 없음 |
| 3.9 질문(그림 먼저→RECALL→답변 스트리밍), [보기] 태그, 웹 우선, 최신 정보 재검색, 말머리 | ✅ | `ask()`, `withLead()`, `TIME_RE` |
| 3.10 넓게 찾기 3가지 발동·단계 표시·앰버 레이더 | ✅ | `deepAsk()`, `isRepeat()`, `PAST_Q`, `⟪더찾기⟫` |
| 3.11 사진(위키 한·영 + Commons 동시)·Mermaid 점진 렌더·SVG 도면 정리·PNG 저장 | ✅ | `photoFor()`, `makeDiagram()`, `svgFromText()` |
| 3.12 회의록 확정 절차(교정→작성→검수→확정, 준비중/검토 필요/교체/재사용 키) | ✅ | `makeMinutes()`, `finalizeRecord()`, `minutesKey()` |
| 3.13 준비·안건 바·알림·할 일·날짜 슬래시·마무리 점검·자동 저장·새 회의 | ✅ | `splitSlash()`, `runCheck()`, `snapshot()` |
| 3.14 가져오기 6종 + 안내, 동기화·묘비, 색인(700/550) | ✅ | `readFile()`, `syncDocsNow()`, `rebuildIndex()` |
| 3.15 할 일 탭(필터·검색·기한·결과 한 줄·밀어 삭제·되돌리기·양방향 동기화) | ✅ | `renderTodo()`, `swipeToDelete()`, `mergeTasks()` |
| 3.16 기록 보드(가상화·검색·필터·팬·줌·목록) | ✅ | 화면 이름이 "ARCHIVE · **지난 말상자**" |
| 3.17 비용 관리(빈도 설정·캐싱·사용량·하루 한도) | 🆕 | 없음 |
| 3.18 프레임 조절·해상도 상한·확대 고정·16px | ✅ | `isHot()`/`frame()`, 터치 기기 `font-size:16px!important` |
| 7. 테스트 | 🆕 | **압축 파일에 테스트 코드가 없습니다.** 명세의 "350개 확인 항목"은 처음부터 새로 써야 합니다 |

## 2. 명세와 다른 점 — 처리 방침

| # | 다른 점 | 방침 |
|---|---|---|
| 1 | Safari 45초 주기 재시작(`ms.recRefreshMs`, `ms.forceRefresh`) | **명세대로 없앰.** 4장 교훈 1·4와 맞음. 두 키는 읽지 않음 |
| 2 | 글자 없음 재시작: 3번째에 2분 쉼 | 명세대로 2번 |
| 3 | 말이 이어지면 4초마다 강제 분석 | 비용 설정의 "빠르게"에만 남김. "균형"·"절약"은 명세 수치(3초·30자 / 6초·60자) |
| 4 | 기본 사전·회의 유형이 분석 프롬프트 **중간**에 들어감 → 캐시 불가 | 변하지 않는 앞부분(지시문 + 전체 Formation 사전)을 맨 앞으로 옮겨 캐시 (3.17) |
| 5 | 교정은 2문장씩, 일상 대화에서도 켜짐 | 4문장 묶음, 일상 대화에선 끄는 설정(기본 끔) |
| 6 | 주석과 코드가 다른 곳(예: "1.8초"라고 적고 실제 3초) | 실제 코드 수치를 따름 |
| 7 | 보드 이름 "지난 말상자" | 명세대로 "기록 · ARCHIVE". 버튼 이름 "기록"은 같음 |
| 8 | `ms.vadAutoOff` 부팅마다 지움(옛 버전 흔적) | 마이그레이션에서 한 번 지우고 끝 |

## 3. 명세에 없지만 기존 앱에 있는 기능 — 모두 유지

1. **회의 유형** 선택(일반·영어·기술 논의·고객사 미팅): 분석 프롬프트가 달라지고, "영어 회의"를 고르면 인식 언어가 EN으로 바뀜. 회의록 기본 제목에도 쓰임.
2. **고정 카드 최대 4장**.
3. 첫 화면 **예시 카드 3장**(SAMPLE). 실제 카드가 뜨면 사라짐.
4. **분석 기록(LOG)** 시트: 보드의 "목록" 버튼.
5. 회의록 화면의 **"원문 .txt" 저장**(교정본 + 원문), 후속 메일의 **받는 사람·"메일 앱으로"**(mailto).
6. 입력 없이 **받아쓰기 칸에 직접 입력하면 분석**됨(중간 편집 시 전체를 한 덩어리로 교체 — `reconcileManual`).

## 4. 저장 데이터 (그대로 이어 쓰도록 이름 유지)

**localStorage** (모두 `ms.` 접두어)
- AI: `prov`, `key.<제공자>`, `fast.<제공자>`, `deep.<제공자>`, `base.<제공자>` (제공자 = anthropic/openai/gemini/compat). 옛 버전 `apiKey`·`model`은 이미 옮기는 코드가 있음.
- 사전·서버: `glossary`, `glossaryAt`, `passcode`, `baseOff`, `libOff`, `docTomb`(지우지 못한 서버 회의록 id 목록)
- 설정: `appMode`, `power`, `visOff`, `instantOff`, `wikiOff`, `webMode`, `answerLead`(빈 값은 `"__none__"`로 저장), `minTemplate`, `fixOff`, `vadOff`/`vadOn`, `allDay`, `sleepAfterMs`, `micHintOff`
- 회의: `carry`(이월 할 일), `tasks`(할 일 전체), `session`(자동 저장, `v:1` 형식)
- 버릴 것: `recRefreshMs`, `forceRefresh`, `vadAutoOff`

**IndexedDB**: DB `meeting-copilot` v1, 저장소 `docs`(키 `id`). 문서 = `{id, name, text, added, synced?, status?: "pending"|"review"|"final", issues?, replaces?}`. 상태가 없으면 확정본.

**서버(Netlify Blobs, 저장소 `sidekick`)**: `glossary`, `minutes-index`, `minutes/<id>`, `tasks`. 함수 3개는 명세와 정확히 같아서 그대로 옮깁니다.

## 5. 위험 요소

1. **⚠️ 주소(도메인)가 바뀌면 기존 데이터가 안 보입니다.** localStorage·IndexedDB는 주소별로 따로 저장됩니다. 새 앱을 **지금 쓰는 Netlify 사이트와 같은 주소**로 배포해야 설정·API 키·회의록·할 일이 그대로 보입니다. (서버에 올라간 회의록·사전·할 일은 서버 암호만 넣으면 다시 받아올 수 있음.)
2. **이 작업 공간은 임시입니다.** GitHub에 올리지 않으면 세션이 끝날 때 작업이 사라집니다. 지금 이 세션엔 GitHub가 연결돼 있지 않습니다.
3. **프롬프트 캐싱 최소 길이.** Anthropic 캐시는 앞부분이 일정 토큰 이상이어야 작동합니다(모델마다 다름). 분석 프롬프트의 고정 앞부분이 그보다 짧을 수 있어, 3단계에서 실제 수치를 확인하고 묶는 방식을 정합니다.
4. **테스트를 처음부터 새로 써야 합니다.** 범위가 커서 토큰이 많이 듭니다. 단계마다 그 단계 기능의 테스트만 쓰고 돌리겠습니다.
5. **아이패드 실기기 확인은 제가 할 수 없습니다.** 마이크 동시 사용, Safari 권한 배너, 30분 연속 듣기는 에뮬레이션으로 흉내만 낼 수 있어서, 수동 확인 절차서로 보완합니다.
6. 글꼴은 Google Fonts(IBM Plex Sans KR / Mono)에서 받습니다. 한글 글꼴은 수 MB라 직접 호스팅하지 않고 그대로 두되, 못 받아도 시스템 글꼴로 보이게 합니다.

## 6. 진행 계획 (명세 9장 그대로, 단계마다 커밋·보고)

| 단계 | 내용 | 끝났을 때 확인할 것 |
|---|---|---|
| 2 | Vite + TS 골격, 함수 3개 이전, `netlify.toml`, Playwright 하네스(가짜 인식·마이크·Wake Lock·AI·위키 모킹, 로컬 함수 서버) | 빈 앱이 빌드·실행되고 함수 테스트 통과 |
| 3 | `storage/`·`settings/`(ms.* 그대로 + 마이그레이션), `ai/`(제공자·SSE·재시도·웹 검색·사용량 집계), `prompts.ts` | 기존 설정이 그대로 읽힘, 4개 제공자 모킹 테스트 |
| 4 | `speech/`(인식·감시·중복 제거·권한), 게이지, 마이크 점검, 대기, Wake Lock | 인식·게이지·점검·대기 테스트 |
| 5 | `hud/`(캔버스·카드·손동작·프레임 조절), 키워드 레이어·사전 데이터 파일 | 손동작·키워드 0.3초 이내 |
| 6 | 실시간 분석·교정·대화 주제 판단 | 주제 전환·일상 필터·카드 |
| 7 | 질문·넓게 찾기·시각 자료 | 그림 태그·웹 우선·재검색·점진 렌더 |
| 8 | 회의 매니저·회의록 확정 절차 | 준비중·검토 필요·교체·업로드 |
| 9 | 라이브러리·가져오기 6종·할 일·기록 보드 | 가져오기·밀어 삭제·두 기기 동기화·보드 가상화 |
| 10 | 비용 관리·배터리·확대 고정·접근성 | 1분 발화 호출 수 비교 기록 |
| 11 | 전체 테스트, 아이패드 수동 확인 절차서, README, 배포 | 명세 체크리스트 보고 |
