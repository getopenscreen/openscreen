import { describe, expect, it } from "vitest";
import { readCassette, startRecorder, startReplay } from "../lib/cassette";
import { askJudge, type JudgeRubric } from "../lib/judge";
import { startScriptedModel } from "../lib/model-server";
import { publicHeaderProfile, transportIdentity } from "../lib/transport";

const FILE = "workbench/.agent-evidence/responses-validation/vitest/judge.json";
const RUBRIC: JudgeRubric = {
	id: "judge-responses-test",
	property: "The answer names the completed edit.",
	conforme: ["The answer says the zoom was added."],
	fautif: ["The answer denies the edit."],
	indéterminé: ["The answer is ambiguous."],
};

describe("Responses judge", () => {
	it("records and replays the same verdict and native usage without network", async () => {
		const upstream = await startScriptedModel(
			[{ kind: "text", text: '{"verdict":"conforme","raison":"zoom named"}' }],
			{ wireApi: "responses", model: "gpt-5-judge" },
		);
		const headers = publicHeaderProfile({});
		const transport = transportIdentity({
			wireApi: "responses",
			maxOutputTokens: 512,
			publicHeadersSha256: headers.sha256,
		});
		const recorder = await startRecorder({
			upstream: upstream.url,
			file: FILE,
			scenario: "judge-responses",
			provider: "loopback",
			model: "gpt-5-judge",
			wireApi: "responses",
			transport,
			publicHeaders: headers,
		});
		let recorded;
		try {
			recorded = await askJudge({
				endpoint: { baseUrl: recorder.url, model: "gpt-5-judge", wireApi: "responses" },
				rubric: RUBRIC,
				input: { prompt: "Add a zoom", answer: "Added a zoom.", facts: ["one zoom added"] },
			});
		} finally {
			recorder.close();
			upstream.close();
		}
		const cassette = readCassette(FILE);
		expect(cassette.rounds[0].usage).toEqual(expect.objectContaining({ input_tokens: 100 }));

		const replay = await startReplay({ file: FILE, onStale: "throw" });
		let replayed;
		try {
			replayed = await askJudge({
				endpoint: { baseUrl: replay.url, model: "gpt-5-judge", wireApi: "responses" },
				rubric: RUBRIC,
				input: { prompt: "Add a zoom", answer: "Added a zoom.", facts: ["one zoom added"] },
			});
			replay.assertFresh();
		} finally {
			replay.close();
		}
		expect(replayed).toEqual(recorded);
		expect(replay.staleRounds).toEqual([]);
		expect(replay.requests).toHaveLength(1);
	});
});
