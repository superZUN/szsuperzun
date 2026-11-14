# 회의 옆자리 (Meeting Sidekick)

아이패드 Safari에서 하루 종일 켜 두고 쓰는 한국어 실시간 회의·대화 보조 웹 앱입니다. 예전 단일 HTML 앱(`legacy/`)을 기능을 그대로 유지한 채 모듈 구조로 다시 만들었습니다.

- 문서: `docs/01-legacy-분석보고서.md`(기존 앱 분석), `docs/02-비용-측정.md`, `docs/03-아이패드-수동-확인.md`, `docs/04-명세-체크리스트.md`
- 기존 데이터 호환: 설정(`ms.*`), 회의록(IndexedDB `meeting-copilot`), 할 일, 용어 사전을 **같은 주소에 배포하면** 그대로 이어서 씁니다.

## 배포 (Netlify)

**같은 주소(지금 쓰는 Netlify 사이트)에 배포해야 기존 설정·API 키·회의록·할 일이 그대로 보입니다.** 브라우저 저장소는 주소별로 따로 있기 때문입니다.

1. Netlify에서 **지금 쓰는 사이트**를 엽니다.
2. 사이트 설정에서 **Build & deploy → 저장소 연결(Link repository)** 을 고르고 GitHub의 `superzun/szsuperzun`, 브랜치 `main`을 선택합니다.
   - 빌드 설정은 저장소의 `netlify.toml`이 정합니다: 빌드 명령 `npm run build`, 게시 폴더 `dist`, 함수 폴더 `netlify/functions`.
   - 드래그 & 드롭 배포는 쓰지 마세요. 서버 함수(Functions)가 올라가지 않습니다.
3. **환경 변수:** 사이트 설정 → Environment variables에 `SIDEKICK_PASSCODE`(서버 암호)가 있는지 확인합니다.
   - 범위(Scopes)에 **Functions**가 포함돼야 합니다.
   - 값을 새로 넣거나 바꿨다면 **다시 배포(Trigger deploy)** 해야 적용됩니다.
   - 예전 앱과 같은 암호면 서버에 올려 둔 회의록·사전·할 일도 그대로 이어집니다.
4. 배포가 끝나면 아이패드에서 사이트를 열어 `docs/03-아이패드-수동-확인.md` 순서대로 확인합니다.

메뉴 이름은 Netlify 화면 개편에 따라 조금 다를 수 있습니다.

## 개발

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

- `npm run dev`: 개발 서버(http://localhost:5173)를 켭니다. `SIDEKICK_TEST_API=1`을 붙이면 서버 함수를 메모리 저장소로 함께 돌립니다.
- `npm test`: Playwright 테스트입니다. 데스크톱 + 아이패드 모양, 134개, 확인 항목 554개입니다.
- `npm run build`: 타입 검사 후 `dist/`를 만듭니다.

## 구조

| 폴더 | 내용 |
|---|---|
| `src/speech/` | 음성 인식(재시작 최소화·감시·중복 제거·권한), 마이크 게이지, 마이크 점검 |
| `src/ai/` | 제공자 4종 스트리밍·웹 검색·사용량, **모든 프롬프트(`prompts.ts`)** |
| `src/hud/`, `src/board/` | 신경망 캔버스·카드·손동작, 기록 보드 |
| `src/analysis/` | 실시간 분석, 즉시 키워드 레이어, 일상/업무 판단 |
| `src/qa/` | 질문, 넓게 찾기(DEEP SCAN), 사진·다이어그램·도면 |
| `src/minutes/`, `src/meeting/` | 회의록 확정 절차, 준비·안건·할 일·이월·자동 저장·마무리 점검 |
| `src/library/` | 사전 데이터(JSON), 사용자 사전, 문서 가져오기, 검색 색인, 서버 동기화 |
| `src/tasks/` | 할 일 탭 |
| `src/settings/`, `src/storage/`, `src/power/` | 설정, localStorage·IndexedDB·서버 호출, 대기·화면 잠금 방지 |
| `netlify/functions/` | `/api/glossary`, `/api/minutes`, `/api/tasks` (Netlify Blobs, strong consistency) |
| `public/vendor/` | mermaid 11.4.1, pdf.js, JSZip 3.10.1 — 처음 쓸 때만 불러옴 |
| `tests/` | 하네스(가짜 인식·마이크·Wake Lock·AI·위키, 로컬 함수 서버)와 테스트 |

## 앞으로 할 수 있는 것 (구조만 열어 둠)
- **놓친 구간 복원:** `src/speech/gauge.ts`는 이미 "말소리인데 글자가 없음" 구간을 압니다(`vad.speaking`, `rs.lastResultAt`). 그 구간을 잘라 OpenAI/Gemini 음성 인식으로 복원하는 기능을 이 자리에 붙이면 됩니다. Claude API는 오디오를 받지 않아 별도 키가 필요하고, 아이패드에서 마이크를 동시에 쓸 수 있는지에 달려 있습니다.
- **의미 기반 검색:** `src/library/docs.ts`의 `retrieveScored()`를 임베딩 검색으로 바꿀 수 있습니다. 지금은 AI 질의 확장(넓게 찾기)으로 대신합니다.
