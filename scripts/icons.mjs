// App icons: the product's first letter as a braille cell (dots 2,3,4 for S) on tactile yellow.
import sharp from 'sharp';
import path from 'node:path';

const dots = { 1: [0, 0], 2: [0, 1], 3: [0, 2], 4: [1, 0], 5: [1, 1], 6: [1, 2] };
const on = new Set([2, 3, 4]);
function svg(size, radius) {
  const r = size * 0.085;
  const gx = size * 0.2;
  const gy = size * 0.2;
  const x0 = size / 2 - gx / 2;
  const y0 = size / 2 - gy;
  const circles = Object.entries(dots)
    .map(([n, [c, row]]) => {
      const cx = x0 + c * gx;
      const cy = y0 + row * gy;
      return on.has(Number(n))
        ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0b0b0c"/>`
        : `<circle cx="${cx}" cy="${cy}" r="${r * 0.82}" fill="none" stroke="#0b0b0c" stroke-width="${size * 0.018}" opacity="0.45"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#ffd60a"/>${circles}</svg>`;
}
const pub = path.resolve('apps/web/public');
for (const s of [192, 512]) await sharp(Buffer.from(svg(s, s * 0.18))).png().toFile(path.join(pub, `icon-${s}.png`));
await sharp(Buffer.from(svg(512, 0))).png().toFile(path.join(pub, 'icon-maskable-512.png'));
await sharp(Buffer.from(svg(180, 36))).png().toFile(path.resolve('apps/web/src/app/apple-icon.png'));
await sharp(Buffer.from(svg(64, 12))).png().toFile(path.resolve('apps/web/src/app/icon.png'));
console.log('icons done');
