const test = require('node:test');
const assert = require('node:assert/strict');
const { app, flush, audio, record } = require('./harness.cjs');
function setup(t, options) { const a = app(options); t.after(() => a.close()); return a; }

test('legacy state survives migration and an immediate reload', async t => {
  const original = setup(t); await record(original, 100000);
  const loaded = setup(t, { storage: { 'offcut.v1': JSON.stringify(original.api.S) } });
  const reloaded = setup(t, { storage: loaded.snapshot() });
  assert.equal(reloaded.api.S.takes.length, 1);
});
test('failed migration leaves the only stored copy intact', async t => {
  const original = setup(t); await record(original, 100000);
  const data = JSON.stringify(original.api.S);
  const loaded = setup(t, { storage: { 'director.v1': data }, storageFail: true });
  assert.equal(loaded.snapshot()['director.v1'], data);
});
test('ghost deletion preserves each recording under its new number', async t => {
  const a = setup(t); a.api.S.mic = true;
  for (let i = 0; i < 3; i++) await record(a, 100000 + i * 5000);
  a.click('[data-del="1"]');
  assert.deepEqual((await audio(a)).map(x => x.num), [1, 2]);
  await record(a, 120000);
  assert.match((await audio(a)).find(x => x.num === 2).content, /audio-3/);
});
test('ghost deletion during a roll renumbers the current take and next sequence together', async t => {
  const a = setup(t); await record(a, 100000); await record(a, 105000);
  a.at(110000); a.api.roll(); a.click('[data-del="1"]');
  assert.equal(a.api.S.cur.num, a.api.S.seq);
  a.at(111000); a.api.cut(); a.api.judge('OK'); a.api.roll();
  assert.ok(!a.api.S.takes.some(take => take.num === a.api.S.cur.num));
});
test('late microphone permission cannot attach a previous request to a new take', async t => {
  const a = setup(t, { pendingMic: true }); a.api.S.mic = true;
  a.api.roll(); a.at(101000); a.api.cut(); a.api.judge('OK'); a.at(102000); a.api.roll();
  a.pending[0](); await flush(); a.pending[1](); await flush();
  a.at(103000); a.api.cut(); a.api.judge('OK'); await flush();
  assert.ok(a.streams.every(s => s.stopped));
  assert.ok(a.recorders.every(r => r.state === 'inactive'));
});
test('microphone setup failure releases its stream and recorder', async t => {
  const a = setup(t, { audioContextFail: true }); a.api.S.mic = true;
  a.api.roll(); await flush();
  assert.ok(a.streams.every(s => s.stopped));
  assert.ok(a.recorders.every(r => r.state === 'inactive'));
});
test('pending stop cannot resurrect audio after reset', async t => {
  const a = setup(t, { pendingStop: true }); a.api.S.mic = true;
  await record(a, 100000); a.click('#setReset'); a.stops.forEach(fn => fn()); await flush();
  assert.equal(a.api.audioBlobs.size, 0);
});
test('CUT freezes memo detection and keeps exported cues inside take bounds', async t => {
  const a = setup(t); a.api.S.mic = true;
  a.api.roll(); await flush(); a.at(101000); a.api.cut(); a.at(103000); a.peak(0.9); a.tick(); a.api.judge('OK');
  assert.ok(a.api.S.takes[0].memos.every(m => m.ms <= 1000));
  assert.equal(a.api.buildSRT(), '');
});
test('cancelling CUT preserves continuous time and resumes marking', async t => {
  const a = setup(t); a.api.roll(); a.at(101000); a.api.cut(); a.at(103000); a.click('#sheetCancel');
  a.w.document.querySelector('#memoInput').value = '계속 촬영'; a.click('#memoSend');
  a.at(104000); a.api.cut(); a.api.judge('OK');
  assert.equal(a.api.S.takes[0].endMs - a.api.S.takes[0].startMs, 4000);
  assert.equal(a.api.S.takes[0].memos[0].ms, 3000);
});
test('a pending stop follows renumbering and does not write under the old number', async t => {
  const a = setup(t, { pendingStop: true }); a.api.S.mic = true;
  await record(a, 100000); a.stops.shift()();
  await record(a, 105000); a.click('[data-del="1"]'); a.stops.shift()(); await flush();
  assert.deepEqual([...a.api.audioBlobs.keys()], [1]);
  assert.match((await audio(a))[0].content, /audio-2/);
});
test('a deleted take cannot be resurrected by its pending recorder stop', async t => {
  const a = setup(t, { pendingStop: true }); a.api.S.mic = true;
  await record(a, 100000); a.click('[data-del="1"]'); a.stops.shift()();
  assert.equal(a.api.audioBlobs.size, 0);
});
test('reload during CUT restores the decision sheet and original end timestamp', async t => {
  const a = setup(t); a.api.roll(); a.at(101000); a.api.cut();
  const b = setup(t, { storage: a.snapshot() }); b.at(120000);
  assert.ok(!b.w.document.querySelector('#sheet').classList.contains('hidden'));
  b.api.judge('OK');
  assert.equal(b.api.S.takes[0].endMs, 101000);
});
test('legacy out-of-range or equal-time memos cannot produce reversed or empty SRT cues', async t => {
  const a = setup(t); await record(a, 100000);
  a.api.S.takes[0].memos = [{ms:3000,text:'too late'}, {ms:500,text:'first'}, {ms:500,text:'same time'}, {ms:-1,text:'negative'}];
  const srt = a.api.buildSRT();
  assert.match(srt, /00:00:00,500 --> 00:00:01,000/);
  assert.match(srt, /first\nsame time/);
  assert.doesNotMatch(srt, /too late|negative/);
});
test('repeat CUT does not move the endpoint and ordinary marking is frozen', async t => {
  const a = setup(t); a.api.roll(); a.at(101000); a.api.cut(); a.at(102000); a.api.cut();
  a.w.document.querySelector('[data-j="NG"]').click();
  a.w.document.querySelector('#memoInput').value = 'late'; a.click('#memoSend'); a.api.judge('OK');
  assert.equal(a.api.S.takes[0].endMs, 101000);
  assert.equal(a.api.S.takes[0].sections.length, 1);
  assert.equal(a.api.S.takes[0].memos.length, 0);
});
test('take note and filename are rendered as text', async t => {
  const a = setup(t); a.api.S.prefix = '<b>';
  a.api.roll(); a.at(101000); a.api.cut(); a.w.document.querySelector('#sheetNote').value = '<img src=x onerror=alert(1)>'; a.api.judge('OK');
  assert.equal(a.w.document.querySelector('#takeList img'), null);
  assert.match(a.w.document.querySelector('#takeList').textContent, /<img src=x/);
});
test('fractional frame endpoints cannot collapse a cue to zero milliseconds', async t => {
  const a = setup(t); a.api.S.fps = 30; a.api.roll();
  a.at(100166); a.w.document.querySelector('#memoInput').value = 'last fraction'; a.click('#memoSend');
  a.at(100167); a.api.cut(); a.api.judge('OK');
  assert.equal(a.api.buildSRT(), '');
});
