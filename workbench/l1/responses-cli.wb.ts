import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { readCassette, startRecorder } from "../lib/cassette";
import { ENV_KEYS } from "../lib/env";
import { offlineStore } from "../lib/harness";
import { startScriptedModel } from "../lib/model-server";
import { runRepetition } from "../lib/runner";
import { publicHeaderProfile, transportIdentity } from "../lib/transport";
import { getScenario } from "../scenarios/registry";

const CASSETTE = "workbench/.agent-evidence/responses-validation/vitest/cli-replay.json";
const LABEL = "responses-cli-offline";

describe("offline main CLI replay", () => {
	it("runs without live env, asserts freshness, and writes observed replay usage", async () => {
		const upstream = await startScriptedModel(
			[
				{
					kind: "tools",
					opaqueReasoning: "synthetic_cli_opaque",
					calls: [{ name: "getCurrentDocument", args: {} }],
				},
				{
					kind: "tools",
					calls: [{ name: "addZoom", args: { startSec: 43, endSec: 48, depth: 3 } }],
				},
				{ kind: "text", text: "Added the zoom to the demo clip." },
			],
			{ wireApi: "responses", model: "gpt-5-cli" },
		);
		const headers = publicHeaderProfile({});
		const transport = transportIdentity({
			wireApi: "responses",
			maxOutputTokens: 2048,
			publicHeadersSha256: headers.sha256,
		});
		const recorder = await startRecorder({
			upstream: upstream.url,
			file: CASSETTE,
			scenario: "target-right-clip",
			provider: "loopback",
			model: "gpt-5-cli",
			wireApi: "responses",
			transport,
			publicHeaders: headers,
		});
		try {
			const result = await runRepetition({
				scenario: getScenario("target-right-clip"),
				endpoint: recorder,
				store: offlineStore({ baseUrl: recorder.url, allowAgentEdits: true, model: "gpt-5-cli" }),
				maxRetries: 0,
			});
			expect(result.run.ok, result.run.error).toBe(true);
		} finally {
			recorder.close();
			upstream.close();
		}

		buildSync({
			entryPoints: ["workbench/cli-entry.ts"],
			bundle: true,
			platform: "node",
			format: "cjs",
			packages: "external",
			outfile: "workbench/.build/cli.cjs",
			logLevel: "silent",
		});
		const envNames = new Set<string>(Object.values(ENV_KEYS));
		const cleanEnv = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !envNames.has(name)),
		);
		const child = spawnSync(
			process.execPath,
			[
				"workbench/.build/cli.cjs",
				"replay",
				"--scenario",
				"target-right-clip",
				"--cassette",
				CASSETTE,
				"--label",
				LABEL,
				"--timeout",
				"30000",
			],
			{
				cwd: process.cwd(),
				env: cleanEnv as typeof process.env,
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
		const receipt = JSON.parse(
			readFileSync(`workbench/runs/${LABEL}/target-right-clip/replay-receipt.json`, "utf8"),
		);
		const cassette = readCassette(CASSETTE);
		expect(receipt.upstreamRequests).toBe(0);
		expect(receipt.fresh).toBe(true);
		expect(receipt.localReplayRequests).toBe(3);
		expect(receipt.observedUsage.map((round: { usage: unknown }) => round.usage)).toEqual(
			cassette.rounds.map((round) => round.usage),
		);
		expect(receipt.result.ok).toBe(true);
		expect(receipt.result.toolSequence.map((call: { name: string }) => call.name)).toEqual([
			"getCurrentDocument",
			"addZoom",
		]);
	});
});
