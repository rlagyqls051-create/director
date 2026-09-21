/* FCP7 XML interchange v4. Offline file references are relinked in Premiere. */
(function (root) {
  'use strict';
  const labels = { OK: '편집에쓰자', KEEP: '특이사항', HOLD: '보류', NG: '삭제' };
  function invalid(message) { const error = new Error(message); error.name = 'ExportValidationError'; throw error; }
  const esc = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function frameRate(fps) {
    const value = Number(fps);
    const ntsc = [23.976, 29.97, 59.94].includes(value);
    if (!ntsc && ![24, 25, 30, 50, 60].includes(value)) invalid('지원하지 않는 프레임레이트입니다. 설정을 확인해 주세요.');
    const nominal = Math.round(value);
    return { nominal, ntsc, actual: nominal * (ntsc ? 1000 / 1001 : 1) };
  }
  function build(state) {
    const rate = frameRate(state.fps);
    const frames = ms => Math.round(Number(ms) * rate.actual / 1000);
    const rateXml = `<rate><timebase>${rate.nominal}</timebase><ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
    const videoSample = `<samplecharacteristics>${rateXml}<width>1920</width><height>1080</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance><colordepth>24</colordepth></samplecharacteristics>`;
    const audioSample = '<samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics>';
    const video = [], left = [], right = [], markers = [], emittedFiles = new Set();
    let base = 0, index = 0;
    const marker = (name, comment, start, end) => `<marker><name>${esc(name)}</name><comment>${esc(comment)}</comment><in>${start}</in><out>${end}</out></marker>`;
    (state.takes || []).forEach((take, takeIndex) => {
      const durationMs = Number(take.endMs) - Number(take.startMs);
      const offsetMs = Number(take.offsetMs ?? state.syncOffset ?? 0);
      if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(offsetMs)) invalid('테이크 시간 정보가 올바르지 않습니다. 촬영 로그를 확인해 주세요.');
      const duration = Math.max(1, frames(durationMs)), sourceOffset = frames(offsetMs);
      const sourceDuration = Math.max(1, sourceOffset + duration);
      const fid = `file-${takeIndex + 1}`;
      const sections = take.sections?.length ? take.sections : [{ start: 0, end: durationMs, status: take.status }];
      const sourceFile = () => {
        if (emittedFiles.has(fid)) return `<file id="${fid}"/>`;
        emittedFiles.add(fid);
        // A deliberate offline placeholder, one URL-encoded filename segment.
        const url = 'file://localhost/RELINK/' + encodeURIComponent(String(take.fname));
        return `<file id="${fid}"><name>${esc(take.fname)}</name><pathurl>${esc(url)}</pathurl>${rateXml}<duration>${sourceDuration}</duration><media><video>${videoSample}</video><audio>${audioSample}<channelcount>2</channelcount></audio></media></file>`;
      };
      let firstVisible = true;
      sections.forEach((section, si) => {
        const startMs = Number(section.start), endMs = Number(section.end);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs || endMs > durationMs) invalid('구간 시간이 테이크 범위를 벗어났습니다. 촬영 로그를 확인해 주세요.');
        const start = frames(startMs);
        const end = endMs === durationMs ? duration : Math.min(duration, frames(endMs));
        const sourceIn = Math.max(0, sourceOffset + start), sourceOut = sourceOffset + end;
        if (end <= start || sourceOut <= sourceIn) return;
        // Negative offsets mean the camera began later. Keep the missing portion
        // as a timeline gap; never silently shift the available media earlier.
        const tlStart = base + start + Math.max(0, -(sourceOffset + start));
        const tlEnd = base + end;
        index++;
        const ids = [`clip-v-${index}`, `clip-a1-${index}`, `clip-a2-${index}`];
        const links = ids.map((id, n) => `<link><linkclipref>${id}</linkclipref><mediatype>${n ? 'audio' : 'video'}</mediatype><trackindex>${n || 1}</trackindex><clipindex>${index}</clipindex>${n ? '<groupindex>1</groupindex>' : ''}</link>`).join('');
        const name = `T${String(take.num).padStart(2, '0')}.${si + 1} ${labels[section.status] || section.status}`;
        const clip = n => `<clipitem id="${ids[n]}"${n ? ' premiereChannelType="stereo"' : ''}><name>${esc(name)}</name><enabled>TRUE</enabled><duration>${sourceDuration}</duration>${rateXml}<start>${tlStart}</start><end>${tlEnd}</end><in>${sourceIn}</in><out>${sourceOut}</out>${sourceFile()}${n ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${n}</trackindex></sourcetrack>` : ''}${links}</clipitem>`;
        video.push(clip(0)); left.push(clip(1)); right.push(clip(2));
        if (firstVisible) {
          markers.push(marker(`T${String(take.num).padStart(2, '0')} ${labels[take.status] || take.status}`, take.note, tlStart, Math.min(tlEnd, tlStart + 1)));
          firstVisible = false;
        }
        if (section.status === 'NG') markers.push(marker('삭제 구간', take.note, tlStart, tlEnd));
      });
      for (const memo of take.memos || []) {
        const at = frames(memo.ms);
        if (Number.isFinite(at) && at >= 0 && at < duration && sourceOffset + at >= 0) {
          markers.push(marker(memo.text, '', base + at, Math.min(base + duration, base + at + 1)));
        }
      }
      base += duration;
    });
    if (!video.length) invalid('내보낼 영상 구간이 없습니다. 테이크 길이와 싱크 오프셋을 확인해 주세요.');
    const audioTrack = (clips, channel) => `<track premiereTrackType="Mono" currentExplodedTrackIndex="${channel - 1}" totalExplodedTrackCount="2">${clips.join('')}<enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>${channel}</outputchannelindex></track>`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="director-sequence"><name>${esc(state.project)} 촬영로그</name><duration>${base}</duration>${rateXml}<timecode>${rateXml}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media><video><format>${videoSample}</format><track>${video.join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track></video><audio><numOutputChannels>2</numOutputChannels><format>${audioSample}</format><outputs><group><index>1</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>1</index></channel></group><group><index>2</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>2</index></channel></group></outputs>${audioTrack(left, 1)}${audioTrack(right, 2)}</audio></media>${markers.join('')}</sequence></xmeml>`;
  }
  const api = { build, frameRate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OFFCUT_XML = api;
})(typeof globalThis === 'object' ? globalThis : this);
