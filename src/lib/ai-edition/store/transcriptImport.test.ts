import { expect, it, vi } from "vitest";
import {
	runTranscriptImport,
	transcriptImportPending,
	waitForProjectTranscriptImports,
	waitForTranscriptImport,
} from "./transcriptImport";

it("holds the asset reservation until save settles, releasing failures too", async () => {
	let finish!: () => void;
	const work = runTranscriptImport(
		"p",
		"a",
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	expect(transcriptImportPending("p", "a")).toBe(true);
	expect(transcriptImportPending("other", "a")).toBe(false);
	let released = false;
	const wait = waitForTranscriptImport("p", "a").then(() => {
		released = true;
	});
	await Promise.resolve();
	expect(released).toBe(false);
	finish();
	await work;
	await wait;
	expect(released).toBe(true);
	expect(transcriptImportPending("p", "a")).toBe(false);
	await expect(
		runTranscriptImport("p", "a", async () => {
			throw new Error("save");
		}),
	).rejects.toThrow("save");
	expect(transcriptImportPending("p", "a")).toBe(false);
});

it.each([
	false,
	true,
])("cancels a project wait without releasing the import reservation (already aborted: %s)", async (alreadyAborted) => {
	let finish!: () => void;
	const work = runTranscriptImport(
		"cancel_project",
		"asset",
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const controller = new AbortController();
	if (alreadyAborted) controller.abort();
	let waiterSettled = false;
	const wait = waitForProjectTranscriptImports("cancel_project", controller.signal).then(() => {
		waiterSettled = true;
	});
	controller.abort();
	try {
		await vi.waitFor(() => expect(waiterSettled).toBe(true), { timeout: 100 });
		expect(transcriptImportPending("cancel_project", "asset")).toBe(true);
	} finally {
		finish();
		await work;
		await wait;
	}
	expect(transcriptImportPending("cancel_project", "asset")).toBe(false);
});
