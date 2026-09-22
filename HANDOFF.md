# OFFCUT-DIRECTOR — 세션 인계 문서

> 최종 갱신: 2026-09-21 · 이 파일은 재개 시 현재 상태 정본. README는 사용자 문서, 이 파일은 작업 인계용.

## 이게 뭔가

모바일 촬영 로거. 감독/조감독이 폰으로 롤 타임코드 + 구간 판정 + 메모를 기록하고
FCPXML로 프리미어에 넘기는 도구. 서버·계정·DB 없음 — 데이터는 폰 localStorage에만 저장.

## 라이브 URL

- **Vercel (프로덕션)**: https://offcut-director.vercel.app — `vercel --prod` 수동 배포
- **GitHub Pages**: https://rlagyqls051-create.github.io/offcut-director/ — push 시 자동 배포
- **프라이버시 페이지** (스토어 등록용): https://rlagyqls051-create.github.io/offcut-director/privacy.html
- **GitHub repo**: https://github.com/rlagyqls051-create/offcut-director (public)

## 배포 경로 3개

| 경로 | 방법 | 용도 |
|---|---|---|
| GitHub Pages | `git push` → 자동 | 웹/PWA 상시 주소 |
| Vercel | `vercel --prod` 수동 (Git 연동 없음) | 깔끔한 URL `offcut-director.vercel.app` |
| 네이티브 (iOS/Android) | 맥에서 `npm install && npm run sync && npx cap open ios|android` | 스토어/직접설치 — 아직 빌드 안 함 |

`.vercelignore`가 android/ios/node_modules 등을 배포에서 제외.

## 코드 구조

```
index.html   UI 전체 (메인 + 판정/보내기/설정 시트 3개)
app.js       상태머신 + 렌더 + FCPXML/SRT/CSV export + 마이크 녹음 + Capacitor 브릿지
style.css    모바일 전용 다크 UI (max-height:620px 컴팩트 모드 있음)
sw.js        service worker — stale-while-revalidate (캐시 즉시응답 + 백그라운드 갱신)
manifest.webmanifest  PWA 메타
privacy.html 스토어용 프라이버시 페이지
tools/sync-www.js     루트 웹파일 → www/ 복사 (npm run sync)
tools/make-icons.js   icon.svg → assets/*.png 소스 생성
capacitor.config.json 앱ID com.offcut.director
android/ ios/         생성된 네이티브 프로젝트 (아이콘 주입 완료)
www/                  sync 결과물, gitignore됨
```

## 상태 모델 (app.js 상단)

`LS_KEY = 'offcut-director.v1'` — 구 `offcut.v1`/`director.v1` 자동 이관 후 삭제.

```js
{ project, fps, prefix, startNo, slate, sound, syncOffset, mic,
  cam, camFacing,          // 앱 안 카메라 모드 + 'user'/'environment'
  uid, upUrl, upw,         // 오프컷 ID + 저장소 주소/비번 (localStorage 평문)
  takes:[{num,fname,startMs,endMs,status,sections,memos,note,offsetMs?}],
  seq, cur }   // cur = 진행중 롤 {num,fname,startMs,secStart,sections,memos,cutAt?}
```

- 구간 판정 코드(저장 호환 유지): `OK=편집에쓰자` `KEEP=특이사항` `NG=삭제`
- 테이크 판정: `OK / HOLD(보류) / NG` — 구 `KEEP` 테이크는 로드 시 HOLD로 변환
- `S.cur.cutAt` — CUT 누른 실제 시각 (시트에서 고민한 시간은 테이크 길이에 안 들어감)

## 핵심 동작 규칙 (건드릴 때 주의)

- ROLL은 **꾹 눌러야** 시작 (650ms, 오타치 방지 — 유령 롤은 카메라 파일번호와 어긋남)
- 유령 롤 삭제 시 "카메라가 안 찍었나" 확인 → 이후 테이크 번호/파일명 1씩 당김
- 구간 0.3초 미만 무시 (오타치 가드)
- `↩ 직전 구간 판정 취소` / 리스트에서 구간 줄 탭 → 판정 순환(OK→KEEP→NG) / 칩 탭 → 테이크 판정 순환(OK→HOLD→NG)
- `계속 롤` = cutAt 버리고 복귀 (마이크 녹음도 유지)
- 플래시: ROLL 시 `T##` 번호가 화면 가득 번쩍 + 1kHz 삑 — 카메라 파일 안 싱크 기준점
- 싱크 오프셋: `S.syncOffset` 전역 + `t.offsetMs` 테이크별 → FCPXML `start=` 계산에 반영
- 마이크: `S.mic` 켜면 롤 동안 MediaRecorder 녹음 (모노+16kbps — 싱크용 초저용량),
  피크>베이스라인4배 시 `슬레이트 감지` 메모 자동.
  `audioBlobs`(Map)는 **메모리만 — 앱 재시작 시 소실** (export 전에 닫으면 안 됨)
- 앱 안 카메라: `S.cam` 켜면 `camStream` 상시 프리뷰 + 롤 동안 `vrec`로 영상 녹화 →
  `videoBlobs`(Map, 역시 메모리만). mp4면 파일명이 fname 그대로라 FCPXML 릴링크 매칭됨.
  cam 켜져 있으면 micStart는 스킵 (영상에 오디오 포함). 박수 감지는 `watchClaps(stream)` 공용.
  롤 중 카메라 전환 불가 (녹화 끊김). MediaRecorder 미지원 기기는 미리보기만 동작.
- 오프컷 ID: `S.uid`가 있으면 파일명 접두어 + FCPXML `<library><metadata>` + CSV 첫 컬럼에 삽입.
  `내 저장소로 전송`은 `S.upUrl`로 multipart POST (Basic auth uid:upw) — 로그3종+오디오+영상 전부.
- 리셋: `micStop(num,false)`로 녹음 버림 + wake lock 해제
- 재시작 복원: `S.cur` 있으면 롤 UI 복원 + `S.mic`면 마이크 재시작

## 검증된 것

- Playwright 390×844 / 375×667: 롤→구간→메모→CUT→판정→리스트 전 플로우, 콘솔 에러 0
- 설정 시트가 작은 화면에서 스크롤됨 (sheetBox max-height:86dvh)
- CUT 시트 시계는 cutAt에서 멈춤, 메인 시계는 계속 돔
- Vercel 배포 200, manifest 서빙 확인

## 알려진 한계 / 다음 할 일

- 오디오/영상은 메모리 전용 — 영구 저장하려면 Capacitor Filesystem/IndexedDB로 옮겨야 함
- 네이티브 빌드 시 iOS Info.plist에 NSCameraUsageDescription/NSMicrophoneUsageDescription
  추가 필요 (인앱 카메라용) — 아직 네이티브 미빌드
- 저장소 업로드는 서버에서 CORS 허용 필요 (Authorization 헤더 → 프리플라이트 발생)
- 메모 내용 수정·구간 시간 ±조정 UI 없음 (판정만 순환 가능)
- 네이티브 빌드 미검증 — 맥 필요 (JDK/Android SDK는 이 Windows에 없음)
- iOS 홈화면 PWA의 MediaRecorder는 최신 OS 필요 — 미지원이면 조용히 꺼짐(try/catch)
- 아이콘은 생성 PNG — 사용자가 자체 로고 주면 `assets/icon-only.png` 교체 후 `npx @capacitor/assets generate`
- 스토어 등록 전 필요: Google Play $25(신규 개인계정은 20명×14일 클로즈드 테스트), Apple $99/년

## 명령어

```bash
node tools/sync-www.js     # 웹파일 → www/ 동기화 (네이티브 반영 전 필수)
node --check app.js        # 문법 검사
npx serve -l 8321 .        # 로컬 확인
vercel --prod              # Vercel 수동 배포 (로그인됨)
node tools/make-icons.js && npx @capacitor/assets generate   # 아이콘 재생성
```

## 세션 중 주의사항

- `H:\웹 프로그램\offcut` 빈 껍데기 폴더가 잠금으로 남아있을 수 있음 (수동 삭제 가능)
- Vercel 프로젝트는 Git 미연동 — 대시보드에서 연동하면 push=자동배포 가능
- 커밋 히스토리는 main에 직접 푸시하는 흐름으로 진행 중
