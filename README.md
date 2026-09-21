# offcut-director — 촬영 로거 (take logger)

소규모 촬영(인터뷰 등)에서 감독/조연출이 폰으로 **롤 타임코드 + 구간 판정 + 메모**를 기록하고,
결과를 **프리미어 프로로 바로 넘기는** PWA.

배포: https://offcut-xi.vercel.app (구 이름 offcut으로 배포됨. 재배포 시 `vercel --prod --name offcut-director` → 새 URL)

## 사용 흐름

1. `ROLL` 꾹 누르기 (0.65s, 오타치 방지) — 화면 플래시 + 1kHz 삑 (슬레이트 대용: 영상 첫 프레임 = 앱 타임라인 0초)
   - 유령 롤(카메라가 안 찍음)은 테이크 삭제 시 "번호 당기기"로 이후 파일명을 카메라에 재정렬
2. 롤 도중 `편집에쓰자 / 특이사항 / 삭제` — "마지막 마크 ~ 지금" 구간을 판정하고 새 구간 시작 (카메라 안 끊음)
   - `↩ 직전 구간 판정 취소` 있음
   - 메모 입력바 — 지문/내용을 채팅처럼 기록, 타임스탬프 자동
3. `CUT` — CUT 누른 시점에서 타임코드 정지 → 마지막 구간 판정 + 노트 → 테이크 저장.
   테이크 판정은 구간에서 자동 도출 (전부 삭제→삭제, 편집에쓰자 하나라도→편집에쓰자, 나머지→보류).
   `테이크 보류` 버튼으로 판정 유보 가능, `계속 롤`은 테이크 안 끝내고 이어서 진행
4. `보내기` — FCPXML / SRT / CSV, iOS 공유시트 → AirDrop으로 맥 전달

## 프리미어 연동

- **FCPXML**: 테이크를 구간별 `asset-clip`으로 쪼개서보냄 (`T01.1 삭제`, `T01.2 편집에쓰자`…).
  같은 카메라 파일의 다른 소스 오프셋을 참조 → 릴링크하면 실화면 자동 연결.
  "삭제" 구간엔 전체 길이 `삭제 구간` 마커, 메모는 포인트 마커.
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
  project, fps, prefix, startNo, slate, sound,
  takes: [{ num, fname, startMs, endMs, status,  // take status: OK(편집에쓰자)|HOLD(보류)|NG(삭제)
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
vercel --prod --name offcut-director   # 배포 (폴더명에 한글 있어서 --name 필수)
```

## 향후: 카메라 직접 연동 (검색해둔 것)

- **Canon CCAPI**: Wi-Fi로 카메라가 HTTP REST 서버가 됨. `/ccapi/event/polling`으로
  녹화 시작/정지 이벤트 수신 가능 → 버튼 없이 자동 테이크 경계. 브라우저 직접 연결은
  CORS 때문에 어려워서 현장 노트북에 로컬 브릿지(프록시) 필요.
- **Sony Camera Remote SDK**: USB/LAN/Wi-Fi, 녹화 시작/정지 이벤트 + 일부 기종
  (A7M4, A7RM5, ZV-E1) 타임코드 원격 설정 → 앱 TC를 카메라에 jam-sync 가능. C++ SDK.
- 지금 수동 모드는 어차피 플래시+비프 슬레이트가 싱크 기준점이라 카메라 연동 없이도 동작.

## 다음에 할 만한 것

- 구간/메모 사후 편집 (테이크 리스트에서 시간 미세 조정 ±0.5s)
- 세션/날짜별 로그 분리
- DaVinci Resolve용 EDL보내기
- 테이크별 음성 메모 녹음
