import { expect, it } from "vitest";
import {
	runTranscriptImport,
	transcriptImportPending,
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
