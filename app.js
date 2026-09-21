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
    takes: [],          // {num, fname, startMs, endMs, status, sections:[{start,end,status}], memos:[{ms,text}], note}
    seq: 1,
    cur: null,          // rolling take: {num, fname, startMs, secStart, sections:[], memos:[]}
  };
}
let S;
try {
  const raw = localStorage.getItem(LS_KEY) || localStorage.getItem('offcut.v1') || localStorage.getItem('director.v1');
  const stored = JSON.parse(raw);
  if (stored && !Array.isArray(stored.takes)) throw new Error('Invalid saved takes');
  S = stored && Array.isArray(stored.takes) ? { ...fresh(), ...stored } : fresh();
  // Write the replacement before deleting either legacy copy. A quota error must
  // leave the previous session available on the next launch.
  if (raw) {
    localStorage.setItem(LS_KEY, JSON.stringify(S));
    localStorage.removeItem('offcut.v1'); localStorage.removeItem('director.v1');
  }
} catch {
  S = S || fresh();
  alert('촬영 로그를 저장하지 못했습니다. 기존 기록은 보관했습니다. 저장 공간을 확인하고 CSV로 기록을 보내 주세요.');
}
S.takes.forEach(t => { if (t.status === 'KEEP') t.status = 'HOLD'; });
if (S.syncOffset == null) S.syncOffset = 0;
if (S.mic == null) S.mic = false;
const save = () => {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); }
  catch { alert('촬영 로그를 저장하지 못했습니다. 앱을 닫기 전에 CSV로 기록을 보내 주세요.'); }
};

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
let rec = null;                     // {mr, stream, ctx, chunks, ext, raf}
const audioBlobs = new Map();       // takeNum → {blob, ext}  (메모리만 — 앱 재시작 시 소실)
let micRequest = 0;
let micPending = null;

function releaseMic(r) {
  cancelAnimationFrame(r.raf);
  r.stream?.getTracks().forEach(t => t.stop());
  if (r.ctx) r.ctx.close().catch(() => {});
}

async function micStart() {
  if (!S.mic || rec || micPending || !S.cur || S.cur.cutAt != null) return;
  const take = S.cur, request = ++micRequest;
  micPending = request;
  let stream, mr, ctx;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (request !== micRequest || S.cur !== take || take.cutAt != null || rec) {
      stream.getTracks().forEach(t => t.stop()); return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    mr.start(500);
    // 트랜지언트(박수/슬레이트) 감지: 순간 피크가 롤링 베이스라인의 4배 이상
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let base = 0.02, lastClap = -1e9;
    const tick = () => {
      if (rec !== recording || S.cur !== take) return;
      if (take.cutAt != null) { recording.raf = requestAnimationFrame(tick); return; }
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      const now = Date.now() - take.startMs;
      base = base * 0.98 + peak * 0.02;
      if (peak > 0.5 && peak > base * 4 && now - lastClap > 400) {
        lastClap = now;
        take.memos.push({ ms: Math.round(now), text: '슬레이트 감지' });
        save(); render();
      }
      recording.raf = requestAnimationFrame(tick);
    };
    const recording = { mr, stream, ctx, chunks, take, ext: mime.includes('mp4') ? 'm4a' : 'webm' };
    rec = recording;
    mr.onerror = () => {
      recording.failed = true;
      if (rec === recording) rec = null;
      try { if (mr.state !== 'inactive') mr.stop(); } catch {}
      releaseMic(recording);
      alert('마이크 녹음이 중단됐습니다. 촬영 로그는 계속 기록할 수 있습니다.');
    };
    rec.raf = requestAnimationFrame(tick);
  } catch {
    try { if (mr && mr.state !== 'inactive') mr.stop(); } catch {}
    releaseMic({ stream, ctx });
    if (request === micRequest) alert('마이크를 시작하지 못했습니다. 마이크 권한을 확인해 주세요. 촬영 로그는 계속 기록됩니다.');
  } finally { if (micPending === request) micPending = null; }
}

function micStop(num, keep = true) {
  micRequest++; micPending = null;
  if (!rec) return;
  const r = rec; rec = null;
  cancelAnimationFrame(r.raf);
  r.mr.onstop = () => {
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/mp4' });
    if (keep && !r.failed && blob.size && S.takes.includes(r.take)) audioBlobs.set(r.take.num, { blob, ext: r.ext });
    releaseMic(r);
  };
  try { r.mr.stop(); } catch { releaseMic(r); }
  // Stop tracks immediately even when the final data/stop events are delayed.
  r.stream.getTracks().forEach(t => t.stop());
}

/* ---------- roll / cut / ng ---------- */
function roll() {
  if (S.cur) return;
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
  micStart();
  render();
}

function sectionMark(status) {
  if (!S.cur || S.cur.cutAt != null) return;
  buzz(25);
  const now = Date.now() - S.cur.startMs;
  if (now - S.cur.secStart < 300) return; // 0.3초 미만 구간 무시 (오타치 방지)
  S.cur.sections.push({ start: S.cur.secStart, end: now, status });
  S.cur.secStart = now;
  save(); render();
}

function undoSection() {
  if (!S.cur || S.cur.cutAt != null || !S.cur.sections.length) return;
  buzz(15);
  S.cur.secStart = S.cur.sections.pop().start;
  save(); render();
}

function addMemo() {
  if (!S.cur || S.cur.cutAt != null) return;
  const text = $('#memoInput').value.trim();
  if (!text) return;
  buzz(10);
  S.cur.memos.push({ ms: Date.now() - S.cur.startMs, text });
  $('#memoInput').value = '';
  save(); render();
  const f = $('#memoFeed'); f.scrollTop = f.scrollHeight;
}

function cut() {
  if (!S.cur || S.cur.cutAt != null) return;
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
  const end = S.cur.cutAt ?? Date.now();
  const rel = end - S.cur.startMs;
  if (rel - S.cur.secStart >= 1) S.cur.sections.push({ start: S.cur.secStart, end: rel, status: secStatus });
  const secs = S.cur.sections;
  const auto = secs.every(s => s.status === 'NG') ? 'NG' : secs.some(s => s.status === 'OK') ? 'OK' : 'HOLD';
  Object.assign(S.cur, { endMs: end, status: takeStatus || auto, sections: secs,
    memos: S.cur.memos.filter(m => m.ms >= 0 && m.ms < rel), note: $('#sheetNote').value.trim() });
  S.takes.push(S.cur);
  micStop(S.cur.num);
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
    const note = t.note ? ` · ${xmlEsc(t.note)}` : '';
    const secN = (t.sections || []).length;
    const secInfo = secN > 1 ? `구간${secN}` : '';
    return `<div class="trow">
      <span class="tno">T${pad(t.num, 2)}</span>
      <span class="tfile">${xmlEsc(t.fname)}</span>
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
    const rel = (S.cur.cutAt ?? now) - S.cur.startMs;
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
function buildPremiereXML() { return window.OFFCUT_XML.build(S); }

function srtT(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60, mm = Math.floor(ms % 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(mm, 3)}`;
}
function buildSRT() {
  let i = 0, out = '', offsetFrames = 0;
  const fps = window.OFFCUT_XML.frameRate(S.fps).actual;
  for (const t of S.takes) {
    const dur = Math.round(t.endMs - t.startMs);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    const takeFrames = Math.max(1, Math.round(dur * fps / 1000));
    const cueLimit = Math.min(dur, takeFrames * 1000 / fps);
    const offset = offsetFrames * 1000 / fps;
    const grouped = new Map();
    for (const m of t.memos || []) {
      const at = Math.round(Number(m.ms));
      if (!Number.isFinite(at) || at < 0 || at >= cueLimit) continue;
      grouped.set(at, [...(grouped.get(at) || []), m.text]);
    }
    const memos = [...grouped].sort((a, b) => a[0] - b[0]).map(([ms, texts]) => ({ ms, text: texts.join('\n') }));
    memos.forEach((m, idx) => {
      const next = memos[idx + 1];
      const end = next ? next.ms : Math.min(m.ms + 4000, cueLimit);
      const startMs = Math.floor(offset + m.ms), endMs = Math.floor(offset + end);
      if (endMs <= startMs) return;
      out += `${++i}\n${srtT(startMs)} --> ${srtT(endMs)}\n[T${pad(t.num, 2)}] ${m.text}\n\n`;
    });
    offsetFrames += takeFrames;
  }
  return out;
}

function buildCSV() {
  const rows = [['take', 'clip_file', 'sync_offset_s', 'status', 'start_time', 'end_time', 'duration', 'sections', 'note', 'memos']];
  for (const t of S.takes) {
    const segs = (t.sections || []).map(s => `${durStr(s.start)}-${durStr(s.end)} ${LBL[s.status] || s.status}`).join(' | ');
    rows.push([t.num, t.fname, ((t.offsetMs ?? S.syncOffset) / 1000), TLBL[t.status] || t.status, clockStr(new Date(t.startMs)), clockStr(new Date(t.endMs)),
      durStr(t.endMs - t.startMs), segs, t.note,
      (t.memos || []).map(m => `${durStr(m.ms)} ${m.text}`).join(' | ')]);
  }
  return '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

async function sendFile(name, text, mime) {
  if (CAP && CAP.Filesystem && CAP.Share) {
    await CAP.Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', recursive: true, encoding: 'utf8' });
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

async function exportSafely(action) {
  try { await action(); }
  catch (error) {
    if (error?.name === 'ExportValidationError') alert(error.message);
    else if (error?.name !== 'AbortError') alert('파일을 보내지 못했습니다. 저장 공간과 공유 권한을 확인하고 다시 시도해 주세요.');
  }
}

const safeName = () => `${S.project.replace(/[\s/\\:*?"<>|\u0000-\u001f]+/g, '_')}_촬영로그_${new Date().toISOString().slice(0, 10)}`;

const blobToB64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

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
  if (S.cur) { delete S.cur.cutAt; save(); micStart(); }
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
      const later = S.takes.filter(x => x.num > num);
      if ((later.length || num === S.seq - 1) && confirm('이 롤을 카메라가 안 찍었나요? (맞으면 이후 테이크 번호·파일명을 하나씩 당깁니다)')) {
        later.forEach(t => { t.num--; t.fname = fileName(t.num); });
        if (S.cur && S.cur.num > num) { S.cur.num--; S.cur.fname = fileName(S.cur.num); }
        const renumbered = [...audioBlobs].map(([n, value]) => [n > num ? n - 1 : n, value]);
        audioBlobs.clear(); renumbered.forEach(([n, value]) => audioBlobs.set(n, value));
        S.seq--;
      }
      save(); render();
    }
  }
});

$('#btnExport').addEventListener('click', () => $('#exportSheet').classList.remove('hidden'));
$('#expCancel').addEventListener('click', () => $('#exportSheet').classList.add('hidden'));
// 시트 배경 탭으로 닫기 (보내기/설정만 — 판정 시트는 명시적 선택 필요)
['#exportSheet', '#setSheet'].forEach(id => {
  const el = $(id);
  el.addEventListener('click', e => { if (e.target === el) el.classList.add('hidden'); });
});
$('#expFcp').addEventListener('click', () => exportSafely(async () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  await sendFile(safeName() + '.xml', buildPremiereXML(), 'application/xml');
}));
$('#expSrt').addEventListener('click', () => exportSafely(async () => {
  const srt = buildSRT();
  if (!srt) return alert('기록된 메모가 없습니다.');
  await sendFile(safeName() + '.srt', srt, 'application/x-subrip');
}));
$('#expCsv').addEventListener('click', () => exportSafely(async () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  await sendFile(safeName() + '.csv', buildCSV(), 'text/csv');
}));
$('#expAud').addEventListener('click', () => exportSafely(async () => {
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
}));

$('#btnSettings').addEventListener('click', () => {
  $('#setProject').value = S.project;
  $('#setFps').value = String(S.fps);
  $('#setPrefix').value = S.prefix;
  $('#setStartNo').value = S.startNo;
  $('#setSync').value = S.syncOffset / 1000;
  $('#setSlate').checked = S.slate;
  $('#setSound').checked = S.sound;
  $('#setMic').checked = S.mic;
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
  save(); render();
  $('#setSheet').classList.add('hidden');
});
$('#setReset').addEventListener('click', () => {
  if (confirm('테이크 로그를 전부 삭제할까요? (되돌릴 수 없음)')) {
    if (S.cur) micStop(S.cur.num, false);   // 롤 중 리셋이면 녹음은 버림
    S.takes = []; S.seq = 1; S.cur = null; audioBlobs.clear();
    setWake(false);
    save(); render();
    $('#setSheet').classList.add('hidden');
    document.body.classList.remove('rolling');
  }
});

render();
if (S.cur && S.cur.cutAt != null) {
  $('#sheetTitle').textContent = `테이크 ${S.cur.num} 종료 — 마지막 구간 판정`;
  $('#sheetClock').textContent = msToTC(S.cur.cutAt - S.cur.startMs);
  $('#sheet').classList.remove('hidden');
}
if (S.cur && S.mic) micStart();   // 롤 중 앱 재시작 → 녹음 재개 (권한 물어볼 수 있음)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
