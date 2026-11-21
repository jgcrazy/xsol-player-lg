#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# assets/icon.png is the master artwork; needs Python with Pillow.
python - <<'PY'
from PIL import Image

source = Image.open('assets/icon.png').convert('RGBA')
for size in (80, 130):
    source.resize((size, size), Image.LANCZOS).save(f'assets/icon{size}.png', optimize=True)
PY

echo "Icons generated: assets/icon80.png (80x80), assets/icon130.png (130x130)"
