# offcut-director — 촬영 로거 (take logger)

소규모 촬영(인터뷰 등)에서 감독/조연출이 폰으로 **롤 타임코드 + 구간 판정 + 메모**를 기록하고,
결과를 **프리미어 프로로 바로 넘기는** PWA.

배포: https://rlagyqls051-create.github.io/offcut-director/ (GitHub Pages, main push 시 자동 배포)
구 배포: https://offcut-xi.vercel.app (구 이름 offcut)

## 사용 흐름

1. **카메라 먼저 돌리고** `ROLL` 꾹 누르기 (0.65s, 오타치 방지) — 화면 플래시(테이크 번호 표시) + 1kHz 삑.
   플래시가 영상 안에 찍혀야 싱크 기준점이 생김 = 앱 타임라인 0초
   - 유령 롤(카메라가 안 찍음)은 테이크 삭제 시 "번호 당기기"로 이후 파일명을 카메라에 재정렬
2. 롤 도중 `편집에쓰자 / 특이사항 / 삭제` — "마지막 마크 ~ 지금" 구간을 판정하고 새 구간 시작 (카메라 안 끊음)
   - `↩ 직전 구간 판정 취소` 있음
   - 메모 입력바 — 지문/내용을 채팅처럼 기록, 타임스탬프 자동
3. `CUT` — CUT 누른 시점에서 타임코드 정지 → 마지막 구간 판정 + 노트 → 테이크 저장.
   테이크 판정은 구간에서 자동 도출 (전부 삭제→삭제, 편집에쓰자 하나라도→편집에쓰자, 나머지→보류).
   `테이크 보류` 버튼으로 판정 유보 가능, `계속 롤`은 테이크 안 끝내고 이어서 진행
4. `보내기` — FCPXML / SRT / CSV, iOS 공유시트 → AirDrop으로 맥 전달
   - `내 저장소로 전송` — 설정의 저장소 주소로 로그 파일+미디어를 한 번에 업로드 (오프컷 AI 연동용)

## 셀프 촬영 모드 (앱 안 카메라)

설정에서 `앱 안 카메라`를 켜면 ROLL 위에 라이브 프리뷰가 뜨고, 롤 동안 폰 카메라로
영상을 직접 녹화 — 스노우처럼 카메라가 앱에 붙어있는 형태. 혼자 찍는 사람용.

- 앱이 직접 녹화하므로 **영상 시작 = 앱 타임라인 0초** — 싱크 오프셋 사실상 불필요
- mp4로 녹화되는 기기(iOS 등)는 파일명이 `C0001.MP4` 그대로 → FCPXML 릴링크 매칭
- `↻` 버튼으로 전면/후면 전환 (롤 중에는 잠금 — 전환하면 녹화가 끊김)
- `테이크 영상 보내기`로 테이크별 영상 공유/저장. webm으로 녹화되는 기기는
  프리미어가 직접 못 읽으니 변환 필요
- 녹화된 영상은 메모리에만 있음 — 촬영 후 바로 export (오디오와 동일)

## 오프컷 계정 / 저장소

설정에 `오프컷 ID` + `저장소 주소 + 비번`을 입력하면:

- 파일명이 `ID_프로젝트_촬영로그_날짜` 형태가 되고, FCPXML `<metadata>`와 CSV 첫
  컬럼에 ID가 박힘 → 오프컷 AI가 소유자를 인식해 자동 컷편집에 활용
- `내 저장소로 전송` 버튼이 FCPXML+CSV+SRT+테이크 오디오/영상을 multipart로
  한 번에 POST (`Authorization: Basic ID:비번`)
- 비번은 폰 localStorage에만 저장됨 (서버 없는 앱이라 평문 — 공유 기기면 주의)

## 프리미어 연동

- **FCPXML**: 테이크를 구간별 `asset-clip`으로 쪼개서보냄 (`T01.1 삭제`, `T01.2 편집에쓰자`…).
  같은 카메라 파일의 다른 소스 오프셋을 참조 → 릴링크하면 실화면 자동 연결.
  "삭제" 구간엔 전체 길이 `삭제 구간` 마커, 메모는 포인트 마커.
- **싱크 오프셋**: 플래시(앱 0초)는 카메라 파일 안 δ초 지점에 찍힘. 프리미어에서 플래시 프레임 위치를 보고
  테이크 리스트의 `플래시 오프셋 −/+`로 입력 → export 시 모든 소스 오프셋에 반영. 오프셋이 맞으면
  각 테이크 클립이 정확히 플래시 프레임에서 시작 (육안 검증 가능). 삑 소리는 오디오 파형으로도 확인.
  전역 기본값은 설정의 "플래시 싱크 오프셋".
- **마이크 녹음** (설정에서 켬): 롤 동안 폰 마이크로 오디오 녹음 → `테이크 오디오 보내기`로 테이크별
  m4a/webm보내기. 카메라 오디오와 파형 매칭(프리미어 멀티캠 Synchronize 또는 수동)으로 싱크.
  박수/슬레이트 같은 큰 트랜지언트는 자동 감지해 `슬레이트 감지` 메모+마커로 남김.
  오디오는 메모리에만 있음 — 앱 재시작하면 소실되니 촬영 후 바로 export.
- **SRT**: 메모를 자막으로. 익스포트된 시퀀스 타임라인 기준 TC라 FCPXML 위에 그대로 올라감.
- **CSV**: 구간/메모 포함 플랫 로그.

## 파일

| 파일 | 역할 |
|---|---|
| `index.html` | 전체 마크업 (시트 3개: 판정/보내기/설정) |
| `app.js` | 상태 + 로직 +보내기. 프레임워크 없음, 바닐라 |
| `style.css` | 다크 모바일 UI |
| `manifest.webmanifest`, `sw.js`, `icon*` | PWA (오프라인 캐시, 홈화면 설치) |

## 데이터 모델 (localStorage `offcut-director.v1`, 구 `offcut.v1`에서 자동 이관)

```js
S = {
  project, fps, prefix, startNo, slate, sound, syncOffset, mic,
  cam, camFacing,          // 앱 안 카메라 모드 + 전면/후면
  uid, upUrl, upw,         // 오프컷 ID + 저장소 주소/비번
  takes: [{ num, fname, startMs, endMs, status,  // take status: OK(편집에쓰자)|HOLD(보류)|NG(삭제)
            offsetMs?,                           // 이 테이크의 플래시 싱크 오프셋 (없으면 S.syncOffset)
            sections: [{start,end,status}],      // section status: OK(편집에쓰자)|KEEP(특이사항)|NG(삭제)
            memos: [{ms,text}], note }],
  seq,                        // 다음 테이크 번호
  cur,                        // 롤 중 테이크 {num,fname,startMs,secStart,cutAt?,sections,memos} (앱 재시작 시 복원됨)
}
```

- 시간은 `Date.now()`(벽시계) 기준 — 카메라 파일 생성시각과 대조 가능, 앱 재시작해도 유지
- `fname` = `prefix` + zero-pad(startNo + num - 1) + `.MP4` — 설정에서 카메라 파일명 패턴 맞춤
- 상태 변경 지점은 전부 `save()` 호출 — 직접 필드 바꾸면 유실됨

## 로컬 실행 / 배포

```bash
python3 -m http.server 8321   # 로컬 테스트
git push                       # 배포 — GitHub Pages가 main에서 자동 발행
```

## 네이티브 앱 (Capacitor)

웹 코드는 루트 파일이 원본 — `npm run sync`가 `www/`로 복사 후 `cap sync` 실행.
네이티브에서는 `navigator.share` 대신 Share/Filesystem 플러그인, 진동은 Haptics,
wakeLock은 KeepAwake로 자동 전환 (`app.js`의 `CAP` 분기).

### 맥에서 빌드

```bash
git clone https://github.com/rlagyqls051-create/offcut-director.git
cd offcut-director && npm install && npm run sync

# iOS — Xcode 필요, CocoaPods 없으면: sudo gem install cocoapods
npx cap open ios     # Xcode에서 Signing 팀 지정 → 기기 연결 후 Run
                     # 스토어: Product → Archive → App Store Connect 업로드

# Android — Android Studio 필요
npx cap open android # Studio에서 기기 Run / Build → Generate Signed AAB → Play Console
```

- 무료 Apple ID 서명은 7일마다 만료 → 개인 사용도 $99/년 계정이 편함
- 데이터는 localStorage에 로컬 저장 (웹뷰 안이라 앱 삭제 전까지 유지)
- 네이티브 아이콘은 현재 Capacitor 기본값 — 실제 아이콘은 `npx @capacitor/assets`로 생성 가능

## 향후: 카메라 직접 연동 (검색해둔 것)

- **Canon CCAPI**: Wi-Fi로 카메라가 HTTP REST 서버가 됨. `/ccapi/event/polling`으로
  녹화 시작/정지 이벤트 수신 가능 → 버튼 없이 자동 테이크 경계. 브라우저 직접 연결은
  CORS 때문에 어려워서 현장 노트북에 로컬 브릿지(프록시) 필요.
- **Sony Camera Remote SDK**: USB/LAN/Wi-Fi, 녹화 시작/정지 이벤트 + 일부 기종
  (A7M4, A7RM5, ZV-E1) 타임코드 원격 설정 → 앱 TC를 카메라에 jam-sync 가능. C++ SDK.
- 지금 수동 모드는 어차피 플래시+비프 슬레이트가 싱크 기준점이라 카메라 연동 없이도 동작.

## 다음에 할 만한 것

- 구간 시간 미세 조정 ±0.5s (판정 자체는 리스트에서 구간 줄 탭으로 변경 가능)
- 세션/날짜별 로그 분리
- DaVinci Resolve용 EDL보내기
- 테이크별 음성 메모 녹음
