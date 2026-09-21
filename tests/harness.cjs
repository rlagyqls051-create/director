const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function app(options = {}) {
  const dom = new JSDOM(html, { url: 'https://review.invalid/', runScripts: 'outside-only' });
  const w = dom.window;
  let now = 100000, nextId = 1, peak = 0;
  const raf = new Map(), pending = [], streams = [], recorders = [], alerts = [], stops = [];
  w.setInterval = () => 1;
  w.setTimeout = () => 1;
  w.clearTimeout = () => {};
  w.requestAnimationFrame = fn => { const id = nextId++; raf.set(id, fn); return id; };
  w.cancelAnimationFrame = id => raf.delete(id);
  w.Date.now = () => now;
  w.confirm = () => true;
  w.alert = message => alerts.push(message);
  for (const [k, v] of Object.entries(options.storage || {})) w.localStorage.setItem(k, v);
  if (options.storageFail) w.Storage.prototype.setItem = () => { throw new Error('Quota exceeded'); };
  function stream() {
    const s = { id: streams.length + 1, stopped: false };
    s.getTracks = () => [{ stop: () => { s.stopped = true; } }];
    streams.push(s); return s;
  }
  w.navigator.mediaDevices = { getUserMedia: () => options.pendingMic
    ? new Promise(resolve => pending.push(() => resolve(stream()))) : Promise.resolve(stream()) };
  w.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(s, opts) { this.stream = s; this.mimeType = opts?.mimeType || 'audio/webm'; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    requestData() { this.ondataavailable?.({ data: new w.Blob(['audio-' + this.stream.id]), timecode: now }); }
    stop() {
      this.state = 'inactive';
      const finish = () => { this.requestData(); this.onstop?.(); };
      if (options.pendingStop) stops.push(finish); else finish();
    }
  };
  w.AudioContext = class {
    constructor() { if (options.audioContextFail) throw new Error('No audio context'); }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: buf => buf.fill(peak) }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { return Promise.resolve(); }
  };
  if (options.native) w.Capacitor = { isNativePlatform: () => true, Plugins: options.native };
  const helper = path.join(root, 'export-xml.js');
  if (fs.existsSync(helper)) w.eval(fs.readFileSync(helper, 'utf8'));
  w.eval(source + '\nwindow.review = {get S(){return S},set S(v){S=v}, fresh, save, roll, cut, judge, render, micStart, micStop, buildSRT, audioBlobs, get rec(){return rec}};');
  w.review.S.slate = false; w.review.S.sound = false;
  return { w, api: w.review, streams, recorders, pending, stops, alerts,
    at: t => { now = t; }, peak: p => { peak = p; },
    tick: () => { const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(f => f()); },
    click: selector => w.document.querySelector(selector).click(),
    snapshot: () => Object.fromEntries(Object.keys(w.localStorage).map(k => [k, w.localStorage.getItem(k)])),
    close: () => dom.window.close() };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function audio(app) {
  return Promise.all([...app.api.audioBlobs.entries()].map(async ([num, {blob}]) => {
    const content = await new Promise(resolve => { const r = new app.w.FileReader(); r.onload = () => resolve(r.result); r.readAsText(blob); });
    return { num, content };
  }));
}
async function record(app, start) {
  app.at(start); app.api.roll(); await flush(); app.at(start + 1000); app.api.cut(); app.api.judge('OK'); await flush();
}
module.exports = { app, flush, audio, record };
