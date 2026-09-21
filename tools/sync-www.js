// 루트의 웹 에셋을 Capacitor webDir(www/)로 복사. 루트 파일이 GitHub Pages용 원본.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = ['index.html', 'app.js', 'style.css', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png'];
fs.mkdirSync(path.join(root, 'www'), { recursive: true });
for (const f of files) fs.copyFileSync(path.join(root, f), path.join(root, 'www', f));
console.log('www synced:', files.join(', '));
