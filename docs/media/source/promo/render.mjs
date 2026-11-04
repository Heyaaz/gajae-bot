import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { PLAYWRIGHT_CORE, CHROME, FFMPEG } = process.env;
for (const [k, v] of Object.entries({ PLAYWRIGHT_CORE, CHROME, FFMPEG })) {
  if (!v) throw new Error(`${k} is not set`);
}
const { chromium } = createRequire(import.meta.url)(PLAYWRIGHT_CORE);

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const FPS = Number(opt('fps', 30));
const framesDir = resolve(opt('frames', join(here, '.frames')));
const outDir = resolve(opt('out', join(here, '../..')));
const stills = opt('stills', '');
const encode = !args.includes('--no-encode');

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(join(here, 'promo.html')).href);
await page.evaluate(() => document.fonts.ready);
const total = await page.evaluate(() => window.TOTAL);

if (stills) {
  mkdirSync(framesDir, { recursive: true });
  for (const t of stills.split(',').map(Number)) {
    await page.evaluate(x => window.renderAt(x), t);
    await page.screenshot({ path: join(framesDir, `still-${t.toFixed(2)}.png`) });
  }
  await browser.close();
  process.exit(0);
}

if (existsSync(framesDir)) rmSync(framesDir, { recursive: true });
mkdirSync(framesDir, { recursive: true });
const count = Math.round(total * FPS);
for (let i = 0; i < count; i++) {
  await page.evaluate(x => window.renderAt(x), i / FPS);
  await page.screenshot({ path: join(framesDir, `${String(i).padStart(4, '0')}.png`) });
}
await browser.close();
console.log(`${count} frames, ${total.toFixed(2)} s`);

if (encode) {
  const run = a => {
    const r = spawnSync(FFMPEG, a, { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg failed');
  };
  const input = ['-y', '-framerate', String(FPS), '-i', join(framesDir, '%04d.png')];
  run([...input, '-vf', 'scale=960:540:flags=lanczos', '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', join(outDir, 'gajae-promo.mp4')]);
  run([...input, '-vf', 'fps=15,scale=960:540:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', join(outDir, 'gajae-promo.gif')]);
}
