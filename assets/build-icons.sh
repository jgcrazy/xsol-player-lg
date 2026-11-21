#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# assets/icon.svg is the master artwork. Playwright's Chromium rasterizes it
# (the wordmark needs Segoe UI); Pillow downsizes. The wordmark is unreadable
# at launcher sizes, so those crop to the mark alone.
node - <<'JS'
const { readFileSync } = require('fs');
const { chromium } = require('playwright');

const svg = readFileSync('assets/icon.svg', 'utf8');
const markOnly = svg
  .replace(/<text[\s\S]*<\/text>/, '')
  .replace('translate(512 400)', 'translate(512 512) scale(1.22)');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  for (const [markup, file] of [[svg, 'assets/icon.png'], [markOnly, 'assets/.icon-mark.png']]) {
    await page.setContent(`<body style="margin:0">${markup}</body>`);
    await page.screenshot({ path: file, omitBackground: true });
  }
  await browser.close();
})();
JS

python - <<'PY'
import os
from PIL import Image

source = Image.open('assets/.icon-mark.png').convert('RGBA')
for size in (80, 130):
    source.resize((size, size), Image.LANCZOS).save(f'assets/icon{size}.png', optimize=True)
os.remove('assets/.icon-mark.png')
PY

echo "Icons generated: assets/icon.png (1024x1024), assets/icon80.png (80x80), assets/icon130.png (130x130)"
