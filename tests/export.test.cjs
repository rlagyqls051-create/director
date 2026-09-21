const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { app, record, flush } = require('./harness.cjs');

function parse(xml) {
  const doc = new JSDOM('').window.DOMParser;
  const result = new doc().parseFromString(xml, 'text/xml');
  assert.equal(result.querySelector('parsererror'), null);
  return result;
}
function setup(t, native) { const a = app({ native }); t.after(() => a.close()); return a; }
function nativeSink(fail) {
  const writes = [], shares = [];
  let written;
  const nextWrite = new Promise(resolve => { written = resolve; });
  return { writes, shares, nextWrite, plugins: {
    Filesystem: { writeFile: async args => { if (fail) throw new Error('disk full'); writes.push(args); written(); },
      getUri: async ({path}) => ({uri: 'file:///cache/' + path}) },
    Share: { share: async args => shares.push(args) },
  }};
}
test('actual XML button sends UTF8 FCP7 XML with linked video and stereo audio', async t => {
  const sink = nativeSink(); const a = setup(t, sink.plugins);
  a.api.S.prefix = '촬영 &'; await record(a, 100000);
  a.click('#expFcp'); await flush();
  assert.equal(sink.writes[0].encoding, 'utf8');
  assert.match(sink.writes[0].path, /\.xml$/);
  const doc = parse(sink.writes[0].data);
  assert.equal(doc.documentElement.tagName, 'xmeml');
  assert.equal(doc.documentElement.getAttribute('version'), '4');
  assert.equal(doc.querySelectorAll('sequence > media > video > track > clipitem').length, 1);
  assert.equal(doc.querySelectorAll('sequence > media > audio > track > clipitem').length, 2);
  const clips = [...doc.querySelectorAll('clipitem')];
  for (const clip of clips) {
    assert.equal(clip.querySelectorAll(':scope > link').length, 3);
    for (const link of clip.querySelectorAll('linkclipref')) assert.ok(clips.some(c => c.id === link.textContent));
  }
  assert.equal(new URL(doc.querySelector('pathurl').textContent).pathname, '/RELINK/%EC%B4%AC%EC%98%81%20%260001.MP4');
});
test('export failure is handled without an unhandled rejection', async t => {
  const sink = nativeSink(true); const a = setup(t, sink.plugins); await record(a, 100000);
  a.click('#expCsv'); await flush();
  assert.equal(sink.shares.length, 0);
  assert.ok(a.alerts.some(x => x.includes('보내')));
});
test('all supported rates use integer nominal timebase and exact NTSC frame counts', async t => {
  for (const [fps, nominal, ntsc] of [[23.976,24,true],[24,24,false],[25,25,false],[29.97,30,true],[30,30,false],[50,50,false],[59.94,60,true],[60,60,false]]) {
    const sink = nativeSink(); const a = setup(t, sink.plugins); a.api.S.fps = fps;
    a.api.roll(); a.at(3700000); a.api.cut(); a.api.judge('OK'); a.click('#expFcp'); await flush();
    const doc = parse(sink.writes[0].data);
    assert.equal(+doc.querySelector('sequence > rate > timebase').textContent, nominal);
    assert.equal(doc.querySelector('sequence > rate > ntsc').textContent, ntsc ? 'TRUE' : 'FALSE');
    assert.equal(+doc.querySelector('sequence > duration').textContent, Math.round(3600 * nominal * (ntsc ? 1000 / 1001 : 1)));
  }
});
test('negative offset trims unavailable source while preserving timeline and memo position', async t => {
  const sink = nativeSink(); const a = setup(t, sink.plugins); a.api.S.syncOffset = -1000;
  a.api.roll(); a.at(100500); a.w.document.querySelector('[data-j="NG"]').click();
  a.at(101500); a.w.document.querySelector('#memoInput').value = '한글 & <메모>'; a.click('#memoSend');
  a.at(102000); a.api.cut(); a.api.judge('OK'); a.click('#expFcp'); await flush();
  const doc = parse(sink.writes[0].data), clip = doc.querySelector('video > track > clipitem');
  assert.equal(+clip.querySelector(':scope > start').textContent, 25);
  assert.equal(+clip.querySelector(':scope > end').textContent, 50);
  assert.equal(+clip.querySelector(':scope > in').textContent, 0);
  assert.equal(+clip.querySelector(':scope > out').textContent, 25);
  assert.equal(+doc.querySelector('sequence > duration').textContent, 50);
  const memo = [...doc.querySelectorAll('sequence > marker')].find(m => m.querySelector('name').textContent.includes('한글'));
  assert.equal(+memo.querySelector('in').textContent, 38);
});
test('section boundaries preserve positive source offset, links and NG range markers', async t => {
  const sink = nativeSink(); const a = setup(t, sink.plugins); a.api.S.syncOffset = 1000;
  a.api.roll(); a.at(101000); a.w.document.querySelector('[data-j="NG"]').click();
  a.at(102000); a.api.cut(); a.api.judge('OK');
  await record(a, 105000); a.click('#expFcp'); await flush();
  const doc = parse(sink.writes[0].data);
  const clips = [...doc.querySelectorAll('sequence > media > video > track > clipitem')];
  assert.deepEqual(clips.map(c => ['start','end','in','out'].map(n => +c.querySelector(':scope > ' + n).textContent)),
    [[0,25,25,50],[25,50,50,75],[50,75,25,50]]);
  assert.equal(+doc.querySelector('sequence > duration').textContent, 75);
  for (const [i, clip] of clips.entries()) {
    assert.ok([...clip.querySelectorAll('link > clipindex')].every(n => +n.textContent === i + 1));
  }
  const ng = [...doc.querySelectorAll('sequence > marker')].find(m => m.querySelector('name').textContent === '삭제 구간');
  assert.equal(+ng.querySelector('in').textContent, 0);
  assert.equal(+ng.querySelector('out').textContent, 25);
});
test('binary recording export remains base64 without text encoding', { timeout: 2000 }, async t => {
  const sink = nativeSink(); const a = setup(t, sink.plugins); a.api.S.mic = true;
  await record(a, 100000); a.click('#expAud'); await sink.nextWrite;
  assert.equal(sink.writes.length, 1);
  assert.equal(sink.writes[0].encoding, undefined);
  assert.equal(Buffer.from(sink.writes[0].data, 'base64').toString(), 'audio-1');
});
test('invalid export input produces a useful message and writes no file', async t => {
  const sink = nativeSink(); const a = setup(t, sink.plugins); await record(a, 100000);
  a.api.S.takes[0].sections[0].end = 2000;
  a.click('#expFcp'); await flush();
  assert.equal(sink.writes.length, 0);
  assert.ok(a.alerts.some(x => x.includes('구간 시간이 테이크 범위를')));
});
test('SRT offsets accumulate the same whole frames as the XML timeline', async t => {
  const sink = nativeSink(); const a = setup(t, sink.plugins);
  for (let i = 0; i < 10; i++) {
    a.at(100000 + i * 2000); a.api.roll(); a.at(101010 + i * 2000); a.api.cut(); a.api.judge('OK');
  }
  a.at(130000); a.api.roll(); a.w.document.querySelector('#memoInput').value = 'eleventh'; a.click('#memoSend');
  a.at(131000); a.api.cut(); a.api.judge('OK');
  assert.match(a.api.buildSRT(), /00:00:10,000 --> 00:00:11,000/);
});
test('a subframe take keeps its minimum frame and the next take starts at that boundary', async t => {
  const sink = nativeSink(); const a = setup(t, sink.plugins);
  a.api.roll(); a.at(100001); a.api.cut(); a.api.judge('OK');
  a.at(105000); a.api.roll(); a.at(105001); a.api.cut(); a.api.judge('OK');
  a.click('#expFcp'); await flush();
  assert.equal(sink.writes.length, 1, 'subframe takes must produce a file, not just an export alert');
  const doc = parse(sink.writes[0].data);
  const clips = [...doc.querySelectorAll('sequence > media > video > track > clipitem')];
  assert.deepEqual(clips.map(c => ['start','end','in','out'].map(n => +c.querySelector(':scope > ' + n).textContent)), [[0,1,0,1],[1,2,0,1]]);
  assert.equal(+doc.querySelector('sequence > duration').textContent, 2);
});
