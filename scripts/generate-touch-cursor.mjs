// Run with node scripts/generate-touch-cursor.mjs. The disk is original OpenScreen artwork.
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage();
	const data = await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 128;
		const ctx = canvas.getContext("2d");
		ctx.beginPath();
		ctx.arc(64, 64, 58, 0, Math.PI * 2);
		ctx.fillStyle = "rgba(255,255,255,0.6)";
		ctx.fill();
		ctx.lineWidth = 3;
		ctx.strokeStyle = "rgba(32,40,48,0.7)";
		ctx.stroke();
		return canvas.toDataURL("image/png").split(",")[1];
	});
	const out = new URL("../public/cursors/touch/", import.meta.url);
	await mkdir(out, { recursive: true });
	await writeFile(new URL("disk.png", out), Buffer.from(data, "base64"));
} finally {
	await browser.close();
}
