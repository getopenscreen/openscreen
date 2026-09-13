import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ArtifactReference,
	assertComparable,
	boundBaselineFromMeasurement,
	exportMeasurement,
	MeasurementError,
	type MeasurementManifest,
	type RecordedChecks,
	recomputeMeasurementCounts,
	verifyBoundBaseline,
	verifyMeasurementDirectory,
	verifyMeasurementId,
} from "../lib/measurement";
import {
	MANDATORY_SOURCE_ANCHORS,
	sha256Bytes,
	sourceIdentityFromManifests,
} from "../lib/provenance";
import { wilson95 } from "../lib/stats";
import { runMeasurementCli } from "../measurement-cli";

const roots: string[] = [];
const cliOutputs: string[] = [];
const HASH = (letter: string) => letter.repeat(64);

function writeJson(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

function testSourceIdentity() {
	return sourceIdentityFromManifests({
		commit: HASH("a").slice(0, 40),
		dirtyManifest: [],
		effectiveManifest: MANDATORY_SOURCE_ANCHORS.map((path) => ({
			path,
			kind: "text" as const,
			sha256: sha256Bytes(`test source ${path}\n`),
		})),
	});
}

function createCandidate(root: string): {
	runDir: string;
	measurementsDir: string;
	review: string;
	manifest: MeasurementManifest;
} {
	const runDir = join(root, "run");
	const measurementsDir = join(root, "measurements");
	mkdirSync(runDir, { recursive: true });
	const recorded: RecordedChecks = {
		schema: 1,
		scenarioId: "target-right-clip",
		complete: true,
		repetitions: [
			{
				rep: 0,
				checks: [
					{
						id: "beh.remove",
						axis: "behaviour",
						weight: 1,
						ok: true,
						indeterminate: false,
					},
					{
						id: "dsl.remove",
						axis: "dsl",
						weight: 3,
						ok: false,
						indeterminate: false,
					},
				],
			},
		],
	};
	const counts = recomputeMeasurementCounts(recorded);
	const source = testSourceIdentity();
	const fixture = {
		schema: 1,
		kind: "public-synthetic",
		scenarioId: "target-right-clip",
		generator: "workbench/scenarios/target-right-clip.scn.ts",
		documentSha256: HASH("b"),
		telemetrySha256: HASH("c"),
	};
	const report = {
		label: "test-only",
		createdAt: "2026-09-12T00:00:00.000Z",
		fingerprint: {
			systemSha256: HASH("d"),
			systemChars: 1,
			toolsSha256: HASH("e"),
			toolNames: [],
			model: "loopback-model",
			gitSha: "abc1234",
			gitDirty: true,
			effectiveSourceSha256: source.effectiveSha256,
			overlayId: null,
			reps: 1,
		},
		minDetectableEffect: 1,
		scenarios: [
			{
				scenarioId: "target-right-clip",
				title: "test",
				tags: [],
				gate: 0,
				reps: 1,
				behaviour: { ...wilson95(1, 1), rate: counts.axisScores.behaviour },
				dsl: { ...wilson95(0, 1), rate: counts.axisScores.dsl },
				gateScoreMean: 0,
				passRate: wilson95(0, 1),
				failureClasses: { NONE: 1 },
				checks: counts.checks.map((check) => ({
					id: check.id,
					axis: check.axis,
					weight: check.weight,
					passed: check.passed,
					total: check.total,
					indeterminate: check.indeterminate,
					wilson: wilson95(check.passed, check.decided),
					expected: false,
					evidence: [],
				})),
				unmeasuredAxes: [],
				msMean: 1,
			},
		],
		notices: [],
	};
	const files: Array<{ name: string; role: ArtifactReference["role"]; value: unknown }> = [
		{ name: "input-fixture.json", role: "input-fixture", value: fixture },
		{
			name: "main-cassette.json",
			role: "main-cassette",
			value: {
				scenario: "target-right-clip",
				provider: "loopback",
				model: "loopback-model",
				resolvedModel: "loopback-model",
				recordedAt: "2026-09-12",
				rounds: [
					{
						round: 0,
						requestHash: "0123456789abcdef",
						digest: { systemChars: 1, toolCount: 1, roles: ["user"], lastUserText: "test" },
						sse: "data: [DONE]\\n\\n",
					},
				],
			},
		},
		{ name: "recorded-checks.json", role: "recorded-checks", value: recorded },
		{ name: "measurement-report.json", role: "report", value: report },
	];
	const artifacts = files.map(({ name, role, value }) => {
		const file = join(runDir, name);
		writeJson(file, value);
		return { role, path: name, sha256: sha256Bytes(readFileSync(file)) };
	});
	const manifest: MeasurementManifest = {
		schema: 1,
		id: "candidate",
		createdAt: "2026-09-12T00:00:00.000Z",
		complete: true,
		scenario: { id: "target-right-clip", kind: "public-synthetic", judged: false },
		source,
		input: {
			fixtureSha256: artifacts[0].sha256,
			documentSha256: fixture.documentSha256,
			telemetrySha256: fixture.telemetrySha256,
		},
		fingerprints: {
			promptSha256: HASH("1"),
			systemSha256: HASH("d"),
			toolsSha256: HASH("e"),
			wireSha256: HASH("4"),
			rubricSha256: HASH("5"),
		},
		models: {
			agent: { requested: "loopback-model", observed: "loopback-model" },
			judge: { requested: "none", observed: "none" },
		},
		provider: { provider: "loopback", endpointSha256: HASH("6") },
		artifacts,
		results: counts,
		review: { disposition: "unreviewed", reviewerKind: "unknown" },
	};
	writeJson(join(runDir, "measurement-candidate.json"), manifest);
	const review = join(root, "review.json");
	writeJson(review, {
		schema: 1,
		measurementId: "valid-measurement",
		reviewer: { kind: "independent", label: "test fixture reviewer" },
		disposition: "approved",
		reviewedAt: "2026-09-12T00:10:00.000Z",
		summary: "Test-only review fixture for measurement mechanism validation.",
	});
	return { runDir, measurementsDir, review, manifest };
}

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "wb-measurement-"));
	roots.push(value);
	return value;
}

function expectCode(action: () => unknown, code: string): void {
	try {
		action();
		throw new Error("expected measurement error");
	} catch (error) {
		expect(error).toBeInstanceOf(MeasurementError);
		expect((error as MeasurementError).code).toBe(code);
	}
}

function rewriteCandidate(runDir: string, change: (manifest: MeasurementManifest) => void): void {
	const file = join(runDir, "measurement-candidate.json");
	const manifest = JSON.parse(readFileSync(file, "utf8")) as MeasurementManifest;
	change(manifest);
	writeJson(file, manifest);
}

function exportValid(base: ReturnType<typeof createCandidate>): string {
	return exportMeasurement({
		runDir: base.runDir,
		id: "valid-measurement",
		reviewFile: base.review,
		measurementsDir: base.measurementsDir,
	});
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
	for (const value of cliOutputs.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("versioned measurement export and verification", () => {
	it("recomputes the existing weighted axis mean while excluding indeterminate weight", () => {
		const checks = (heavyPasses: boolean) => [
			{
				id: "beh.light",
				axis: "behaviour" as const,
				weight: 1,
				ok: true,
				indeterminate: false,
			},
			{
				id: "beh.heavy",
				axis: "behaviour" as const,
				weight: 3,
				ok: heavyPasses,
				indeterminate: false,
			},
			{
				id: "beh.unread",
				axis: "behaviour" as const,
				weight: 10,
				ok: false,
				indeterminate: true,
			},
			{
				id: "dsl.complete",
				axis: "dsl" as const,
				weight: 2,
				ok: true,
				indeterminate: false,
			},
		];
		const counts = recomputeMeasurementCounts({
			schema: 1,
			scenarioId: "weighted-probe",
			complete: true,
			repetitions: [
				{ rep: 0, checks: checks(false) },
				{ rep: 1, checks: checks(true) },
			],
		});
		// Unweighted behaviour k/n is 3/4 = .75. Existing score semantics are
		// mean((1/4), (4/4)) = .625; the undecided weight 10 is in neither term.
		expect(counts.axes.behaviour).toEqual({
			passed: 3,
			decided: 4,
			indeterminate: 2,
			total: 6,
		});
		expect(counts.axisScores.behaviour).toBe(0.625);
		expect(counts.axisScores.dsl).toBe(1);
	});

	it("accepts the exact finite CLI argument shapes without reading environment configuration", async () => {
		const base = createCandidate(root());
		const id = `test-cli-${randomUUID()}`;
		writeJson(base.review, {
			schema: 1,
			measurementId: id,
			reviewer: { kind: "independent", label: "test fixture reviewer" },
			disposition: "approved",
			reviewedAt: "2026-09-12T00:10:00.000Z",
			summary: "Test-only review fixture for CLI validation.",
		});
		cliOutputs.push(join(process.cwd(), "workbench", "measurements", id));
		const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(
				await runMeasurementCli([
					"export",
					"--run",
					base.runDir,
					"--id",
					id,
					"--review",
					base.review,
				]),
			).toBe(0);
			expect(await runMeasurementCli(["verify", "--id", id])).toBe(0);
			expect(
				await runMeasurementCli([
					"baseline",
					"--id",
					id,
					"--out",
					join(base.runDir, "bound-baseline.json"),
				]),
			).toBe(0);
			expect(await runMeasurementCli(["compare", "--left", id, "--right", id])).toBe(0);
			expect(await runMeasurementCli(["verify", "--left", "wrong"])).toBe(1);
			expect(errors).toHaveBeenCalledWith(expect.stringContaining("ARGUMENT_ERROR"));
			expect(output).toHaveBeenCalled();
		} finally {
			output.mockRestore();
			errors.mockRestore();
		}
	});

	it("atomically adopts an allowlisted candidate and refuses overwrite", () => {
		const base = createCandidate(root());
		const directory = exportValid(base);
		const verified = verifyMeasurementDirectory(directory, { requireApprovedReview: true });
		expect(verified.manifest.id).toBe("valid-measurement");
		expect(verified.manifest.review).toEqual({
			disposition: "approved",
			reviewerKind: "independent",
		});
		expectCode(() => exportValid(base), "DUPLICATE_MEASUREMENT");
	});

	it("rejects an invalid embedded id and a requested-folder id mismatch", () => {
		const invalid = createCandidate(root());
		const invalidDirectory = exportValid(invalid);
		const manifestFile = join(invalidDirectory, "measurement.json");
		const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as MeasurementManifest;
		manifest.id = "../not-portable";
		writeJson(manifestFile, manifest);
		expectCode(() => verifyMeasurementDirectory(invalidDirectory), "MEASUREMENT_ID_INVALID");

		const mismatch = createCandidate(root());
		const adopted = exportValid(mismatch);
		const requestedId = "requested-measurement";
		const renamed = join(mismatch.measurementsDir, requestedId);
		renameSync(adopted, renamed);
		expectCode(
			() => verifyMeasurementId(requestedId, mismatch.measurementsDir),
			"MEASUREMENT_ID_MISMATCH",
		);
	});

	it("rejects missing review, traversal, and unallowlisted roles", () => {
		const missing = createCandidate(root());
		expectCode(
			() =>
				exportMeasurement({
					runDir: missing.runDir,
					id: "valid-measurement",
					reviewFile: join(missing.runDir, "absent.json"),
					measurementsDir: missing.measurementsDir,
				}),
			"REVIEW_MISSING",
		);

		const traversal = createCandidate(root());
		rewriteCandidate(traversal.runDir, (manifest) => {
			manifest.artifacts[0].path = "../outside.json";
		});
		expectCode(() => exportValid(traversal), "ARTIFACT_PATH_INVALID");

		const role = createCandidate(root());
		rewriteCandidate(role.runDir, (manifest) => {
			(manifest.artifacts[0] as { role: string }).role = "raw-config";
		});
		expectCode(() => exportValid(role), "ARTIFACT_ROLE_INVALID");
	});

	it("rejects hash and recomputed count tampering", () => {
		const hash = createCandidate(root());
		writeFileSync(join(hash.runDir, "main-cassette.json"), "tampered\n", "utf8");
		expectCode(() => exportValid(hash), "ARTIFACT_HASH_MISMATCH");

		const counts = createCandidate(root());
		rewriteCandidate(counts.runDir, (manifest) => {
			manifest.results.axes.behaviour.passed = 0;
		});
		expectCode(() => exportValid(counts), "CHECK_COUNT_MISMATCH");
		expect(() =>
			readFileSync(join(counts.measurementsDir, "valid-measurement", "measurement.json")),
		).toThrow();

		const source = createCandidate(root());
		rewriteCandidate(source.runDir, (manifest) => {
			manifest.source.effectiveManifest[0].sha256 = HASH("0");
		});
		expectCode(() => exportValid(source), "MANIFEST_INVALID");

		const legacy = createCandidate(root());
		rewriteCandidate(legacy.runDir, (manifest) => {
			manifest.source = {
				commit: manifest.source.commit,
				contentManifest: manifest.source.dirtyManifest,
				contentSha256: manifest.source.dirtySha256,
			} as unknown as typeof manifest.source;
		});
		expectCode(() => exportValid(legacy), "LEGACY_SOURCE_IDENTITY");
	});

	it("rejects fixture and report identity mismatches even when their artifact hashes are updated", () => {
		const fixture = createCandidate(root());
		const fixtureFile = join(fixture.runDir, "input-fixture.json");
		const fixtureValue = JSON.parse(readFileSync(fixtureFile, "utf8")) as {
			documentSha256: string;
		};
		fixtureValue.documentSha256 = HASH("9");
		writeJson(fixtureFile, fixtureValue);
		rewriteCandidate(fixture.runDir, (manifest) => {
			const ref = manifest.artifacts.find((entry) => entry.path === "input-fixture.json")!;
			ref.sha256 = sha256Bytes(readFileSync(fixtureFile));
			manifest.input.fixtureSha256 = ref.sha256;
		});
		expectCode(() => exportValid(fixture), "MANIFEST_INVALID");

		const report = createCandidate(root());
		const reportFile = join(report.runDir, "measurement-report.json");
		const reportValue = JSON.parse(readFileSync(reportFile, "utf8")) as {
			fingerprint: { model: string };
		};
		reportValue.fingerprint.model = "different-model";
		writeJson(reportFile, reportValue);
		rewriteCandidate(report.runDir, (manifest) => {
			manifest.artifacts.find((entry) => entry.path === "measurement-report.json")!.sha256 =
				sha256Bytes(readFileSync(reportFile));
		});
		expectCode(() => exportValid(report), "INCOMPATIBLE_IDENTITIES");

		const axis = createCandidate(root());
		const axisReportFile = join(axis.runDir, "measurement-report.json");
		const axisReport = JSON.parse(readFileSync(axisReportFile, "utf8")) as {
			scenarios: Array<{ behaviour: { rate: number } }>;
		};
		axisReport.scenarios[0].behaviour.rate = 0.5;
		writeJson(axisReportFile, axisReport);
		rewriteCandidate(axis.runDir, (manifest) => {
			manifest.artifacts.find((entry) => entry.path === "measurement-report.json")!.sha256 =
				sha256Bytes(readFileSync(axisReportFile));
		});
		expectCode(() => exportValid(axis), "AXIS_SCORE_MISMATCH");
	});

	it.each([
		["Authorization: Bearer test-secret-value", "PRIVACY_SECRET"],
		['{"note":"C:\\\\Users\\\\private\\\\fixture.json"}', "PRIVACY_PRIVATE_PATH"],
		['{"transcript":"private words"}', "PRIVACY_TRANSCRIPT"],
		['{"baseUrl":"https://private.invalid/v1"}', "PRIVACY_RAW_CONFIG"],
	])("rejects unsafe exported material (%s)", (payload, code) => {
		const base = createCandidate(root());
		const file = join(base.runDir, "main-cassette.json");
		writeFileSync(file, payload, "utf8");
		rewriteCandidate(base.runDir, (manifest) => {
			manifest.artifacts.find((ref) => ref.path === "main-cassette.json")!.sha256 = sha256Bytes(
				readFileSync(file),
			);
		});
		expectCode(() => exportValid(base), code);
	});

	it("rejects a credential literal supplied by the caller even without a familiar prefix", () => {
		const base = createCandidate(root());
		const file = join(base.runDir, "main-cassette.json");
		const secret = "opaque-credential-literal-459";
		writeFileSync(file, `provider response ${secret}\n`, "utf8");
		rewriteCandidate(base.runDir, (manifest) => {
			manifest.artifacts.find((ref) => ref.path === "main-cassette.json")!.sha256 = sha256Bytes(
				readFileSync(file),
			);
		});
		expectCode(
			() =>
				exportMeasurement({
					runDir: base.runDir,
					id: "valid-measurement",
					reviewFile: base.review,
					measurementsDir: base.measurementsDir,
					knownSecrets: [secret],
				}),
			"PRIVACY_SECRET",
		);
	});

	it("rejects a symlink or junction artifact when the platform can create one", ({ skip }) => {
		const base = createCandidate(root());
		const outsideDirectory = join(dirname(base.runDir), "outside");
		mkdirSync(outsideDirectory);
		const outside = join(outsideDirectory, "outside.json");
		writeFileSync(outside, "{}\n", "utf8");
		const link = join(base.runDir, "linked");
		try {
			symlinkSync(outsideDirectory, link, process.platform === "win32" ? "junction" : "dir");
		} catch {
			skip();
			return;
		}
		rewriteCandidate(base.runDir, (manifest) => {
			manifest.artifacts[0] = {
				role: "input-fixture",
				path: "linked/outside.json",
				sha256: sha256Bytes(readFileSync(outside)),
			};
		});
		expectCode(() => exportValid(base), "SYMLINK_TRAVERSAL");
	});
});

describe("measurement identity and bound baseline", () => {
	it("recomputes weighted axis means while excluding indeterminate weight", () => {
		const counts = recomputeMeasurementCounts({
			schema: 1,
			scenarioId: "weighted-probe",
			complete: true,
			repetitions: [
				{
					rep: 0,
					checks: [
						{ id: "beh.light", axis: "behaviour", weight: 1, ok: true, indeterminate: false },
						{ id: "beh.heavy", axis: "behaviour", weight: 3, ok: false, indeterminate: false },
						{ id: "beh.unknown", axis: "behaviour", weight: 9, ok: false, indeterminate: true },
						{ id: "dsl.pass", axis: "dsl", weight: 2, ok: true, indeterminate: false },
					],
				},
			],
		});
		// Unweighted behaviour is 1/2; the existing weighted metric is 1/(1+3).
		expect(counts.axes.behaviour).toEqual({ passed: 1, decided: 2, indeterminate: 1, total: 3 });
		expect(counts.axisScores).toEqual({ behaviour: 0.25, dsl: 1 });
		expect(counts.checks.find((check) => check.id === "beh.unknown")?.weight).toBe(9);
	});

	it("refuses unknown or incompatible identities and never silently compares them", () => {
		const base = createCandidate(root());
		const left = base.manifest;
		const committed = structuredClone(left);
		committed.source = sourceIdentityFromManifests({
			commit: HASH("b").slice(0, 40),
			dirtyManifest: [left.source.effectiveManifest[0]],
			effectiveManifest: left.source.effectiveManifest,
		});
		expect(() => assertComparable(left, committed)).not.toThrow();
		const unknown = structuredClone(left);
		unknown.models.agent.observed = "unknown";
		expectCode(() => assertComparable(left, unknown), "IDENTITY_UNKNOWN");
		const changed = structuredClone(left);
		changed.input.documentSha256 = HASH("9");
		expectCode(() => assertComparable(left, changed), "INCOMPATIBLE_IDENTITIES");
		const legacy = structuredClone(left) as unknown as {
			source: unknown;
		};
		legacy.source = {
			commit: HASH("a").slice(0, 40),
			contentManifest: [],
			contentSha256: HASH("1"),
		};
		expectCode(
			() => assertComparable(legacy as unknown as typeof left, left),
			"LEGACY_SOURCE_IDENTITY",
		);
	});

	it("binds k/n to approved evidence and rejects a changed baseline summary", () => {
		const directory = exportValid(createCandidate(root()));
		const verified = verifyMeasurementDirectory(directory, { requireApprovedReview: true });
		const baseline = boundBaselineFromMeasurement(verified);
		expect(() => verifyBoundBaseline(baseline, verified)).not.toThrow();
		const changed = structuredClone(baseline);
		changed.counts.axes.dsl.decided += 1;
		expectCode(() => verifyBoundBaseline(changed, verified), "CHECK_COUNT_MISMATCH");
		const changedSource = structuredClone(baseline);
		changedSource.effectiveSourceSha256 = HASH("0");
		expectCode(() => verifyBoundBaseline(changedSource, verified), "SOURCE_IDENTITY_MISMATCH");
		expect(() => assertComparable(baseline.identity, verified.manifest)).not.toThrow();
	});

	it("never turns an explicit rejected review into baseline approval", () => {
		const base = createCandidate(root());
		const receipt = JSON.parse(readFileSync(base.review, "utf8")) as { disposition: string };
		receipt.disposition = "rejected";
		writeJson(base.review, receipt);
		const verified = verifyMeasurementDirectory(exportValid(base));
		expect(verified.review.disposition).toBe("rejected");
		expectCode(() => boundBaselineFromMeasurement(verified), "REVIEW_NOT_APPROVED");
	});
});
