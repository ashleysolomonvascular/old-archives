// Renders the app icons from inline SVG using the pre-installed Playwright. Run: node scripts/make-icons.cjs
const { chromium } = require('playwright');
const path = require('path');

const glyph = (s) => `
  <g transform="translate(${s / 2} ${s / 2}) scale(${s / 512}) translate(-256 -256)">
    <rect x="96" y="150" width="320" height="64" rx="14" fill="#D3C6B4"/>
    <path d="M118 214h276v168a28 28 0 0 1-28 28H146a28 28 0 0 1-28-28z" fill="#B6A48C"/>
    <rect x="206" y="256" width="100" height="26" rx="13" fill="#2B352C"/>
  </g>`;
const svg = (s, { rounded, scale }) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" ${rounded ? `rx="${s * 0.22}"` : ''} fill="#2B352C"/>
  <g transform="translate(${s / 2} ${s / 2}) scale(${scale}) translate(${-s / 2} ${-s / 2})">${glyph(s)}</g></svg>`;

(async () => {
  const b = await chromium.launch();
  const out = path.join(__dirname, '..', 'public', 'icons');
  const jobs = [
    ['icon-192.png', 192, { rounded: true, scale: 1.05 }],
    ['icon-512.png', 512, { rounded: true, scale: 1.05 }],
    ['icon-maskable-512.png', 512, { rounded: false, scale: 0.78 }],
  ];
  for (const [name, s, o] of jobs) {
    const p = await b.newPage({ viewport: { width: s, height: s } });
    await p.setContent(`<body style="margin:0;background:transparent">${svg(s, o)}</body>`);
    await p.screenshot({ path: path.join(out, name), omitBackground: true });
    await p.close();
  }
  await b.close();
})();
