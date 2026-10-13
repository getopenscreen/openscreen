import { beforeEach, describe, expect, it } from "vitest";
import {
	captureHistoryPosition,
	clearHistory,
	future,
	past,
	pushFuture,
	pushHistory,
	pushPast,
	type Snapshot,
} from "./undoStack";

const snapshot = (step: string): Snapshot => ({ projectId: "project", doc: { step } });

describe("optimistic save history positions", () => {
	beforeEach(clearHistory);

	it("inserts a late optimistic edit before edits begun after an empty-stack anchor", () => {
		const position = captureHistoryPosition();
		const original = snapshot("original");
		const imported = snapshot("imported");
		pushHistory(imported);
		pushHistory(original, position);
		expect(past).toEqual([original, imported]);
	});

	it("inserts after the captured anchor without reversing later edit history", () => {
		const existing = snapshot("existing");
		pushHistory(existing);
		const position = captureHistoryPosition();
		const original = snapshot("original");
		const imported = snapshot("imported");
		pushHistory(imported);
		pushHistory(original, position);
		expect(past).toEqual([existing, original, imported]);
	});

	it("does not alter current history or redo after the epoch changed", () => {
		pushHistory(snapshot("old project"));
		const position = captureHistoryPosition();
		clearHistory();
		const current = snapshot("new project");
		const next = snapshot("redo");
		pushPast(current);
		pushFuture(next);
		pushHistory(snapshot("late old project"), position);
		expect(past).toEqual([current]);
		expect(future).toEqual([next]);
	});

	it("skips a pruned nonempty anchor instead of appending obsolete history", () => {
		pushHistory(snapshot("anchor"));
		const position = captureHistoryPosition();
		for (let i = 0; i < 51; i++) pushHistory(snapshot(`later ${i}`));
		const before = [...past];
		pushHistory(snapshot("obsolete"), position);
		expect(past).toEqual(before);
		expect(past).toHaveLength(50);
	});

	it("skips an empty-stack anchor when subsequent edits filled the history limit", () => {
		const position = captureHistoryPosition();
		for (let i = 0; i < 50; i++) pushHistory(snapshot(`later ${i}`));
		const before = [...past];
		pushHistory(snapshot("obsolete"), position);
		expect(past).toEqual(before);
	});

	it("keeps ordinary history pushes bounded and clears redo", () => {
		pushFuture(snapshot("redo"));
		for (let i = 0; i < 60; i++) pushHistory(snapshot(`${i}`));
		expect(past).toHaveLength(50);
		expect(past[0]).toEqual(snapshot("10"));
		expect(future).toHaveLength(0);
	});
});
