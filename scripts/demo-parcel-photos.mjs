// Renders phone-style "what arrived" photos for the guided demo: the item on a bed cover and its
// woven size tag, with uneven indoor light, slight perspective and sensor noise.
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('apps/web/public/demo-parcel');
await fs.mkdir(OUT, { recursive: true });

const noise = (seed, opacity) => `
  <filter id="n${seed}" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${seed}" result="t"/>
    <feColorMatrix type="saturate" values="0"/>
    <feComponentTransfer><feFuncA type="table" tableValues="0 ${opacity}"/></feComponentTransfer>
  </filter>`;

function itemPhoto(colour, dark) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">
  <defs>${noise(3, 0.07)}${noise(7, 0.35)}
    <radialGradient id="light" cx="0.35" cy="0.25" r="0.9"><stop offset="0" stop-color="#fff" stop-opacity="0.28"/><stop offset="1" stop-color="#000" stop-opacity="0.32"/></radialGradient>
    <pattern id="knit" width="14" height="14" patternUnits="userSpaceOnUse"><path d="M0 7 Q3.5 0 7 7 T14 7" fill="none" stroke="${dark}" stroke-width="2.2" opacity="0.55"/></pattern>
  </defs>
  <rect width="1200" height="1600" fill="#b9b2a6"/>
  <rect width="1200" height="1600" filter="url(#n7)"/>
  <g transform="translate(600 820) rotate(-4) scale(1.05 0.98) translate(-512 -560)">
    <path d="M300 300 L420 240 Q512 290 604 240 L724 300 L860 560 L770 610 L700 470 L700 860 L324 860 L324 470 L254 610 L164 560 Z" fill="${colour}"/>
    <path d="M300 300 L420 240 Q512 290 604 240 L724 300 L860 560 L770 610 L700 470 L700 860 L324 860 L324 470 L254 610 L164 560 Z" fill="url(#knit)"/>
    <path d="M324 820 H700 V860 H324 Z" fill="${dark}"/>
    <path d="M420 250 Q512 320 604 250" fill="none" stroke="${dark}" stroke-width="26" stroke-linecap="round"/>
    <path d="M164 560 L254 610 L240 640 L150 590 Z" fill="${dark}"/><path d="M860 560 L770 610 L784 640 L874 590 Z" fill="${dark}"/>
  </g>
  <rect width="1200" height="1600" fill="url(#light)"/>
  <rect width="1200" height="1600" filter="url(#n3)"/>
</svg>`;
}

function tagPhoto(fabric, dark, size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">
  <defs>${noise(11, 0.06)}${noise(5, 0.09)}
    <pattern id="knit" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M0 8 Q4 0 8 8 T16 8" fill="none" stroke="${dark}" stroke-width="2.6" opacity="0.6"/></pattern>
    <pattern id="weave" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 3 H6 M3 0 V6" stroke="#d9d4c7" stroke-width="1"/></pattern>
    <radialGradient id="light" cx="0.6" cy="0.3" r="1"><stop offset="0" stop-color="#fff" stop-opacity="0.18"/><stop offset="1" stop-color="#000" stop-opacity="0.38"/></radialGradient>
  </defs>
  <rect width="1200" height="1600" fill="${fabric}"/>
  <rect width="1200" height="1600" fill="url(#knit)"/>
  <rect width="1200" height="1600" filter="url(#n5)"/>
  <g transform="translate(600 760) rotate(3)">
    <rect x="-330" y="-430" width="660" height="860" rx="18" fill="#f1ede3"/>
    <rect x="-330" y="-430" width="660" height="860" rx="18" fill="url(#weave)" opacity="0.7"/>
    <rect x="-300" y="-400" width="600" height="800" rx="10" fill="none" stroke="#bdb6a6" stroke-width="5" stroke-dasharray="14 10"/>
    <text x="0" y="-270" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="64" fill="#1b1b1b" letter-spacing="6">HARBOR &amp; CO</text>
    <text x="0" y="40" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="300" fill="#1b1b1b">${size}</text>
    <text x="0" y="170" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="44" fill="#2a2a2a">70% COTTON</text>
    <text x="0" y="232" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="44" fill="#2a2a2a">30% POLYESTER</text>
    <text x="0" y="320" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="36" fill="#3a3a3a">MACHINE WASH COLD</text>
  </g>
  <rect width="1200" height="1600" fill="url(#light)"/>
  <rect width="1200" height="1600" filter="url(#n11)"/>
</svg>`;
}

const jobs = {
  'wrong-item.jpg': itemPhoto('#17181b', '#0c0d0f'),
  'wrong-tag.jpg': tagPhoto('#17181b', '#0c0d0f', 'L'),
  'right-item.jpg': itemPhoto('#202b47', '#151c30'),
  'right-tag.jpg': tagPhoto('#202b47', '#151c30', 'M'),
};
for (const [name, svg] of Object.entries(jobs)) {
  await sharp(Buffer.from(svg)).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(OUT, name));
}
console.log('done');
