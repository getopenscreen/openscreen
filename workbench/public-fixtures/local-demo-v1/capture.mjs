// Run from the repository root with Node 22.22.1 and npm ci.
// npm exec playwright install chromium (once); node <this file>

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = new URL("./", import.meta.url);
const browser = await chromium.launch({
	headless: true,
	...(process.argv.includes("--chrome") ? { channel: "chrome" } : {}),
});
try {
	const page = await browser.newPage({
		viewport: { width: 800, height: 450 },
		deviceScaleFactor: 1,
	});
	await page.route("https://**/*", (route) => route.abort());
	await page.route("http://**/*", (route) => route.abort());
	await page.goto(new URL("demo.html", root).href);
	await page.evaluate(() => window.startCapture());
	const started = Date.now();
	const until = async (ms) => {
		const remaining = ms - (Date.now() - started);
		if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
	};
	await until(1800);
	await page.mouse.move(180, 230);
	await page.mouse.click(180, 230);
	await until(4800);
	await page.mouse.move(400, 420);
	await until(7000);
	for (let i = 0; i <= 80; i++) {
		await until(7000 + i * 50);
		await page.mouse.move(390 + i * 3.5, 270);
	}
	await until(11400);
	await page.mouse.move(400, 420);
	await until(13000);
	await page.mouse.move(650, 180);
	await page.mouse.click(650, 180);
	await until(15000);
	await page.mouse.move(400, 420);
	await until(16000);
	const result = await page.evaluate(() => window.finishCapture());
	await writeFile(new URL("demo.webm", root), Buffer.from(result.bytes));
	await writeFile(
		new URL("demo.webm.cursor.json", root),
		JSON.stringify(
			{ version: 2, provider: "none", samples: result.samples, assets: [] },
			null,
			"\t",
		) + "\n",
	);
	console.log(
		JSON.stringify({
			browser: browser.version(),
			samples: result.samples.length,
			path: fileURLToPath(root),
		}),
	);
} finally {
	await browser.close();
}
