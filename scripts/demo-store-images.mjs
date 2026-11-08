// Renders the Demo Store's own product illustrations (one PNG per product colour).
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('apps/web/public/demo-store');
const HEX = {
  navy: '#1f2a44', black: '#16171a', 'heather grey': '#9b9da0', burgundy: '#6d1a2b', charcoal: '#3a4149',
  cream: '#ece3cc', olive: '#66663a', white: '#f3f3ef', 'forest green': '#2d4b31', 'royal blue': '#2f4fb5',
  teal: '#1f7a7a', natural: '#e3d8bf',
};
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
};
const bg = '#eeeeea';

function sweater(c, { neck = 'crew', cable = false } = {}) {
  const d = shade(c, 0.78), l = shade(c, 1.12);
  const neckPath = neck === 'v'
    ? `<path d="M420 250 L512 380 L604 250" fill="none" stroke="${d}" stroke-width="26" stroke-linejoin="round"/>`
    : `<path d="M420 250 Q512 320 604 250" fill="none" stroke="${d}" stroke-width="26" stroke-linecap="round"/>`;
  const cables = cable ? [430, 512, 594].map((x) => `<path d="M${x} 340 ${Array.from({ length: 9 }, (_, i) => `q ${i % 2 ? -22 : 22} 22 0 44`).join(' ')}" fill="none" stroke="${d}" stroke-width="10"/>`).join('') : '';
  return `
  <path d="M300 300 L420 240 Q512 290 604 240 L724 300 L860 560 L770 610 L700 470 L700 860 L324 860 L324 470 L254 610 L164 560 Z" fill="${c}"/>
  <path d="M324 820 H700 V860 H324 Z" fill="${d}"/>
  ${Array.from({ length: 14 }, (_, i) => `<line x1="${340 + i * 26}" y1="822" x2="${340 + i * 26}" y2="858" stroke="${shade(c, 0.66)}" stroke-width="4"/>`).join('')}
  <path d="M164 560 L254 610 L240 640 L150 590 Z" fill="${d}"/><path d="M860 560 L770 610 L784 640 L874 590 Z" fill="${d}"/>
  <path d="M330 300 Q512 330 694 300" fill="none" stroke="${l}" stroke-width="6" opacity="0.35"/>
  ${neckPath}${cables}`;
}
function tee(c) {
  const d = shade(c, 0.8);
  return `<path d="M320 280 L430 240 Q512 290 594 240 L704 280 L820 420 L730 470 L690 410 L690 840 L334 840 L334 410 L294 470 L204 420 Z" fill="${c}" stroke="${shade(c, 0.85)}" stroke-width="4"/>
  <path d="M430 240 Q512 300 594 240" fill="none" stroke="${d}" stroke-width="18" stroke-linecap="round"/>`;
}
function shoe(c) {
  const d = shade(c, 0.7);
  return `<path d="M170 640 Q180 520 300 500 L470 470 Q560 380 650 420 L760 500 Q860 540 870 640 Z" fill="${c}"/>
  <path d="M160 640 H880 Q880 700 820 700 H210 Q160 700 160 640 Z" fill="#f2f2ee" stroke="${d}" stroke-width="8"/>
  ${[0, 1, 2, 3].map((i) => `<line x1="${520 + i * 34}" y1="${440 + i * 14}" x2="${560 + i * 34}" y2="${480 + i * 14}" stroke="#f2f2ee" stroke-width="10" stroke-linecap="round"/>`).join('')}`;
}
function mug(c) {
  const d = shade(c, 0.8);
  const specks = Array.from({ length: 40 }, (_, i) => `<circle cx="${380 + ((i * 53) % 260)}" cy="${380 + ((i * 97) % 380)}" r="4" fill="${shade(c, 0.6)}"/>`).join('');
  return `<path d="M650 430 Q790 430 790 560 Q790 690 650 690" fill="none" stroke="${c}" stroke-width="46"/>
  <rect x="360" y="340" width="300" height="440" rx="40" fill="${c}"/><ellipse cx="510" cy="345" rx="150" ry="28" fill="${d}"/>${specks}`;
}
function cable(c) {
  return `<path d="M260 300 C 700 260, 300 700, 760 720" fill="none" stroke="${c}" stroke-width="28" stroke-linecap="round"/>
  <rect x="200" y="260" width="90" height="70" rx="12" fill="#55585e"/><rect x="740" y="690" width="90" height="70" rx="12" fill="#55585e"/>`;
}
function charger(c) {
  return `<rect x="370" y="330" width="290" height="330" rx="46" fill="${c}" stroke="#c8c8c2" stroke-width="6"/>
  <rect x="470" y="460" width="90" height="34" rx="12" fill="#55585e"/><rect x="450" y="250" width="26" height="90" fill="#9a9a96"/><rect x="556" y="250" width="26" height="90" fill="#9a9a96"/>`;
}
function tote(c) {
  const d = shade(c, 0.82);
  return `<path d="M410 380 Q410 200 512 200 Q614 200 614 380" fill="none" stroke="${d}" stroke-width="22"/>
  <path d="M300 380 H724 L760 840 H264 Z" fill="${c}"/><path d="M300 380 H724" stroke="${d}" stroke-width="14"/>`;
}

const ITEMS = {
  'harbor-knit-crew': { draw: (c) => sweater(c), colours: ['navy', 'black', 'heather grey'] },
  'tidewater-merino-crew': { draw: (c) => sweater(c), colours: ['navy', 'burgundy', 'charcoal'] },
  'everyday-cable-crew': { draw: (c) => sweater(c, { cable: true }), colours: ['navy', 'cream'] },
  'harbor-knit-vneck': { draw: (c) => sweater(c, { neck: 'v' }), colours: ['navy', 'olive'] },
  'mill-cotton-tee': { draw: tee, colours: ['white', 'black', 'navy', 'forest green'] },
  'trail-runner-2': { draw: shoe, colours: ['black', 'royal blue'] },
  'stoneware-mug': { draw: mug, colours: ['cream', 'teal'] },
  'braided-usb-c-cable': { draw: cable, colours: ['black'] },
  'wall-charger-30w': { draw: charger, colours: ['white'] },
  'canvas-tote': { draw: tote, colours: ['natural', 'navy'] },
};

await fs.mkdir(OUT, { recursive: true });
for (const [slug, { draw, colours }] of Object.entries(ITEMS)) {
  for (const name of colours) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${bg}"/><ellipse cx="512" cy="900" rx="330" ry="26" fill="#000" opacity="0.06"/>${draw(HEX[name])}</svg>`;
    const file = path.join(OUT, `${slug}--${name.replace(/\s+/g, '-')}.png`);
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(file);
  }
}
console.log('done', (await fs.readdir(OUT)).length);
