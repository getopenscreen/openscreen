import type { PluginBuild } from "esbuild";
import { expect, it } from "vitest";
import {
	allocateDocumentId,
	type DocumentIdLedger,
	documentIdScope,
	validateDocumentIdLedger,
} from "../lib/document-ids";
import { documentIdsEsbuildPlugin, instrumentDocumentIds } from "../lib/id-instrumentation";

const zoom = "zoom_11111111-1111-4111-8111-111111111111";
const trim = "trim_22222222-2222-4222-8222-222222222222";
const ledger = (): DocumentIdLedger => ({ schema: 1, ids: [{ prefix: "zoom", id: zoom }] });

it("rejects malformed, duplicate and unsupported ledgers", () => {
	for (const v of [
		null,
		{ schema: 2, ids: [] },
		{ ...ledger(), extra: true },
		{ schema: 1, ids: [...ledger().ids, ...ledger().ids] },
		{ schema: 1, ids: [{ prefix: "trim", id: zoom }] },
		{ schema: 1, ids: [{ prefix: "zoom", id: "zoom_wrong" }] },
	]) {
		expect(() => validateDocumentIdLedger(v)).toThrow();
	}
});
it("fails closed on wrong prefix, exhaustion, initial collisions and unused IDs", async () => {
	for (const [initial, expected, prefix] of [
		[{}, ledger(), "trim"],
		[{}, { schema: 1, ids: [] }, "zoom"],
		[{ id: zoom }, ledger(), "zoom"],
	] as const) {
		const session = documentIdScope(initial, expected as DocumentIdLedger);
		await session.run(async () => {
			expect(() => allocateDocumentId(prefix, () => trim)).toThrow();
		});
		expect(() => session.complete()).toThrow();
		session.close();
	}
	const unused = documentIdScope({}, ledger());
	expect(() => unused.complete()).toThrow(/fully consumed/);
});
it("concurrent async scopes do not share allocations, and closed scopes refuse late work", async () => {
	const a = documentIdScope({});
	const b = documentIdScope({});
	await Promise.all([
		a.run(async () => {
			await Promise.resolve();
			allocateDocumentId("zoom", () => zoom);
		}),
		b.run(async () => {
			await Promise.resolve();
			allocateDocumentId("trim", () => trim);
		}),
	]);
	expect(a.ledger.ids).toEqual([{ prefix: "zoom", id: zoom }]);
	expect(b.ledger.ids).toEqual([{ prefix: "trim", id: trim }]);
	a.close();
	await a.run(async () => {
		expect(() => allocateDocumentId("zoom", () => zoom)).toThrow(/closed/);
	});
});
it("instrumentation refuses an unreviewed change to the production boundary", () => {
	expect(() => instrumentDocumentIds("export const createId = crypto.randomUUID;")).toThrow(
		/boundary changed/,
	);
});
it("the build hook matches the production boundary on Windows and POSIX", () => {
	let filter = /never/;
	documentIdsEsbuildPlugin().setup({
		onLoad(options: { filter: RegExp }) {
			filter = options.filter;
		},
	} as unknown as PluginBuild);
	expect(filter.test("C:\\repo\\src\\lib\\ai-edition\\document\\ids.ts")).toBe(true);
	expect(filter.test("/repo/src/lib/ai-edition/document/ids.ts")).toBe(true);
	expect(filter.test("/repo/other/ids.ts")).toBe(false);
});
