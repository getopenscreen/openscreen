// A storyboard for capture.mjs: copy it next to your take and adapt it. Three beats, 12 s.
export const url = "http://localhost:3000";
export const viewport = { width: 1280, height: 720 };
export const scale = 2;

// Before capture starts: put the page in the state of the first beat, so the take opens on the result.
export async function prepare(page) {
	await page.fill("#search", "quarterly report");
	await page.mouse.move(640, 600);
	await page.waitForTimeout(800);
}

export async function run(s) {
	await s.wait(2600); // beat 1: the result already on screen, under the title
	await s.moveTo("text=Export", 900); // beat 2: the action
	await s.click();
	await s.wait(1800); // hold until the result has redrawn
	await s.moveTo("#format", 800); // beat 3
	await s.click();
	await s.type("PDF", 70);
	await s.wait(1200);
	await s.move(1230, 690, 800); // park the pointer off every label and number
	await s.wait(2000);
}
