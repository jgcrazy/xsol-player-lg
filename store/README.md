# LG Content Store artwork

Files for the Seller Lounge submission (see `lg-submission.md`):

| File | Size |
| --- | --- |
| `icon-512.png`, `icon-400.png` | 512 x 512, 400 x 400 |
| `background-1920x1080.png` | 1920 x 1080 |
| `screenshots/*-1280x720.png`, `*-960x540.png` | the two sizes the store accepts |

## Regenerate

The screenshots come from the real app over synthetic data (no real channels, titles or
brands), with a frozen clock and the English interface.

```bash
mkdir -p store/raw
STORE_SHOTS_DIR=store/raw npx playwright test e2e/store-screenshots.spec.ts --project=chromium
node scripts/generate-store-assets.mjs
```

The first command captures 1920 x 1080 originals into `store/raw/` (ignored by git);
the second renders the icon and background from `assets/icon.svg` and writes the
downscaled screenshots. `e2e/store-screenshots.spec.ts` is skipped unless
`STORE_SHOTS_DIR` is set, so the normal e2e run ignores it.

Nothing in this folder ships in the `.ipk`.
