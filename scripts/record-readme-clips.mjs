#!/usr/bin/env node
/**
 * Records the README feature clips from the renderer running on the built-in mock
 * backend (`?backend=mock`). Nothing here touches real sessions or ~/.gjc.
 *
 *   CLIP_PORT=5198 PLAYWRIGHT_CORE=... CHROME=... FFMPEG=... \
 *     node scripts/record-readme-clips.mjs [scene ...]
 *
 * Start the dev server first: `npx vite --port 5198 --strictPort`.
 * Each scene is captured as back-to-back screenshots from the moment its `run`
 * begins, then encoded to a 960px GIF in docs/media.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.CLIP_PORT ?? "5198";
const outDir = process.env.CLIP_OUT ?? join(root, "docs", "media");
const workDir = process.env.CLIP_WORK ?? join(tmpdir(), "gajae-readme-clips");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const WIDTH = 1100;
const HEIGHT = 653;
const GIF_WIDTH = 960;
const GIF_FPS = 14;
const SCALE = Number(process.env.CLIP_SCALE ?? 1);

const requirePlaywright = createRequire(import.meta.url);
const { chromium } = requirePlaywright(process.env.PLAYWRIGHT_CORE ?? "playwright-core");

const hold = (ms) => new Promise((done) => setTimeout(done, ms));

// A ring that follows the pointer, since a video does not draw the OS cursor.
const POINTER = `(() => {
  const ring = document.createElement("div");
  ring.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(240,100,22,.3);border:2px solid #ff9238;left:-60px;top:-60px;transition:transform .12s";
  addEventListener("DOMContentLoaded", () => document.documentElement.append(ring));
  addEventListener("mousemove", (e) => { ring.style.left = e.clientX + "px"; ring.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", () => { ring.style.transform = "scale(.65)"; }, true);
  addEventListener("mouseup", () => { ring.style.transform = "scale(1)"; }, true);
})();`;

const pointer = { x: 560, y: 330 };

async function glide(page, target) {
  const box = await target.boundingBox();
  if (!box) throw new Error("glide target has no box");
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const steps = 22;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const ease = t * t * (3 - 2 * t);
    await page.mouse.move(
      pointer.x + (to.x - pointer.x) * ease,
      pointer.y + (to.y - pointer.y) * ease,
    );
    await hold(14);
  }
  pointer.x = to.x;
  pointer.y = to.y;
}

async function press(page, target, options) {
  await glide(page, target);
  await hold(120);
  await target.click(options);
}

const sessionRow = (page, title) => page.locator(".sidebar").getByText(title, { exact: true }).first();
const composer = (page) => page.locator("form.composer textarea, .composer textarea").first();

async function openSession(page, title) {
  const row = sessionRow(page, title);
  await row.click();
  const box = await row.boundingBox();
  pointer.x = box.x + box.width / 2;
  pointer.y = box.y + box.height / 2;
  await composer(page).waitFor();
}

const scenes = {
  approval: {
    out: "feature-approval.gif",
    async setup(page) {
      await openSession(page, "Gajae UI");
      await page.locator(".tool-card-rule").waitFor();
    },
    async run(page) {
      await hold(1100);
      const prefix = page.locator(".tool-card-rule input");
      await press(page, prefix);
      await page.keyboard.press("End");
      await page.keyboard.type(" --short", { delay: 120 });
      await hold(900);
      await press(page, page.getByRole("button", { name: "앞부분 항상 허용" }));
      await page.locator(".tool-card-auto-decision").waitFor();
      await page.locator(".tool-card-auto-decision").scrollIntoViewIfNeeded();
      await hold(2600);
    },
  },

  "side-chat": {
    out: "feature-side-chat.gif",
    async setup(page) {
      await openSession(page, "Codex router cleanup");
    },
    async run(page) {
      await hold(1200);
      await page.keyboard.press("Meta+Shift+B");
      const input = page.getByLabel("사이드 채팅 입력");
      await input.waitFor();
      await hold(700);
      await press(page, input);
      await page.keyboard.type("정리 범위를 표로 보여줄래?", { delay: 60 });
      await hold(400);
      await page.keyboard.press("Enter");
      await page.locator(".side-panel table").waitFor({ timeout: 15_000 });
      await hold(3200);
    },
  },

  mermaid: {
    out: "feature-mermaid.gif",
    async setup() {},
    async run(page) {
      await hold(1000);
      await press(page, sessionRow(page, "M1 Air box health"));
      await page.locator(".mermaid-block svg, [class*=mermaid] svg").first().waitFor({ timeout: 15_000 });
      await hold(3400);
    },
  },

  suggestion: {
    out: "feature-suggestion.gif",
    async setup(page) {
      await openSession(page, "M1 Air box health");
      // The product draws the ghost over the empty composer's placeholder, so the two
      // collide on screen. Hide only the placeholder to read the ghost clearly.
      await page.addStyleTag({ content: ".composer textarea::placeholder{color:transparent!important}" });
    },
    async run(page) {
      await hold(900);
      await press(page, composer(page));
      await page.keyboard.type("Docker 컨테이너 상태도 확인해줘", { delay: 55 });
      await hold(500);
      await page.keyboard.press("Enter");
      await page.locator(".composer-ghost").waitFor({ timeout: 20_000 });
      await hold(2200);
      await page.keyboard.press("Tab");
      await hold(2200);
    },
  },

  queue: {
    out: "feature-queue.gif",
    async setup(page) {
      await openSession(page, "Codex router cleanup");
    },
    async run(page) {
      await hold(1000);
      await press(page, composer(page));
      for (const text of ["테스트도 같이 돌려줘", "마지막에 변경 요약도 붙여줘"]) {
        await page.keyboard.type(text, { delay: 50 });
        await hold(250);
        await page.keyboard.press("Enter");
        await page.locator(".composer-queue-item", { hasText: text }).waitFor();
        await hold(600);
      }
      await hold(900);
      await press(page, page.getByRole("button", { name: "뒤로 옮기기" }).first());
      await hold(1300);
      await press(page, page.getByRole("button", { name: "대기 항목 버리기" }).last());
      await hold(1800);
    },
  },

  "model-picker": {
    out: "feature-model-picker.gif",
    async setup(page) {
      await openSession(page, "M1 Air box health");
    },
    async run(page) {
      await hold(900);
      await press(page, page.locator(".composer").getByText("Codex Medium").first());
      await page.locator(".model-picker-tabs").waitFor();
      await hold(1300);
      await press(page, page.getByRole("tab", { name: /모델/ }));
      await hold(1100);
      const search = page.getByLabel("모델 찾기");
      await press(page, search);
      await page.keyboard.type("gemini", { delay: 130 });
      await hold(1000);
      await press(page, page.getByRole("button", { name: "Gemini 3 Pro 즐겨찾기" }));
      await hold(2000);
    },
  },

  review: {
    out: "feature-review.gif",
    async setup(page) {
      await openSession(page, "Codex router cleanup");
    },
    async run(page) {
      await hold(1000);
      await press(page, page.getByTitle("변경 파일 보기"));
      const added = page.locator(".diff-line--add .diff-line-number");
      await added.first().waitFor();
      await hold(1200);
      await press(page, added.first());
      await glide(page, added.nth(2));
      await page.keyboard.down("Shift");
      await added.nth(2).click();
      await page.keyboard.up("Shift");
      const note = page.getByLabel("코멘트", { exact: true });
      await note.waitFor();
      await hold(500);
      await page.keyboard.type("비활성 provider일 때 기본값으로 되돌려도 될까요?", { delay: 45 });
      await hold(500);
      await press(page, page.getByRole("button", { name: "코멘트 추가" }));
      const review = page.locator(".diff-review");
      await review.waitFor();
      await review.scrollIntoViewIfNeeded();
      await hold(2600);
    },
  },

  projects: {
    out: "feature-projects.gif",
    async setup() {},
    async run(page) {
      await hold(1500);
      await press(page, page.locator(".sidebar").getByText("상태", { exact: true }).first());
      await hold(2600);
      await press(page, page.locator(".sidebar").getByText("프로젝트", { exact: true }).first());
      await hold(1500);
    },
  },
};

/** Screenshots the page back to back until stopped; each frame keeps its capture time. */
function startCapture(page, dir) {
  const frames = [];
  let running = true;
  const begin = performance.now();
  const loop = (async () => {
    for (let index = 0; running; index += 1) {
      const at = performance.now() - begin;
      const file = join(dir, `${String(index).padStart(5, "0")}.png`);
      await page.screenshot({ path: file, type: "png" });
      frames.push({ file, at });
    }
  })();
  return async () => {
    running = false;
    await loop;
    return { frames, length: performance.now() - begin };
  };
}

function encode({ frames, length }, gifPath, listPath) {
  const lines = frames.map((frame, index) => {
    const next = frames[index + 1]?.at ?? length;
    return `file '${frame.file}'\nduration ${((next - frame.at) / 1000).toFixed(4)}`;
  });
  lines.push(`file '${frames.at(-1).file}'`);
  writeFileSync(listPath, lines.join("\n"));
  const scale = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  const result = spawnSync(
    ffmpeg,
    [
      "-y", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-vf", `${scale},split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      "-loop", "0", gifPath,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${gifPath}`);
}

const wanted = process.argv.slice(2);
const names = wanted.length > 0 ? wanted : Object.keys(scenes);
for (const name of names) if (!scenes[name]) throw new Error(`unknown scene: ${name}`);

mkdirSync(outDir, { recursive: true });
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
  for (const name of names) {
    const scene = scenes[name];
    const dir = join(workDir, name);
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: SCALE,
      colorScheme: "dark",
    });
    await context.addInitScript(POINTER);
    const page = await context.newPage();
    pointer.x = 560;
    pointer.y = 330;
    await page.goto(`http://localhost:${port}/?backend=mock`);
    await sessionRow(page, "Gajae UI").waitFor();
    await scene.setup(page);
    await hold(500);
    const stop = startCapture(page, dir);
    let capture;
    try {
      await scene.run(page);
      await hold(200);
    } finally {
      capture = await stop();
    }
    await context.close();
    const gif = join(outDir, scene.out);
    encode(capture, gif, join(dir, "frames.txt"));
    const fps = (capture.frames.length / (capture.length / 1000)).toFixed(1);
    console.log(`${scene.out}  ${(statSync(gif).size / 1024).toFixed(0)} KB  ${(capture.length / 1000).toFixed(1)} s  captured ${fps} fps`);
  }
} finally {
  await browser.close();
}
