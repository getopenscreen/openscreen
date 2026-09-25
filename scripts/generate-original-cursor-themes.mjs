// Original OpenScreen cursor artwork. Run with `node scripts/generate-original-cursor-themes.mjs`.
// The initial SVGs in design/cursors are editable masters. This script never overwrites
// them; it rasterizes their current contents to PNGs for the editor and compositor.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MASTER_DIR = path.join(ROOT, "design", "cursors");
const PUBLIC_DIR = path.join(ROOT, "public", "cursors");
const SIZE = 128;

const arrow = "M3 2.5 3 27.5 9.5 21.6 13.8 30 19.2 27.3 14.8 19 24.5 18.9Z";
const hand =
	"M13.7 2.5C11.8 2.5 10.6 3.8 10.6 5.5V15.8L8.5 13.6C7.1 12.1 4.8 12.6 4 14.2c-.5 1-.4 2.2.3 3.3l5.8 9.1c1 1.6 2.5 2.4 4.3 2.4h8.1c3.1 0 5.1-2.2 5.1-5.1v-8.8c0-1.7-1.1-2.8-2.6-2.8-1.1 0-2 .6-2.4 1.5v-1.2c0-1.7-1.1-2.8-2.6-2.8-1.2 0-2.1.7-2.6 1.7V5.5c0-1.7-1.3-3-3-3Z";
const pixelArrow =
	"M3 3H6V6H9V9H12V12H15V15H18V18H23V20H16V22H18V26H20V29H15V27H13V23H11V21H9V23H7V25H5V27H3Z";
const pixelHand = "M11 2H16V10H20V12H24V14H27V25H25V28H12V26H10V23H8V20H6V18H4V14H6V12H8V13H11Z";

const themes = [
	{
		id: "studio-ink",
		name: "Studio Ink",
		art: (type) => {
			const shape = type === "arrow" ? arrow : hand;
			const accent =
				type === "arrow"
					? '<path d="M6.8 8.5v13l3.8-3.4" fill="none" stroke="#FFF" stroke-width="1.3" stroke-linecap="round" opacity=".9"/>'
					: '<path d="M13.2 6.4v8.8M19.3 13v3.2M23.7 15.9v2.2" fill="none" stroke="#FFF" stroke-width="1.1" stroke-linecap="round" opacity=".8"/>';
			return `<path d="${shape}" fill="#252934" stroke="#FFFFFF" stroke-width="3.2" stroke-linejoin="round"/><path d="${shape}" fill="none" stroke="#171A23" stroke-width="1.4" stroke-linejoin="round"/>${accent}`;
		},
	},
	{
		id: "prism-glow",
		name: "Prism Glow",
		art: (type) => {
			const shape = type === "arrow" ? arrow : hand;
			const facets =
				type === "arrow"
					? '<path d="M3 2.5 24.5 18.9 11 16Z" fill="#29E1D2"/><path d="M11 16 24.5 18.9 19.2 27.3 14.8 19Z" fill="#8F66F5"/><path d="M3 2.5 11 16 3 27.5Z" fill="#3269E9"/><path d="M3 2.5 17 17 9 14Z" fill="#A8FFF3" opacity=".85"/>'
					: '<path d="M10 3 19 10 12 19 4 14Z" fill="#2FE3D5"/><path d="M19 9 29 15 26 24 12 19Z" fill="#8563F0"/><path d="M4 14 12 19 26 24 24 30 12 30Z" fill="#2869DD"/><path d="M12 3 17 5 14 16 11 18Z" fill="#B5FFF4" opacity=".8"/>';
			return `<defs><clipPath id="shape"><path d="${shape}"/></clipPath></defs><path d="${shape}" fill="#132C75"/><g clip-path="url(#shape)">${facets}</g><path d="${shape}" fill="none" stroke="#091845" stroke-width="2.8" stroke-linejoin="round"/>`;
		},
	},
	{
		id: "pop-coral",
		name: "Pop Coral",
		art: (type) => {
			const shape = type === "arrow" ? arrow : hand;
			const gleam =
				type === "arrow"
					? '<path d="M7 9v9.5" stroke="#FFE9C0" stroke-width="2" stroke-linecap="round"/>'
					: '<path d="M13.8 6.5v7" stroke="#FFE9C0" stroke-width="2" stroke-linecap="round"/>';
			return `<path d="${shape}" transform="translate(1.1 1.1)" fill="#FFD66C" stroke="#262351" stroke-width="2.1" stroke-linejoin="round"/><path d="${shape}" fill="#FF705E" stroke="#262351" stroke-width="2.5" stroke-linejoin="round"/>${gleam}`;
		},
	},
	{
		id: "pixel-candy",
		name: "Pixel Candy",
		art: (type) => {
			const shape = type === "arrow" ? pixelArrow : pixelHand;
			const details =
				type === "arrow"
					? '<path d="M6 9h2v10H6zM9 19h2v2H9z" fill="#FFF4E7"/>'
					: '<path d="M13 5h2v9h-2zM19 15h2v4h-2zM23 17h2v3h-2z" fill="#FFF4E7"/>';
			return `<path d="${shape}" fill="#F48AC4" stroke="#241E35" stroke-width="2" stroke-linejoin="miter"/>${details}<path d="${shape}" fill="none" stroke="#241E35" stroke-width="1" stroke-linejoin="miter"/>`;
		},
	},
	{
		id: "star-sprout",
		name: "Star Sprout",
		art: (type) => {
			if (type === "arrow") {
				return `<path d="${arrow}" fill="#B8EFD5" stroke="#142344" stroke-width="2.5" stroke-linejoin="round"/><path d="M24.5 21.2q-2-1.3-1.6-3.2 1.9.3 2.1 2.4.6-1.8 2.4-1.7.2 1.9-2.5 2.5" fill="#68CFAE" stroke="#142344" stroke-width=".9" stroke-linejoin="round"/><path d="m25 21 1.25 2.2 2.5.4-1.8 1.8.4 2.5-2.35-1.2-2.25 1.2.4-2.5-1.8-1.8 2.5-.4Z" fill="#FFC66B" stroke="#142344" stroke-width="1.1" stroke-linejoin="round"/><circle cx="24.25" cy="24.5" r=".42" fill="#142344"/><circle cx="25.7" cy="24.5" r=".42" fill="#142344"/>`;
			}
			return `<path d="${hand}" fill="#FFF8E8" stroke="#142344" stroke-width="2.5" stroke-linejoin="round"/><path d="M12 25.1q6 1.8 14.2 0V28q-5 2.1-13.4.5Z" fill="#B8EFD5" stroke="#142344" stroke-width="1.2"/><path d="M19.2 24.2q-1.8-1.1-1.5-2.5 1.4.1 1.8 1.7.5-1.6 2-1.4.1 1.5-2.3 2.2" fill="#68CFAE" stroke="#142344" stroke-width=".8"/><path d="m19.8 23.8 1 1.6 1.8.3-1.3 1.3.3 1.8-1.8-.9-1.7.9.3-1.8-1.3-1.3 1.8-.3Z" fill="#FFC66B" stroke="#142344" stroke-width=".8"/><circle cx="19.2" cy="26.1" r=".28" fill="#142344"/><circle cx="20.4" cy="26.1" r=".28" fill="#142344"/>`;
		},
	},
];

function svgFor(theme, type) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none">${theme.art(type)}</svg>\n`;
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");

for (const theme of themes) {
	const master = path.join(MASTER_DIR, theme.id);
	const output = path.join(PUBLIC_DIR, theme.id);
	await mkdir(master, { recursive: true });
	await mkdir(output, { recursive: true });
	for (const type of ["arrow", "pointer"]) {
		const masterPath = path.join(master, `${type}.svg`);
		try {
			await writeFile(masterPath, svgFor(theme, type), { flag: "wx" });
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		const svg = await readFile(masterPath, "utf8");
		const dataUrl = await page.evaluate(
			async ({ source, size }) => {
				const image = new Image();
				image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
				await image.decode();
				const canvas = document.createElement("canvas");
				canvas.width = size;
				canvas.height = size;
				canvas.getContext("2d").drawImage(image, 0, 0, size, size);
				return canvas.toDataURL("image/png");
			},
			{ source: svg, size: SIZE },
		);
		await writeFile(
			path.join(output, `${type}.png`),
			Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
		);
	}
}

await browser.close();
console.log(`Generated ${themes.length} original themes (${SIZE}px PNGs).`);
