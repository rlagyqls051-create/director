// icon.svg 마크를 네이티브 아이콘/스플래시 소스 PNG로 래스터화 → assets/
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const assets = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });

const BG = '#0a0a0a';
// icon.svg 안쪽 마크만 (링+REC점+노치) — rounded rect는 iOS가 squircle로 깎으므로 제외
const mark = s => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${s}" height="${s}">
  <circle cx="256" cy="256" r="150" fill="none" stroke="#eee" stroke-width="26"/>
  <circle cx="256" cy="256" r="72" fill="#ff3b30"/>
  <rect x="256" y="66" width="52" height="90" rx="14" fill="#eee"/>
</svg>`);

const flat = (size, bg) => sharp({ create: { width: size, height: size, channels: 4, background: bg } });
const onDark = async (canvas, markSize) =>
  flat(canvas, BG).composite([{ input: await sharp(mark(markSize)).png().toBuffer(), gravity: 'center' }]).png().toBuffer();

(async () => {
  // iOS 앱 아이콘: 풀블리드 (투명 없어야 함)
  fs.writeFileSync(path.join(assets, 'icon-only.png'), await onDark(1024, 1024));
  // Android adaptive: foreground = 투명 배경에 마크 ~66% (세이프존), background = 단색
  fs.writeFileSync(path.join(assets, 'icon-foreground.png'),
    await flat(1024, { r: 0, g: 0, b: 0, alpha: 0 })
      .composite([{ input: await sharp(mark(680)).png().toBuffer(), gravity: 'center' }]).png().toBuffer());
  fs.writeFileSync(path.join(assets, 'icon-background.png'), await flat(1024, BG).png().toBuffer());
  // 스플래시
  fs.writeFileSync(path.join(assets, 'splash.png'), await onDark(2732, 700));
  fs.writeFileSync(path.join(assets, 'splash-dark.png'), await onDark(2732, 700));
  console.log('assets/ generated');
})();
