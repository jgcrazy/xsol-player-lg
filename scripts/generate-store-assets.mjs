// Builds the LG Content Store artwork in store/ from assets/icon.svg:
//
//   node scripts/generate-store-assets.mjs
//
//   store/icon-512.png, icon-400.png   square, opaque app icon (the store rounds it)
//   store/background-1920x1080.png     background image
//   store/screenshots/*.png            1280x720 and 960x540 copies of store/raw/*.png
//
// store/raw/ holds the 1920x1080 captures from e2e/store-screenshots.spec.ts
// (see store/README.md). Dev-only: nothing here ships in the .ipk.

import { chromium } from '@playwright/test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'store');

const svg = await readFile(join(ROOT, 'assets', 'icon.svg'), 'utf8');
const markStart = svg.indexOf('<g transform="translate(512 400)">');
const markEnd = svg.indexOf('<text');
if (markStart < 0 || markEnd < markStart) throw new Error('assets/icon.svg no longer matches the expected structure');
const mark = svg.slice(markStart, markEnd).trim().replace('translate(512 400)', 'translate(0 0)');
const defs = svg.match(/<defs>[\s\S]*?<\/defs>/)[0];

const squareIcon = svg
  .replace(/<text[\s\S]*<\/text>/, '')
  .replace('translate(512 400)', 'translate(512 512) scale(1.22)')
  .replace(/rx="228"/, 'rx="0"');

const background = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  ${defs}
  <defs>
    <radialGradient id="stage" cx="72%" cy="48%" r="75%">
      <stop offset="0" stop-color="#3a2c1c"/>
      <stop offset="0.5" stop-color="#1f1a16"/>
      <stop offset="1" stop-color="#0d0b0a"/>
    </radialGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#stage)"/>
  <g transform="translate(1460 540) scale(1.2)" opacity="0.95">${mark}</g>
  <text x="170" y="530" font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif" font-size="136" font-weight="600"><tspan fill="#f2ece2">XSol</tspan><tspan fill="#e8b65f"> Player</tspan></text>
  <text x="176" y="608" font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif" font-size="44" fill="#bdb4a7">Live TV, guide, movies and series on webOS</text>
</svg>`;

await mkdir(join(OUT, 'screenshots'), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();

async function render(markup, width, height, file) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<body style="margin:0">${markup.replace(/width="\d+" height="\d+"/, `width="${width}" height="${height}"`)}</body>`);
  await page.screenshot({ path: join(OUT, file), omitBackground: false });
  console.log(file);
}

await render(squareIcon, 512, 512, 'icon-512.png');
await render(squareIcon, 400, 400, 'icon-400.png');
await render(background, 1920, 1080, 'background-1920x1080.png');

// Downscale in the page: canvas smoothing is good enough for UI captures.
const rawDir = join(OUT, 'raw');
let raws = [];
try { raws = (await readdir(rawDir)).filter((f) => f.endsWith('.png')).sort(); } catch { /* none yet */ }
for (const file of raws) {
  const data = (await readFile(join(rawDir, file))).toString('base64');
  for (const [w, h] of [[1280, 720], [960, 540]]) {
    const url = await page.evaluate(async ({ data, w, h }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL('image/png');
    }, { data, w, h });
    const name = `${file.replace(/^store-/, '').replace(/\.png$/, '')}-${w}x${h}.png`;
    await writeFile(join(OUT, 'screenshots', name), Buffer.from(url.split(',')[1], 'base64'));
    console.log('screenshots/' + name);
  }
}
await browser.close();
