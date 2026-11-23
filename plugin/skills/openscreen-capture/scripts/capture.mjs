#!/usr/bin/env node
// Headless take of a web page for OpenScreen: a browser with no window, a screenshot loop at
// twice the display scale (so zooms stay sharp), encoded to an MP4, plus the pointer log that
// OpenScreen's setPointerTrack tool takes.
//
//   node capture.mjs <storyboard.mjs> <out.mp4>
//
// Writes <out.mp4> and <out.mp4>.pointer.json ({ recordingStartedAt: 0, events: [...] }).
// Needs Node 18+, Playwright (`playwright` or `playwright-core`, found from the working
// directory or PLAYWRIGHT_FROM), ffmpeg on the PATH (or FFMPEG), and Chrome, Edge or
// Playwright's own Chromium. CAPTURE_BROWSER picks a channel (chrome, msedge), and
// CAPTURE_BROWSER_PATH a browser executable.
//
// The storyboard module exports `url`, and optionally `viewport` ({ width, height }, default
// 1280x720), `scale` (default 2), `colorScheme` ("light" or "dark"), `async prepare(page)`
// (runs before capture starts) and `async run(s)`. `s` has `page`, `move(x, y, ms)`,
// `moveTo(selector, ms)`, `click()`, `type(text, msPerChar)` and `wait(ms)`; x and y are CSS
// pixels of the viewport. Click through `s.click()`: only `s` logs the pointer.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const fail = (message) => {
	console.error(message);
	process.exit(1);
};

const [storyboardArg, outArg] = process.argv.slice(2);
if (!storyboardArg || !outArg) fail("Usage: node capture.mjs <storyboard.mjs> <out.mp4>");

const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
if (spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).error) {
	fail(
		"ffmpeg was not found. Ask the user before installing it (winget install ffmpeg, brew install ffmpeg, apt install ffmpeg), or set FFMPEG to its path.",
	);
}

function loadPlaywright() {
	const bases = [process.env.PLAYWRIGHT_FROM, join(process.cwd(), "package.json"), import.meta.url];
	for (const base of bases.filter(Boolean)) {
		for (const name of ["playwright", "playwright-core"]) {
			try {
				return createRequire(base)(name);
			} catch {
				// Not installed here: try the next one.
			}
		}
	}
	fail(
		"Playwright was not found. Ask the user before installing it (npm install --no-save playwright in the working directory), or set PLAYWRIGHT_FROM to a package.json whose project has it.",
	);
}

async function launch(chromium) {
	if (process.env.CAPTURE_BROWSER_PATH) {
		return chromium.launch({
			executablePath: process.env.CAPTURE_BROWSER_PATH,
			headless: true,
			args: ["--lang=en-US"],
		});
	}
	const channels = process.env.CAPTURE_BROWSER
		? [process.env.CAPTURE_BROWSER]
		: ["chrome", "msedge", undefined];
	for (const channel of channels) {
		try {
			return await chromium.launch({ channel, headless: true, args: ["--lang=en-US"] });
		} catch {
			// Not installed: try the next one.
		}
	}
	fail(
		"No browser could be launched. Install Chrome or Edge, or ask the user before running npx playwright install chromium; CAPTURE_BROWSER_PATH points at any Chromium-based browser.",
	);
}

const { chromium } = loadPlaywright();
const sb = await import(pathToFileURL(resolve(storyboardArg)).href);
if (!sb.url) fail("The storyboard must export `url`.");
const out = resolve(outArg);
const vp = sb.viewport ?? { width: 1280, height: 720 };
const scale = sb.scale ?? 2;
const framesDir = `${out}.frames`;
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const browser = await launch(chromium);
const ctx = await browser.newContext({
	viewport: vp,
	deviceScaleFactor: 1,
	locale: "en-US",
	...(sb.colorScheme ? { colorScheme: sb.colorScheme } : {}),
});
const page = await ctx.newPage();
await page
	.goto(sb.url, { waitUntil: "networkidle", timeout: 60000 })
	.catch((error) => console.error(`Loading went on past the wait: ${error.message}`));
if (sb.prepare) await sb.prepare(page);

// A screenshot loop keeps the device pixels at `scale`; a screencast would give CSS pixels.
const cdp = await ctx.newCDPSession(page);
const frames = [];
let capturing = true;
const capture = (async () => {
	while (capturing) {
		const t = Date.now();
		const { data } = await cdp.send("Page.captureScreenshot", {
			format: "jpeg",
			quality: 92,
			optimizeForSpeed: true,
			clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale },
		});
		const f = join(framesDir, `${String(frames.length).padStart(5, "0")}.jpg`);
		writeFileSync(f, Buffer.from(data, "base64"));
		frames.push({ f, t });
	}
})();

// The pointer log: where each move starts and ends, and each click. OpenScreen glides between them.
const events = [];
let pos = { x: vp.width / 2, y: vp.height * 0.6 };
// Fractions of the viewport, held inside it: setPointerTrack takes 0 to 1 only, and a move aimed
// past the edge still ends at the edge on screen.
const fraction = (value, size) => Math.min(1, Math.max(0, value / size));
const log = (click = false) =>
	events.push({
		at: Date.now(),
		x: fraction(pos.x, vp.width),
		y: fraction(pos.y, vp.height),
		...(click ? { click: true } : {}),
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const s = {
	page,
	wait: (ms) => sleep(ms),
	move: async (x, y, ms = 700) => {
		const from = { ...pos };
		const t0 = Date.now();
		log();
		for (;;) {
			const k = Math.min(1, (Date.now() - t0) / ms);
			const e = ease(k);
			pos = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
			await page.mouse.move(pos.x, pos.y);
			if (k >= 1) break;
			await sleep(16);
		}
		log();
	},
	moveTo: async (selector, ms) => {
		const box = await page.locator(selector).first().boundingBox();
		if (!box) throw new Error(`Nothing visible matches ${selector}`);
		await s.move(box.x + box.width / 2, box.y + box.height / 2, ms);
	},
	click: async () => {
		log(true);
		await page.mouse.down();
		await sleep(70);
		await page.mouse.up();
	},
	// A fixed rhythm, slightly uneven like a hand, and the same on every run.
	type: async (text, perChar = 55) => {
		let i = 0;
		for (const ch of text) {
			await page.keyboard.type(ch);
			await sleep(perChar + ((i++ * 37) % 40));
		}
	},
};

try {
	await s.wait(400);
	log();
	if (sb.run) await sb.run(s);
	await s.wait(600);
} finally {
	capturing = false;
	await capture;
	await browser.close();
}
if (frames.length < 2) fail("Fewer than two frames were captured.");

// Frames come only as fast as the page renders: hold each until the next, then resample to 30 fps.
// yuv420p, because OpenScreen's compositor does not open 4:4:4 H.264.
const t0 = frames[0].t;
const list = frames
	.map(
		(fr, i) =>
			`file '${fr.f.replaceAll("\\", "/")}'\nduration ${(((frames[i + 1]?.t ?? fr.t + 33) - fr.t) / 1000).toFixed(4)}`,
	)
	.join("\n");
writeFileSync(
	join(framesDir, "list.txt"),
	`${list}\nfile '${frames.at(-1).f.replaceAll("\\", "/")}'\n`,
);
const encoded = spawnSync(
	ffmpeg,
	[
		"-y",
		"-loglevel",
		"error",
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		join(framesDir, "list.txt"),
		"-vf",
		"fps=30,format=yuv420p",
		"-c:v",
		"libx264",
		"-crf",
		"14",
		"-preset",
		"slow",
		out,
	],
	{ stdio: "inherit" },
);
if (encoded.status) process.exit(encoded.status);
rmSync(framesDir, { recursive: true, force: true });

// Video time: recordingStartedAt 0, and each `at` in milliseconds from the first frame.
const pointer = events.filter((e) => e.at >= t0).map((e) => ({ ...e, at: e.at - t0 }));
// setPointerTrack refuses an empty track: say why here, where the storyboard can be fixed.
if (pointer.length === 0) {
	fail(
		"No pointer move or click was logged after the first frame: the storyboard must move or click.",
	);
}
writeFileSync(
	`${out}.pointer.json`,
	JSON.stringify({ recordingStartedAt: 0, events: pointer }, null, 1),
);
const seconds = (frames.at(-1).t - t0) / 1000;
console.log(
	JSON.stringify({
		video: out,
		pointer: `${out}.pointer.json`,
		seconds: Number(seconds.toFixed(1)),
		capturedFps: Number((frames.length / seconds).toFixed(1)),
		size: `${vp.width * scale}x${vp.height * scale}`,
		clicksAtSec: pointer.filter((e) => e.click).map((e) => Number((e.at / 1000).toFixed(2))),
	}),
);
