import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readCassette, startRecorder } from "../lib/cassette";
import { offlineStore } from "../lib/harness";
import { askJudge } from "../lib/judge";
import {
	assertComparable,
	boundBaselineFromMeasurement,
	exportMeasurement,
	finalizeJudgedMeasurementCandidate,
	prepareMeasurementCandidate,
	replayMeasurement,
	verifyBoundBaseline,
	verifyMeasurementDirectory,
} from "../lib/measurement";
import { startScriptedModel } from "../lib/model-server";
import {
	captureSourceIdentity,
	type SourceIdentity,
	sourceIdentityFromManifests,
} from "../lib/provenance";
import { buildReport, fingerprintOf, summarizeScenario } from "../lib/report";
import { runRepetition } from "../lib/runner";
import { scoreRun } from "../lib/score";
import { publicHeaderProfile, transportIdentity } from "../lib/transport";
import { getScenario } from "../scenarios/registry";

const DIRECTORY = mkdtempSync(join(tmpdir(), "wb-measurement-l1-"));

function alternateProvenance(source: SourceIdentity): SourceIdentity {
	return sourceIdentityFromManifests({
		commit: source.commit === "b".repeat(40) ? "c".repeat(40) : "b".repeat(40),
		dirtyManifest: [source.effectiveManifest[0]],
		effectiveManifest: source.effectiveManifest,
	});
}

afterAll(() => rmSync(DIRECTORY, { recursive: true, force: true }));

describe("recorded measurement lifecycle", () => {
	it("keeps success-then-rejection usage incomplete and refuses adoption", async () => {
		const scenario = getScenario("target-right-clip");
		const currentSource = captureSourceIdentity();
		const source = alternateProvenance(currentSource);
		const upstream = await startScriptedModel(scenario.demoScript ?? [], {
			wireApi: "responses",
			model: "gpt-5-incomplete",
		});
		const runDir = join(DIRECTORY, "responses-incomplete-run");
		const cassetteFile = join(runDir, "main-cassette-rep-0.json");
		const headers = publicHeaderProfile({});
		const transport = transportIdentity({
			wireApi: "responses",
			maxOutputTokens: 2048,
			publicHeadersSha256: headers.sha256,
			limits: { maxRequests: 1 },
		});
		const recorder = await startRecorder({
			upstream: upstream.url,
			file: cassetteFile,
			scenario: scenario.id,
			provider: "loopback",
			model: "gpt-5-incomplete",
			wireApi: "responses",
			transport,
			publicHeaders: headers,
		});
		let result: Awaited<ReturnType<typeof runRepetition>>;
		try {
			result = await runRepetition({
				scenario,
				rep: 0,
				endpoint: recorder,
				store: offlineStore({
					baseUrl: recorder.url,
					allowAgentEdits: true,
					model: "gpt-5-incomplete",
				}),
				maxRetries: 0,
			});
		} finally {
			recorder.close();
			upstream.close();
		}
		expect(result.run.ok).toBe(false);
		const cassette = readCassette(cassetteFile);
		expect(cassette.rounds).toHaveLength(1);
		expect(cassette.attempts).toHaveLength(2);

		const summary = summarizeScenario({
			scenarioId: scenario.id,
			title: scenario.title,
			tags: scenario.tags,
			gate: scenario.gate,
			results: [result],
		});
		const report = buildReport({
			label: "responses-incomplete-test-only",
			fingerprint: fingerprintOf({
				wire: result.run.wire,
				model: "gpt-5-incomplete",
				reps: 1,
				effectiveSourceSha256: source.effectiveSha256,
			}),
			scenarios: [summary],
			notices: [],
		});
		const candidate = prepareMeasurementCandidate({
			runDir,
			scenario,
			results: [result],
			cassetteFiles: [cassetteFile],
			report,
			requestedModel: "gpt-5-incomplete",
			observedModel: cassette.resolvedModel,
			provider: "loopback",
			endpoint: upstream.url,
			source,
		});
		expect(candidate.manifest.usage?.agent).toMatchObject({
			status: "incomplete",
			attempts: 2,
			rounds: 1,
			withUsage: 1,
		});

		const id = "loopback-responses-incomplete";
		const review = join(DIRECTORY, "responses-incomplete-review.json");
		writeFileSync(
			review,
			`${JSON.stringify({
				schema: 1,
				measurementId: id,
				reviewer: { kind: "independent", label: "test fixture reviewer" },
				disposition: "approved",
				reviewedAt: "2026-09-12T00:35:00.000Z",
				summary: "Test-only incomplete Responses receipt.",
			})}\n`,
			"utf8",
		);
		expect(() =>
			exportMeasurement({
				runDir,
				id,
				reviewFile: review,
				measurementsDir: join(DIRECTORY, "incomplete-measurements"),
			}),
		).toThrow(expect.objectContaining({ code: "CANDIDATE_INCOMPLETE" }));
	});

	it("binds, adopts, replays, and baselines a native Responses measurement", async () => {
		const scenario = getScenario("target-right-clip");
		const currentSource = captureSourceIdentity();
		const source = alternateProvenance(currentSource);
		const script = (scenario.demoScript ?? []).map((turn, index) =>
			turn.kind === "tools" && index === 0
				? { ...turn, opaqueReasoning: "synthetic_measurement_opaque" }
				: turn,
		);
		const upstream = await startScriptedModel(script, {
			wireApi: "responses",
			model: "gpt-5-measurement",
		});
		const runDir = join(DIRECTORY, "responses-run");
		const cassetteFile = join(runDir, "main-cassette-rep-0.json");
		const headers = publicHeaderProfile({});
		const transport = transportIdentity({
			wireApi: "responses",
			maxOutputTokens: 2048,
			publicHeadersSha256: headers.sha256,
		});
		const recorder = await startRecorder({
			upstream: upstream.url,
			file: cassetteFile,
			scenario: scenario.id,
			provider: "loopback",
			model: "gpt-5-measurement",
			wireApi: "responses",
			transport,
			publicHeaders: headers,
		});
		let result: Awaited<ReturnType<typeof runRepetition>>;
		try {
			result = await runRepetition({
				scenario,
				rep: 0,
				endpoint: recorder,
				store: offlineStore({
					baseUrl: recorder.url,
					allowAgentEdits: true,
					model: "gpt-5-measurement",
				}),
				maxRetries: 0,
			});
		} finally {
			recorder.close();
			upstream.close();
		}
		const summary = summarizeScenario({
			scenarioId: scenario.id,
			title: scenario.title,
			tags: scenario.tags,
			gate: scenario.gate,
			results: [result],
		});
		const report = buildReport({
			label: "responses-loopback-test-only",
			fingerprint: fingerprintOf({
				wire: result.run.wire,
				model: "gpt-5-measurement",
				reps: 1,
				effectiveSourceSha256: source.effectiveSha256,
			}),
			scenarios: [summary],
			notices: [],
		});
		const candidate = prepareMeasurementCandidate({
			runDir,
			scenario,
			results: [result],
			cassetteFiles: [cassetteFile],
			report,
			requestedModel: "gpt-5-measurement",
			observedModel: "gpt-5-measurement",
			provider: "loopback",
			endpoint: upstream.url,
			source,
		});
		expect(candidate.manifest.fingerprints.transportSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(candidate.manifest.usage?.agent).toMatchObject({
			status: "complete",
			rounds: 3,
			withUsage: 3,
			totals: { input_tokens: 303, output_tokens: 33, total_tokens: 336 },
		});

		const id = "loopback-responses-target-right-clip";
		const review = join(DIRECTORY, "responses-review.json");
		writeFileSync(
			review,
			`${JSON.stringify({
				schema: 1,
				measurementId: id,
				reviewer: { kind: "independent", label: "test fixture reviewer" },
				disposition: "approved",
				reviewedAt: "2026-09-12T00:30:00.000Z",
				summary: "Test-only Responses lifecycle receipt; no model-quality claim.",
			})}\n`,
			"utf8",
		);
		const measurementsDir = join(DIRECTORY, "responses-measurements");
		const adopted = exportMeasurement({ runDir, id, reviewFile: review, measurementsDir });
		const verified = verifyMeasurementDirectory(adopted, { requireApprovedReview: true });
		expect(await replayMeasurement(id, measurementsDir)).toEqual(candidate.manifest.results);
		const baseline = boundBaselineFromMeasurement(verified);
		expect(() => verifyBoundBaseline(baseline, verified)).not.toThrow();
	});

	it("records, adopts, verifies, replays, and binds one public synthetic measurement", async () => {
		const scenario = getScenario("target-right-clip");
		const currentSource = captureSourceIdentity();
		const source = alternateProvenance(currentSource);
		const upstream = await startScriptedModel(scenario.demoScript ?? []);
		const runDir = join(DIRECTORY, "run");
		const cassetteFile = join(runDir, "main-cassette-rep-0.json");
		const recorder = await startRecorder({
			upstream: upstream.url,
			file: cassetteFile,
			scenario: scenario.id,
			provider: "loopback",
			model: "workbench",
		});
		let result: Awaited<ReturnType<typeof runRepetition>>;
		try {
			result = await runRepetition({ scenario, rep: 0, endpoint: recorder });
		} finally {
			recorder.close();
			upstream.close();
		}
		const summary = summarizeScenario({
			scenarioId: scenario.id,
			title: scenario.title,
			tags: scenario.tags,
			gate: scenario.gate,
			results: [result],
		});
		const report = buildReport({
			label: "loopback-test-only",
			fingerprint: fingerprintOf({
				wire: result.run.wire,
				model: "workbench",
				reps: 1,
				effectiveSourceSha256: source.effectiveSha256,
			}),
			scenarios: [summary],
			notices: [],
		});
		const candidate = prepareMeasurementCandidate({
			runDir,
			scenario,
			results: [result],
			cassetteFiles: [cassetteFile],
			report,
			requestedModel: "workbench",
			observedModel: readCassette(cassetteFile).resolvedModel,
			provider: "loopback",
			endpoint: upstream.url,
			source,
		});
		expect(candidate.manifest.complete).toBe(true);
		expect(result.run.wire.systemChars).toBeGreaterThan(0);
		expect(candidate.manifest.fingerprints.systemSha256).toBe(result.run.wire.systemSha256);
		expect(candidate.manifest.source.commit).not.toBe(currentSource.commit);
		expect(candidate.manifest.source.effectiveSha256).toBe(currentSource.effectiveSha256);
		expect(candidate.manifest.source.effectiveManifest.length).toBeGreaterThanOrEqual(14);

		const id = "loopback-target-right-clip";
		const review = join(DIRECTORY, "review.json");
		writeFileSync(
			review,
			`${JSON.stringify(
				{
					schema: 1,
					measurementId: id,
					reviewer: { kind: "independent", label: "test fixture reviewer" },
					disposition: "approved",
					reviewedAt: "2026-09-12T00:10:00.000Z",
					summary: "Test-only review fixture; no product or model-quality claim.",
				},
				null,
				"\t",
			)}\n`,
			"utf8",
		);
		const measurementsDir = join(DIRECTORY, "measurements");
		const adopted = exportMeasurement({
			runDir,
			id,
			reviewFile: review,
			measurementsDir,
		});
		const verified = verifyMeasurementDirectory(adopted, { requireApprovedReview: true });
		expect(verified.manifest.results).toEqual(candidate.manifest.results);
		expect(await replayMeasurement(id, measurementsDir)).toEqual(candidate.manifest.results);
		const baseline = boundBaselineFromMeasurement(verified);
		expect(() => verifyBoundBaseline(baseline, verified)).not.toThrow();
		expect(() => assertComparable(verified.manifest, verified.manifest)).not.toThrow();
	});

	it("keeps a judged candidate incomplete until a recorded judge pass is attached", async () => {
		const scenario = getScenario("consent");
		const judged = scenario.judged ?? [];
		expect(judged).toHaveLength(1);
		const currentSource = captureSourceIdentity();
		const source = alternateProvenance(currentSource);
		const upstream = await startScriptedModel([
			...(scenario.demoScript ?? []),
			{
				kind: "text",
				text: JSON.stringify({
					verdict: "conforme",
					raison: "La réponse demande clairement l'accord avant toute modification.",
				}),
			},
		]);
		const runDir = join(DIRECTORY, "judged-run");
		const cassetteFile = join(runDir, "main-cassette-rep-0.json");
		const mainRecorder = await startRecorder({
			upstream: upstream.url,
			file: cassetteFile,
			scenario: scenario.id,
			provider: "loopback",
			model: "workbench",
		});
		let result: Awaited<ReturnType<typeof runRepetition>>;
		try {
			result = await runRepetition({ scenario, rep: 0, endpoint: mainRecorder });
		} finally {
			mainRecorder.close();
		}
		const initialSummary = summarizeScenario({
			scenarioId: scenario.id,
			title: scenario.title,
			tags: scenario.tags,
			gate: scenario.gate,
			results: [result],
		});
		const initialReport = buildReport({
			label: "judged-loopback-test-only",
			fingerprint: fingerprintOf({
				wire: result.run.wire,
				model: "workbench",
				reps: 1,
				effectiveSourceSha256: source.effectiveSha256,
			}),
			scenarios: [initialSummary],
			notices: [],
		});
		const candidate = prepareMeasurementCandidate({
			runDir,
			scenario,
			results: [result],
			cassetteFiles: [cassetteFile],
			report: initialReport,
			requestedModel: "workbench",
			observedModel: readCassette(cassetteFile).resolvedModel,
			provider: "loopback",
			endpoint: upstream.url,
			source,
		});
		expect(candidate.manifest.complete).toBe(false);

		const judgeCassette = join(runDir, "judge-cassette.json");
		const judgeRecorder = await startRecorder({
			upstream: upstream.url,
			file: judgeCassette,
			scenario: `judge-${scenario.id}`,
			provider: "loopback",
			model: "workbench",
		});
		const readings = new Map();
		try {
			for (const check of judged) {
				readings.set(
					check.id,
					await askJudge({
						endpoint: { baseUrl: judgeRecorder.url, model: "workbench" },
						rubric: check.rubric,
						input: {
							prompt: scenario.prompt,
							answer: result.run.answer,
							facts: check.facts(result.context),
						},
					}),
				);
			}
		} finally {
			judgeRecorder.close();
			upstream.close();
		}
		const finalScored = scoreRun(scenario, result.context, readings);
		const finalSummary = summarizeScenario({
			scenarioId: scenario.id,
			title: scenario.title,
			tags: scenario.tags,
			gate: scenario.gate,
			results: [{ scored: finalScored }],
		});
		const finalReport = buildReport({
			label: "judged-loopback-test-only/final",
			fingerprint: fingerprintOf({
				wire: result.run.wire,
				model: "workbench",
				reps: 1,
				effectiveSourceSha256: source.effectiveSha256,
			}),
			scenarios: [finalSummary],
			notices: [],
		});
		const finalized = finalizeJudgedMeasurementCandidate({
			runDir,
			scenario,
			scored: [{ rep: 0, scored: finalScored }],
			judgeCassetteFile: judgeCassette,
			report: finalReport,
			requestedJudgeModel: "workbench",
			observedJudgeModel: readCassette(judgeCassette).resolvedModel,
			provider: "loopback",
			endpoint: upstream.url,
		});
		expect(finalized.manifest.complete).toBe(true);
		expect(finalized.manifest.artifacts.map((artifact) => artifact.role)).toContain(
			"judge-cassette",
		);

		const id = "loopback-consent-judged";
		const review = join(DIRECTORY, "judged-review.json");
		writeFileSync(
			review,
			`${JSON.stringify({
				schema: 1,
				measurementId: id,
				reviewer: { kind: "independent", label: "test fixture reviewer" },
				disposition: "approved",
				reviewedAt: "2026-09-12T00:20:00.000Z",
				summary: "Test-only judged lifecycle receipt; no model-quality claim.",
			})}\n`,
			"utf8",
		);
		const measurementsDir = join(DIRECTORY, "judged-measurements");
		exportMeasurement({ runDir, id, reviewFile: review, measurementsDir });
		expect(await replayMeasurement(id, measurementsDir)).toEqual(finalized.manifest.results);
	});
});
