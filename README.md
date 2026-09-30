# 중학 영단어 800 — 사전 학습 & 스피드 게임 웹앱

PRD v2(2026-09-30)를 구현한 웹앱입니다. 학생은 **PIN 입장 → 셀프테스트 암기 → 게임 → 오답 재학습**을 돌고, 교사는 **방 관리·실시간 랭킹·체크표·엑셀 내보내기**를 씁니다.

## 실행

```bat
start.bat
```

- 학생: `http://<서버 PC IP>:3000/` (같은 Wi-Fi의 크롬북·태블릿·스마트폰)
- 교사: `http://localhost:3000/teacher.html`
- 프로젝터: 교사 화면의 [프로젝터 모드]

Node.js는 `.runtime/node`에 휴대용으로 들어 있어 따로 설치할 필요가 없습니다. 다른 PC에서는 Node 22.13 이상을 설치한 뒤 `npm install` → `npm start`로 실행합니다.

| 명령 | 설명 |
|---|---|
| `npm start` | 서버 실행 (기본 포트 3000, `PORT`로 변경) |
| `npm test` | 수업 1회 전체 흐름 자동 테스트 (11개) |
| `npm run build:content` | `content/` → `data/words.json` 재생성·검증 |
| `npm run audio` | TTS 미지원 기기용 발음 파일 800개 생성 (`var/audio`) |

### 환경 변수

| 변수 | 용도 |
|---|---|
| `PUBLIC_URL` | 공유 링크·QR에 들어갈 주소 (예: `https://voca.school.kr`) |
| `GOOGLE_CLIENT_ID` | 설정하면 교사 로그인에 Google 버튼이 나옴 |
| `MAIL_WEBHOOK_URL` | 매직링크 메일 발송용 웹훅 (`{to, subject, text}` POST). 미설정 시 링크를 화면·서버 로그에 표시(개발 모드) |
| `NODE_ENV=production` | 개발용 링크 표시 끄기, 쿠키 Secure |
| `DATA_DIR` | DB·음성 파일 저장 위치 (기본 `var/`) |

## 구조

```
server/   app.js(API) · realtime.js(WebSocket+폴링) · reports.js(체크표·리포트·엑셀) · words.js(출제) · db.js(SQLite)
public/   index.html(학생) · teacher.html(교사) · board.html(프로젝터) · shared/scoring.js(서버·브라우저 공용 채점)
content/  headwords.txt(800단어 단계 배정) · stages/*.json(뜻·발음·예문)
test/     flow.test.js
```

## PRD 대비 구현 메모

- **기술 스택**: PRD 8장의 Next.js + Supabase 대신 Node(Express) + 내장 SQLite + WebSocket으로 구성했습니다. 외부 계정 없이 교실 PC 한 대로 바로 돌리기 위해서입니다. API 경로·실시간 이벤트(`room.started`, `leaderboard.updated`, `student.joined`, `room.locked`)는 PRD 8.1을 따릅니다.
- **실시간**: WebSocket이 막히면 1초 폴링으로 자동 전환합니다.
- **부정행위 방지**: 점수는 서버가 답안 기록으로 재계산합니다. 300ms 미만 연속 정답·이론상 최대 점수 초과·응답 시간 불일치는 랭킹에서 보류하고 교사 [학생 현황]에 표시하며, 교사가 승인할 수 있습니다. 오프라인에서도 "오답 직후 정답 1초 표시"를 하려고 퀴즈 정답은 가볍게 인코딩해 보내므로, 개발자 도구로 정답을 찾는 것까지 막지는 못합니다.
- **카드 뒤집기**: 헛뒤집기가 게임의 일부라서 정답률은 "찾은 짝 ÷ 6"으로 정의했고, 연속 오답 2초 잠금은 퀴즈·짝 맞추기에만 적용합니다.
- **발음 파일**: mp3 대신 Windows 내장 음성으로 만든 WAV(16kHz)입니다.
- **개인정보**: 실명·연락처는 받지 않고, 번호→실명 매핑은 내려받은 엑셀에서만 합니다. 방 마감 1년 뒤 자동 삭제, [마감된 방 기록 모두 삭제]로 학년도 말 일괄 삭제가 됩니다.

## 콘텐츠 검수 필요

800단어의 단계 배정·뜻·발음기호·예문은 AI가 초안으로 작성했고 형식 검증(중복 없음, 예문 12단어 이내, 품사, 빈칸 대상 일치)만 통과한 상태입니다. PRD 5.1대로 **교사 2인 검수**를 거친 뒤 사용하세요. 교육부 기본 어휘표와의 대조도 아직 하지 않았습니다(PRD 9.3 미결 사항). 수정은 `content/stages/*.json`을 고친 뒤 `npm run build:content`로 반영합니다.
