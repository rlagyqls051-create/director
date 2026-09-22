'use strict';
const $ = s => document.querySelector(s);
const LS_KEY = 'offcut-director.v1';

/* ---------- state ---------- */
function fresh() {
  return {
    project: '오늘의 촬영',
    fps: 25,
    prefix: 'C',
    startNo: 1,
    slate: true,
    sound: true,
    syncOffset: 0,        // ms — 플래시(app 0초)가 카메라 파일 안에서 밀린 시간 (카메라 선행 롤 = 양수)
    mic: false,           // 롤 중 마이크 녹음 + 박수 감지
    cam: false,           // 앱 안 카메라 — 셀프 촬영 모드 (롤 동안 영상 녹화)
    camFacing: 'user',    // 'user' 전면 | 'environment' 후면
    uid: '',              // 오프컷 ID — 파일명/FCPXML/CSV에 삽입 → 오프컷 AI가 소유자 인식
    upUrl: '',            // 내 저장소 업로드 주소
    upw: '',              // 저장소 비번 (이 폰 localStorage에만 저장)
    takes: [],          // {num, fname, startMs, endMs, status, sections:[{start,end,status}], memos:[{ms,text}], note}
    seq: 1,
    cur: null,          // rolling take: {num, fname, startMs, secStart, sections:[], memos:[]}
  };
}
let S;
try { S = JSON.parse(localStorage.getItem(LS_KEY) || localStorage.getItem('offcut.v1') || localStorage.getItem('director.v1')) || fresh(); } catch { S = fresh(); }
localStorage.removeItem('offcut.v1'); localStorage.removeItem('director.v1');
S.takes.forEach(t => { if (t.status === 'KEEP') t.status = 'HOLD'; });
if (S.syncOffset == null) S.syncOffset = 0;
if (S.mic == null) S.mic = false;
if (S.cam == null) S.cam = false;
if (S.camFacing == null) S.camFacing = 'user';
if (S.uid == null) S.uid = '';
if (S.upUrl == null) S.upUrl = '';
if (S.upw == null) S.upw = '';
if (S.cur) delete S.cur.cutAt;
const save = () => localStorage.setItem(LS_KEY, JSON.stringify(S));

/* ---------- helpers ---------- */
const pad = (n, l = 2) => String(n).padStart(l, '0');
function msToTC(ms) {
  const fps = S.fps;
  const totalF = Math.round(ms / 1000 * fps);
  const ff = Math.floor(totalF % fps);
  let s = Math.floor(totalF / fps);
  const ss = s % 60; s = Math.floor(s / 60);
  const mm = s % 60; const hh = Math.floor(s / 60);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}
const durStr = ms => {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}.${pad(Math.floor(ms % 1000 / 100))}`;
};
const clockStr = t => `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
const fileName = num => `${S.prefix}${pad(S.startNo + num - 1, 4)}.MP4`;
const buzz = p => {
  if (!S.sound) return;
  if (CAP && CAP.Haptics) { CAP.Haptics.impact({ style: p >= 40 ? 'heavy' : p >= 25 ? 'medium' : 'light' }).catch(() => {}); return; }
  if (navigator.vibrate) navigator.vibrate(p);
};
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const LBL = { OK: '편집에쓰자', KEEP: '특이사항', NG: '삭제' };           // 구간 판정
const TLBL = { OK: '편집에쓰자', HOLD: '보류', NG: '삭제' };             // 테이크 판정
// Capacitor 네이티브 플러그인 (웹/PWA에서는 null → 기존 웹 경로로 폴백)
const CAP = (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) ? Capacitor.Plugins : null;

function beep() {
  if (!S.sound) return;
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === 'suspended') ctx.resume();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 1000; g.gain.value = 0.25;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.35);
  } catch {}
}

/* ---------- wake lock ---------- */
let wakeLock = null;
async function setWake(on) {
  try {
    if (CAP && CAP.KeepAwake) { on ? await CAP.KeepAwake.keepAwake() : await CAP.KeepAwake.allowSleep(); return; }
    if (on && !wakeLock && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.cur) setWake(true);
});

/* ---------- mic recording + clap detect (싱크용) ---------- */
let rec = null;                     // {mr, stream, chunks, ext, clap}
const audioBlobs = new Map();       // takeNum → {blob, ext}  (메모리만 — 앱 재시작 시 소실)

// 트랜지언트(박수/슬레이트) 감지: 순간 피크가 롤링 베이스라인의 4배 이상
function watchClaps(stream) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let base = 0.02, lastClap = -1e9, raf;
    const tick = () => {
      if (!S.cur) return;
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      const now = Date.now() - S.cur.startMs;
      base = base * 0.98 + peak * 0.02;
      if (peak > 0.5 && peak > base * 4 && now - lastClap > 400) {
        lastClap = now;
        S.cur.memos.push({ ms: Math.round(now), text: '슬레이트 감지' });
        save(); render();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return { stop() { cancelAnimationFrame(raf); ctx.close().catch(() => {}); } };
  } catch { return { stop() {} }; }
}

async function micStart() {
  if (!S.mic || S.cam || rec) return;   // 앱 안 카메라가 켜져 있으면 영상에 오디오가 같이 들어감
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!S.cur) { stream.getTracks().forEach(t => t.stop()); return; }
    const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    mr.start(500);
    rec = { mr, stream, chunks, ext: mime.includes('mp4') ? 'm4a' : 'webm', clap: watchClaps(stream) };
  } catch {}
}

function micStop(num, keep = true) {
  if (!rec) return;
  const r = rec; rec = null;
  r.clap.stop();
  r.mr.onstop = () => {
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/mp4' });
    if (keep && blob.size) audioBlobs.set(num, { blob, ext: r.ext });
    r.stream.getTracks().forEach(t => t.stop());
  };
  try { r.mr.stop(); } catch {}
}

/* ---------- 앱 안 카메라 (셀프 촬영) ---------- */
let camStream = null;               // 프리뷰용 getUserMedia 스트림 (cam 모드 동안 상시)
let vrec = null;                    // {mr, chunks, ext, clap}
const videoBlobs = new Map();       // takeNum → {blob, ext}  (메모리만 — 오디오와 동일)
const VID_MIME = ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4', 'video/webm;codecs=h264,opus', 'video/webm'];

async function camOn() {
  if (!S.cam || camStream) return;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: S.camFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: true,
    });
    const v = $('#camView');
    v.srcObject = camStream;
    v.classList.toggle('self', S.camFacing === 'user');
    $('#camWrap').classList.remove('hidden');
  } catch (e) {
    S.cam = false; save();
    alert('카메라를 열 수 없습니다 — ' + (e && e.name === 'NotAllowedError' ? '카메라/마이크 권한이 거부됨' : '이 기기/브라우저 미지원'));
  }
}

function camOff() {
  if (vrec) vStop(S.cur ? S.cur.num : -1, false);
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  $('#camView').srcObject = null;
  $('#camWrap').classList.add('hidden');
}

function vStart() {
  if (!S.cam || !camStream || vrec || !window.MediaRecorder) return;
  const mime = VID_MIME.find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) return;   // 인앱 녹화 미지원 기기 — 미리보기만 동작
  const mr = new MediaRecorder(camStream, { mimeType: mime });
  const chunks = [];
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mr.start(500);
  vrec = { mr, chunks, ext: mime.includes('mp4') ? 'mp4' : 'webm', clap: watchClaps(camStream) };
}

function vStop(num, keep = true) {
  if (!vrec) return;
  const r = vrec; vrec = null;
  r.clap.stop();
  r.mr.onstop = () => {
    const blob = new Blob(r.chunks, { type: r.mr.mimeType });
    if (keep && blob.size) videoBlobs.set(num, { blob, ext: r.ext });
  };
  try { r.mr.stop(); } catch {}
}

// mp4로 녹화됐으면 카메라 파일명(C0001.MP4) 그대로 → FCPXML 릴링크 매칭
const vidName = (t, ext) => ext === 'mp4' ? t.fname : t.fname.replace(/\.[^.]+$/, '.' + ext);

/* ---------- roll / cut / ng ---------- */
function roll() {
  buzz(30);
  const num = S.seq;
  S.cur = { num, fname: fileName(num), startMs: Date.now(), secStart: 0, sections: [], memos: [] };
  save();
  if (S.slate) {
    $('#flashNum').textContent = `T${pad(num, 2)}`;
    $('#flash').classList.add('on');
    setTimeout(() => $('#flash').classList.remove('on'), 450);
    beep();
  }
  document.body.classList.add('rolling');
  setWake(true);
  if (S.cam) vStart(); else micStart();
  render();
}

function sectionMark(status) {
  if (!S.cur) return;
  buzz(25);
  const now = Date.now() - S.cur.startMs;
  if (now - S.cur.secStart < 300) return; // 0.3초 미만 구간 무시 (오타치 방지)
  S.cur.sections.push({ start: S.cur.secStart, end: now, status });
  S.cur.secStart = now;
  save(); render();
}

function undoSection() {
  if (!S.cur || !S.cur.sections.length) return;
  buzz(15);
  S.cur.secStart = S.cur.sections.pop().start;
  save(); render();
}

function addMemo() {
  if (!S.cur) return;
  const text = $('#memoInput').value.trim();
  if (!text) return;
  buzz(10);
  S.cur.memos.push({ ms: Date.now() - S.cur.startMs, text });
  $('#memoInput').value = '';
  save(); render();
  const f = $('#memoFeed'); f.scrollTop = f.scrollHeight;
}

function cut() {
  if (!S.cur) return;
  buzz(40);
  S.cur.cutAt = Date.now();
  save();
  $('#sheetTitle').textContent = `테이크 ${S.cur.num} 종료 — 마지막 구간 판정`;
  $('#sheetNote').value = '';
  $('#sheetClock').textContent = msToTC(S.cur.cutAt - S.cur.startMs);
  $('#sheet').classList.remove('hidden');
}

function judge(secStatus, takeStatus) {
  if (!S.cur) return;
  const end = S.cur.cutAt || Date.now();
  const rel = end - S.cur.startMs;
  if (rel - S.cur.secStart >= 1) S.cur.sections.push({ start: S.cur.secStart, end: rel, status: secStatus });
  const secs = S.cur.sections;
  const auto = secs.every(s => s.status === 'NG') ? 'NG' : secs.some(s => s.status === 'OK') ? 'OK' : 'HOLD';
  S.takes.push({
    num: S.cur.num, fname: S.cur.fname,
    startMs: S.cur.startMs, endMs: end,
    status: takeStatus || auto, sections: secs, memos: S.cur.memos, note: $('#sheetNote').value.trim(),
  });
  micStop(S.cur.num);
  vStop(S.cur.num);
  S.seq++; S.cur = null;
  save();
  $('#sheet').classList.add('hidden');
  document.body.classList.remove('rolling');
  setWake(false);
  render();
}

/* ---------- timeline strip ---------- */
const PXS = 8; // px per second
const secHTML = s =>
  `<div class="tlSec ${s.status}" style="width:${Math.max(2, (s.end - s.start) / 1000 * PXS)}px"></div>`;
function renderTimeline() {
  $('#tlWrap').style.display = (S.takes.length || S.cur) ? '' : 'none';
  $('#timeline').innerHTML = S.takes.map(t =>
    `<div class="tlTake" style="width:${Math.max(3, (t.endMs - t.startMs) / 1000 * PXS)}px">` +
    `<span class="tlNum">T${pad(t.num, 2)}</span>${(t.sections || []).map(secHTML).join('')}</div>`
  ).join('') +
  (S.cur ? `<div class="tlTake" id="tlCur"></div>` : '') +
  `<div id="playhead"></div>`;
}

/* ---------- render ---------- */
function render() {
  $('#hProject').textContent = S.project;
  $('#btnRoll').classList.toggle('hidden', !!S.cur);
  $('#rollCtl').classList.toggle('hidden', !S.cur);
  document.body.classList.toggle('rolling', !!S.cur);
  $('#btnUndoSec').classList.toggle('hidden', !(S.cur && S.cur.sections.length));
  $('#memoBar').classList.toggle('hidden', !S.cur);
  $('#memoFeed').innerHTML = (S.cur ? S.cur.memos : []).map(m =>
    `<div class="mrow"><span class="mtc">${durStr(m.ms)}</span>${xmlEsc(m.text)}</div>`).join('');

  const list = $('#takeList');
  renderTimeline();
  if (!S.takes.length) {
    list.innerHTML = `<div class="empty">아직 테이크 없음 — ROLL을 눌러 시작</div>`;
    return;
  }
  list.innerHTML = [...S.takes].reverse().map(t => {
    const note = t.note ? ` · ${t.note}` : '';
    const secN = (t.sections || []).length;
    const secInfo = secN > 1 ? `구간${secN}` : '';
    return `<div class="trow">
      <span class="tno">T${pad(t.num, 2)}</span>
      <span class="tfile">${t.fname}</span>
      <span class="tdur">${durStr(t.endMs - t.startMs)}${note}</span>
      ${secInfo ? `<span class="ngbadge">${secInfo}</span>` : ''}
      <button class="chip ${t.status}" data-num="${t.num}">${TLBL[t.status] || t.status}</button>
      <button class="tdel" data-del="${t.num}">×</button>
    </div>` +
    `<div class="mline">└ 플래시 오프셋 <b>${(((t.offsetMs ?? S.syncOffset)) / 1000).toFixed(1)}s</b>` +
      `<button class="ofsbtn" data-ofs="-500" data-num="${t.num}">−0.5</button>` +
      `<button class="ofsbtn" data-ofs="500" data-num="${t.num}">+0.5</button></div>` +
    (t.sections || []).map((s, i) =>
      `<div class="mline sec" data-tnum="${t.num}" data-si="${i}">└ ${durStr(s.start)}–${durStr(s.end)} <b class="seclbl ${s.status}">${LBL[s.status] || s.status}</b></div>`).join('') +
    (t.memos || []).map(m => `<div class="mline">└ ${durStr(m.ms)} — ${xmlEsc(m.text)}</div>`).join('');
  }).join('');
}

/* ---------- clock loop ---------- */
setInterval(() => {
  const now = Date.now();
  if (S.cur) {
    const rel = now - S.cur.startMs;
    $('#clock').textContent = msToTC(rel);
    $('#takeLabel').textContent = `REC · 테이크 ${S.cur.num} · ${S.cur.fname}`;
    $('#wallSub').textContent = `시작 ${clockStr(new Date(S.cur.startMs))}`;
    const cur = $('#tlCur');
    if (cur) {
      cur.style.width = Math.max(3, rel / 1000 * PXS) + 'px';
      cur.innerHTML = `<span class="tlNum">T${pad(S.cur.num, 2)}</span>` +
        S.cur.sections.map(secHTML).join('') +
        `<div class="tlSec cur" style="width:${Math.max(2, (rel - S.cur.secStart) / 1000 * PXS)}px"></div>`;
      const base = S.takes.reduce((a, t) => a + (t.endMs - t.startMs), 0);
      const ph = (base + rel) / 1000 * PXS;
      $('#playhead').style.left = ph + 'px';
      const w = $('#tlWrap');
      w.scrollLeft = ph - w.clientWidth + 40;
    }
  } else {
    $('#clock').textContent = clockStr(new Date());
    $('#takeLabel').textContent = 'STANDBY';
    $('#wallSub').textContent = S.takes.length ? `테이크 ${S.takes.length}개 기록됨` : '';
  }
}, 40);

/* ---------- export ---------- */
const FPS_RAT = { 23.976: '1001/24000s', 24: '1/24s', 25: '1/25s', 29.97: '1001/30000s', 30: '1/30s', 50: '1/50s', 59.94: '1001/60000s', 60: '1/60s' };
const rat = ms => `${Math.round(ms)}/1000s`;

function buildFCPXML() {
  const fps = FPS_RAT[S.fps] || '1/25s';
  const fmtName = `FFVideoFormat1080p${String(S.fps).replace('.', '')}`;
  const total = S.takes.reduce((a, t) => a + (t.endMs - t.startMs), 0);
  const date = new Date().toISOString().slice(0, 10);

  const assets = S.takes.map(t =>
    `    <asset id="a${t.num}" name="${xmlEsc(t.fname)}" start="0s" duration="${rat((t.offsetMs ?? S.syncOffset) + t.endMs - t.startMs)}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2" audioRate="48000">\n` +
    `      <media-rep kind="original-media" src="file:///localhost/RELINK/${xmlEsc(t.fname)}"/>\n    </asset>`
  ).join('\n');

  let offset = 0;
  const clips = S.takes.map(t => {
    const dur = t.endMs - t.startMs;
    const ofs = t.offsetMs ?? S.syncOffset;  // 플래시(앱 0초)의 소스 위치 — 카메라 선행 롤분
    const secs = (t.sections && t.sections.length) ? t.sections : [{ start: 0, end: dur, status: t.status }];
    return secs.map((sec, si) => {
      const len = sec.end - sec.start;
      let mk = '';
      if (si === 0) mk += `\n        <marker start="0s" duration="1/1000s" value="T${pad(t.num, 2)} ${TLBL[t.status] || t.status}" note="${xmlEsc(t.note)}"/>`;
      if (sec.status === 'NG') mk += `\n        <marker start="0s" duration="${rat(len)}" value="삭제 구간" note="${xmlEsc(t.note)}"/>`;
      for (const m of (t.memos || [])) {
        if (m.ms >= sec.start && m.ms < sec.end)
          mk += `\n        <marker start="${rat(m.ms - sec.start)}" duration="1/1000s" value="${xmlEsc(m.text.slice(0, 60))}" note="${xmlEsc(m.text)}"/>`;
      }
      const c = `      <asset-clip ref="a${t.num}" offset="${rat(offset)}" name="T${pad(t.num, 2)}.${si + 1} ${LBL[sec.status] || sec.status}" start="${rat(Math.max(0, sec.start + ofs))}" duration="${rat(len)}" format="r1" tcFormat="NDF" audioRole="dialogue">${mk}\n      </asset-clip>`;
      offset += len;
      return c;
    }).join('\n');
  }).join('\n');

  // 오프컷 AI 인식용 메타데이터 — 소유자 ID를 파일 안에 박아둠
  const meta = `\n    <metadata><md key="com.offcut.uid">${xmlEsc(S.uid)}</md><md key="com.offcut.app">offcut-director</md></metadata>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="${fmtName}" frameDuration="${fps}" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>
${assets}
  </resources>
  <library>${S.uid ? meta : ''}
    <event name="offcut-director ${date}">
      <project name="${xmlEsc(S.project)} 촬영로그 ${date}">
        <sequence format="r1" duration="${rat(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

function srtT(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60, mm = Math.floor(ms % 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(mm, 3)}`;
}
function buildSRT() {
  let i = 0, out = '', offset = 0;
  for (const t of S.takes) {
    const dur = t.endMs - t.startMs;
    (t.memos || []).forEach((m, idx) => {
      const next = t.memos[idx + 1];
      const end = next ? next.ms : Math.min(m.ms + 4000, dur);
      out += `${++i}\n${srtT(offset + m.ms)} --> ${srtT(offset + end)}\n[T${pad(t.num, 2)}] ${m.text}\n\n`;
    });
    offset += dur;
  }
  return out;
}

function buildCSV() {
  const rows = [['user', 'take', 'clip_file', 'sync_offset_s', 'status', 'start_time', 'end_time', 'duration', 'sections', 'note', 'memos']];
  for (const t of S.takes) {
    const segs = (t.sections || []).map(s => `${durStr(s.start)}-${durStr(s.end)} ${LBL[s.status] || s.status}`).join(' | ');
    rows.push([S.uid, t.num, t.fname, ((t.offsetMs ?? S.syncOffset) / 1000), TLBL[t.status] || t.status, clockStr(new Date(t.startMs)), clockStr(new Date(t.endMs)),
      durStr(t.endMs - t.startMs), segs, t.note,
      (t.memos || []).map(m => `${durStr(m.ms)} ${m.text}`).join(' | ')]);
  }
  return '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

async function sendFile(name, text, mime) {
  if (CAP && CAP.Filesystem && CAP.Share) {
    await CAP.Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', recursive: true });
    const { uri } = await CAP.Filesystem.getUri({ path: name, directory: 'CACHE' });
    await CAP.Share.share({ title: name, url: uri });
    return;
  }
  const f = new File([text], name, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const safeName = () => `${S.uid ? S.uid.replace(/[^\w.-]/g, '_') + '_' : ''}${S.project.replace(/\s+/g, '_')}_촬영로그_${new Date().toISOString().slice(0, 10)}`;

const blobToB64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

/* ---------- 내 저장소 업로드 (오프컷 AI 연동용) ---------- */
const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.ceil(b / 1024) + 'KB';
const mediaBytes = () => [...audioBlobs.values(), ...videoBlobs.values()].reduce((a, v) => a + v.blob.size, 0);

// 설정의 저장소 주소로 로그 파일 + 테이크 미디어를 multipart 한 번에 POST
// 서버 쪽에서 Basic auth(uid:upw) 확인 → uid 폴더 아래 파일 저장하는 구조를 상정
async function uploadAll() {
  const fd = new FormData();
  fd.append('uid', S.uid);
  fd.append('project', S.project);
  fd.append('app', 'offcut-director');
  const base = safeName();
  if (S.takes.length) {
    fd.append('files', new Blob([buildFCPXML()], { type: 'application/xml' }), base + '.fcpxml');
    fd.append('files', new Blob([buildCSV()], { type: 'text/csv' }), base + '.csv');
    const srt = buildSRT();
    if (srt) fd.append('files', new Blob([srt], { type: 'application/x-subrip' }), base + '.srt');
  }
  if ($('#expMedia').checked) {   // 영상·오디오는 용량이 크니 선택사항 — 로그만 보낼 수도 있음
    for (const [n, a] of [...audioBlobs.entries()].sort((x, y) => x[0] - y[0]))
      fd.append('files', a.blob, `T${pad(n, 2)}.${a.ext}`);
    for (const [n, v] of [...videoBlobs.entries()].sort((x, y) => x[0] - y[0])) {
      const t = S.takes.find(x => x.num === n);
      fd.append('files', v.blob, t ? vidName(t, v.ext) : `T${pad(n, 2)}.${v.ext}`);
    }
  }
  const res = await fetch(S.upUrl, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + b64(`${S.uid}:${S.upw}`) },
    body: fd,
  });
  if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
}

/* ---------- wiring ---------- */
/* ROLL은 꾹 눌러 시작 (오타치 방지 — 유령 롤은 카메라 파일 번호와 어긋남) */
{
  const rb = $('#btnRoll');
  let holdT = null;
  const endHold = () => { if (holdT) { clearTimeout(holdT); holdT = null; } rb.classList.remove('holding'); };
  rb.addEventListener('pointerdown', e => {
    e.preventDefault();
    rb.classList.add('holding');
    holdT = setTimeout(() => { holdT = null; rb.classList.remove('holding'); roll(); }, 650);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => rb.addEventListener(ev, endHold));
  rb.addEventListener('contextmenu', e => e.preventDefault());
}
document.querySelectorAll('.jbtn').forEach(b => b.addEventListener('click', () => sectionMark(b.dataset.j)));
$('#btnUndoSec').addEventListener('click', undoSection);
$('#btnCut').addEventListener('click', cut);
$('#sheetCancel').addEventListener('click', () => {
  if (S.cur) { delete S.cur.cutAt; save(); }
  $('#sheet').classList.add('hidden');
});
$('#sheetHold').addEventListener('click', () => { buzz(30); judge('KEEP', 'HOLD'); });
$('#memoSend').addEventListener('click', addMemo);
$('#memoInput').addEventListener('keydown', e => { if (e.key === 'Enter') addMemo(); });
document.querySelectorAll('.judge').forEach(b => b.addEventListener('click', () => { buzz(30); judge(b.dataset.s); }));

$('#takeList').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  const del = e.target.closest('[data-del]');
  const secEl = e.target.closest('.mline.sec');
  const ofsB = e.target.closest('.ofsbtn');
  if (ofsB) {
    const t = S.takes.find(x => x.num == ofsB.dataset.num);
    if (t) { t.offsetMs = (t.offsetMs ?? S.syncOffset) + +ofsB.dataset.ofs; save(); render(); }
    return;
  }
  if (secEl) {
    const t = S.takes.find(x => x.num == secEl.dataset.tnum);
    const s = t && t.sections[+secEl.dataset.si];
    if (s) { s.status = s.status === 'OK' ? 'KEEP' : s.status === 'KEEP' ? 'NG' : 'OK'; save(); render(); }
    return;
  }
  if (chip) {
    const t = S.takes.find(x => x.num == chip.dataset.num);
    t.status = t.status === 'OK' ? 'HOLD' : t.status === 'HOLD' ? 'NG' : 'OK';
    save(); render();
  }
  if (del) {
    const num = +del.dataset.del;
    if (confirm(`테이크 ${num} 로그 삭제?`)) {
      S.takes = S.takes.filter(x => x.num !== num);
      audioBlobs.delete(num);
      videoBlobs.delete(num);
      const later = S.takes.filter(x => x.num > num);
      if ((later.length || num === S.seq - 1) && confirm('이 롤을 카메라가 안 찍었나요? (맞으면 이후 테이크 번호·파일명을 하나씩 당깁니다)')) {
        later.forEach(t => { t.num--; t.fname = fileName(t.num); });
        S.seq--;
      }
      save(); render();
    }
  }
});

$('#btnExport').addEventListener('click', () => {
  const mb = mediaBytes();
  $('#expMediaSize').textContent = mb ? `— ${fmtSize(mb)}` : '— 녹화된 미디어 없음';
  $('#expMedia').disabled = !mb;
  $('#exportSheet').classList.remove('hidden');
});
$('#expCancel').addEventListener('click', () => $('#exportSheet').classList.add('hidden'));
// 시트 배경 탭으로 닫기 (보내기/설정만 — 판정 시트는 명시적 선택 필요)
['#exportSheet', '#setSheet'].forEach(id => {
  const el = $(id);
  el.addEventListener('click', e => { if (e.target === el) el.classList.add('hidden'); });
});
$('#expUp').addEventListener('click', async e => {
  if (!S.uid || !S.upUrl) return alert('설정에서 오프컷 ID·저장소 주소·비번을 먼저 입력하세요.');
  if (!S.takes.length && !audioBlobs.size && !videoBlobs.size) return alert('보낼 기록이 없습니다.');
  const btn = e.currentTarget, orig = btn.textContent;
  btn.disabled = true; btn.textContent = '전송 중…';
  try {
    await uploadAll();
    alert('내 저장소로 전송 완료');
    $('#exportSheet').classList.add('hidden');
  } catch (err) {
    alert('업로드 실패 — ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
});
$('#expFcp').addEventListener('click', () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  sendFile(safeName() + '.fcpxml', buildFCPXML(), 'application/xml');
});
$('#expSrt').addEventListener('click', () => {
  const srt = buildSRT();
  if (!srt) return alert('기록된 메모가 없습니다.');
  sendFile(safeName() + '.srt', srt, 'application/x-subrip');
});
$('#expCsv').addEventListener('click', () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  sendFile(safeName() + '.csv', buildCSV(), 'text/csv');
});
$('#expAud').addEventListener('click', async () => {
  if (!audioBlobs.size) return alert('녹음된 오디오가 없습니다. (설정에서 마이크 녹음을 켜고 롤하세요)');
  const files = [...audioBlobs.entries()].sort((a, b) => a[0] - b[0])
    .map(([n, { blob, ext }]) => ({ name: `T${pad(n, 2)}.${ext}`, blob }));
  if (CAP && CAP.Filesystem && CAP.Share) {
    const urls = [];
    for (const f of files) {
      await CAP.Filesystem.writeFile({ path: f.name, data: await blobToB64(f.blob), directory: 'CACHE', recursive: true });
      urls.push((await CAP.Filesystem.getUri({ path: f.name, directory: 'CACHE' })).uri);
    }
    await CAP.Share.share({ files: urls });
    return;
  }
  const fs = files.map(f => new File([f.blob], f.name, { type: f.blob.type }));
  if (navigator.canShare && navigator.canShare({ files: fs })) {
    try { await navigator.share({ files: fs }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  fs.forEach((f, i) => setTimeout(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name; a.click();
  }, i * 400));
});
$('#expVid').addEventListener('click', async () => {
  if (!videoBlobs.size) return alert('녹화된 영상이 없습니다. (설정에서 앱 안 카메라를 켜고 롤하세요)');
  const files = [...videoBlobs.entries()].sort((a, b) => a[0] - b[0]).map(([n, v]) => {
    const t = S.takes.find(x => x.num === n);
    return { name: t ? vidName(t, v.ext) : `T${pad(n, 2)}.${v.ext}`, blob: v.blob };
  });
  if (CAP && CAP.Filesystem && CAP.Share) {
    const urls = [];
    for (const f of files) {
      await CAP.Filesystem.writeFile({ path: f.name, data: await blobToB64(f.blob), directory: 'CACHE', recursive: true });
      urls.push((await CAP.Filesystem.getUri({ path: f.name, directory: 'CACHE' })).uri);
    }
    await CAP.Share.share({ files: urls });
    return;
  }
  const fs = files.map(f => new File([f.blob], f.name, { type: f.blob.type }));
  if (navigator.canShare && navigator.canShare({ files: fs })) {
    try { await navigator.share({ files: fs }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  fs.forEach((f, i) => setTimeout(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name; a.click();
  }, i * 400));
});

/* 카메라 전면/후면 전환 — 롤 중엔 녹화가 끊기므로 잠금 */
$('#camFlip').addEventListener('click', async () => {
  if (S.cur || !S.cam) return;
  S.camFacing = S.camFacing === 'user' ? 'environment' : 'user';
  save();
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  await camOn();
});

$('#btnSettings').addEventListener('click', () => {
  $('#setProject').value = S.project;
  $('#setFps').value = String(S.fps);
  $('#setPrefix').value = S.prefix;
  $('#setStartNo').value = S.startNo;
  $('#setSync').value = S.syncOffset / 1000;
  $('#setSlate').checked = S.slate;
  $('#setSound').checked = S.sound;
  $('#setMic').checked = S.mic;
  $('#setCam').checked = S.cam;
  $('#setUid').value = S.uid;
  $('#setUpUrl').value = S.upUrl;
  $('#setUpw').value = S.upw;
  $('#setSheet').classList.remove('hidden');
});
$('#setClose').addEventListener('click', () => {
  S.project = $('#setProject').value.trim() || '오늘의 촬영';
  S.fps = parseFloat($('#setFps').value);
  S.prefix = $('#setPrefix').value.trim() || 'C';
  S.startNo = +$('#setStartNo').value || 1;
  S.slate = $('#setSlate').checked;
  S.sound = $('#setSound').checked;
  S.syncOffset = (+$('#setSync').value || 0) * 1000;
  S.mic = $('#setMic').checked;
  S.uid = $('#setUid').value.trim();
  S.upUrl = $('#setUpUrl').value.trim();
  S.upw = $('#setUpw').value;
  const camWas = S.cam;
  S.cam = $('#setCam').checked;
  save(); render();
  if (S.cam && !camWas) camOn();          // 롤 중이 아니면 다음 테이크부터 녹화
  if (!S.cam && camWas) camOff();
  $('#setSheet').classList.add('hidden');
});
$('#setReset').addEventListener('click', () => {
  if (confirm('테이크 로그를 전부 삭제할까요? (되돌릴 수 없음)')) {
    if (S.cur) { micStop(S.cur.num, false); vStop(S.cur.num, false); }   // 롤 중 리셋이면 녹화는 버림
    S.takes = []; S.seq = 1; S.cur = null; audioBlobs.clear(); videoBlobs.clear();
    setWake(false);
    save(); render();
    $('#setSheet').classList.add('hidden');
    document.body.classList.remove('rolling');
  }
});

render();
if (S.cam) camOn().then(() => { if (S.cur) vStart(); });   // 카메라 모드면 프리뷰 복원 + 롤 중이면 녹화 재개
else if (S.cur && S.mic) micStart();   // 롤 중 앱 재시작 → 녹음 재개 (권한 물어볼 수 있음)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
