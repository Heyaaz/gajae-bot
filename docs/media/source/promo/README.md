# Promo video source

1. `python build-mascot.py` regenerates the mascot dot data inside `promo.html` from `src/assets/gajae-icon.png` (needs Pillow).
2. Set `PLAYWRIGHT_CORE` (playwright-core path), `CHROME` (Chromium executable) and `FFMPEG`, then run `node render.mjs`.
3. It writes `docs/media/gajae-promo.mp4` and `docs/media/gajae-promo.gif`. `--stills 3,12.5` dumps single frames, `--frames <dir>` sets the scratch folder.
