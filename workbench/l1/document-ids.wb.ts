import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readCassette, startRecorder, startReplay, writeCassette } from "../lib/cassette";
import { singleClip } from "../lib/fixtures";
import { runScenario } from "../lib/harness";
import { type ModelServerHandle, type ScriptedTurn, startScriptedModel } from "../lib/model-server";

it("records actual production document IDs separately for each turn", async () => {
	const run = await runScenario({
		prompt: "Add a zoom",
		document: singleClip(),
		script: [
			{ kind: "tools", calls: [{ name: "addZoom", args: { startSec: 2, endSec: 4, depth: 2 } }] },
			{ kind: "text", text: "Done" },
		],
	});
	expect(run.ok, run.error).toBe(true);
	expect(run).toHaveProperty("documentIds", {
		schema: 1,
		ids: [{ prefix: "zoom", id: run.document!.zoomRanges[0].id }],
	});
});
it("retains the last actual tool document when the model stops without a final answer", async () => {
	const run = await runScenario({
		prompt: "Add a zoom",
		document: singleClip(),
		maxRetries: 0,
		script: [
			{ kind: "tools", calls: [{ name: "addZoom", args: { startSec: 2, endSec: 4, depth: 2 } }] },
			{ kind: "text", text: "" },
		],
	});
	expect(run.ok).toBe(false);
	expect(run.error).toContain("Empty response");
	expect(run.document?.zoomRanges).toHaveLength(1);
	expect(run.documentIds.ids[0].id).toBe(run.document!.zoomRanges[0].id);
});

for (const wrongId of [false, true]) {
	it(`strict record/replay preserves create-then-update results (wrong model ID: ${wrongId})`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "wb-document-ids-"));
		const file = join(dir, "recording.json");
		let upstream: ModelServerHandle;
		const script: ScriptedTurn[] = [
			{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
			{ kind: "tools", calls: [{ name: "addZoom", args: { startSec: 2, endSec: 4, depth: 2 } }] },
			{
				kind: "tools",
				calls: [
					{
						name: "setZoom",
						get args() {
							const request = upstream.requests[2].raw as {
								messages: Array<{ role: string; content: string }>;
							};
							const tool = [...request.messages].reverse().find((m) => m.role === "tool")!;
							const created = JSON.parse(tool.content) as { zoomId: string };
							return {
								zoomId: wrongId ? "zoom_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" : created.zoomId,
								endSec: 5,
							};
						},
					},
				],
			},
			{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
			{ kind: "text", text: "Finished the attempt." },
		];
		upstream = await startScriptedModel(script);
		const recorder = await startRecorder({
			upstream: upstream.url,
			file,
			scenario: "id-update",
			provider: "openai-compatible",
			model: "workbench-scripted",
		});
		try {
			const original = await runScenario({
				prompt: "Update a zoom",
				document: singleClip(),
				endpoint: recorder,
				maxRetries: 0,
			});
			recorder.close();
			expect(original.ok, original.error).toBe(true);
			expect(original.wire.calls.find((c) => c.name === "setZoom")?.resultOk).toBe(!wrongId);
			writeCassette(file, { ...readCassette(file), documentIds: original.documentIds });
			const replay = await startReplay({ file, onStale: "throw" });
			try {
				const repeated = await runScenario({
					prompt: "Update a zoom",
					document: singleClip(),
					endpoint: replay,
					replayDocumentIds: readCassette(file).documentIds,
					maxRetries: 0,
				});
				expect(repeated.ok, repeated.error).toBe(true);
				expect(repeated.wire.calls.find((c) => c.name === "setZoom")?.resultOk).toBe(!wrongId);
				expect(repeated.document?.zoomRanges).toEqual(original.document?.zoomRanges);
				expect(() => replay.assertFresh()).not.toThrow();
			} finally {
				replay.close();
			}
			if (!wrongId) {
				const legacy = await startReplay({ file, onStale: "throw" });
				try {
					const repeated = await runScenario({
						prompt: "Update a zoom",
						document: singleClip(),
						endpoint: legacy,
						maxRetries: 0,
					});
					expect(repeated.wire.calls.find((c) => c.name === "setZoom")?.resultOk).toBe(false);
					expect(() => legacy.assertFresh()).toThrow(/périmée/);
				} finally {
					legacy.close();
				}
			}
		} finally {
			recorder.close();
			upstream.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
