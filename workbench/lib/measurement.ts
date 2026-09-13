import { randomUUID } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { getScenario } from "../scenarios/registry";
import { readCassette, startReplay } from "./cassette";
import { containsSecret } from "./env";
import { offlineStore } from "./harness";
import { askJudge, type JudgeReading } from "./judge";
import {
	canonicalJson,
	captureSourceIdentity,
	type EndpointIdentity,
	endpointIdentity,
	SHA256_PATTERN,
	type SourceIdentity,
	SourceIdentityError,
	sha256Bytes,
	sha256Canonical,
	validateSourceIdentity,
} from "./provenance";
import type { WorkbenchReport } from "./report";
import { type RepetitionResult, runRepetition } from "./runner";
import type { Scenario } from "./scenario";
import { type ScoredRun, scoreRun } from "./score";
import { measurementTransportSha256, type TransportIdentity } from "./transport";

export const MEASUREMENTS_DIR = "workbench/measurements";
export const CANDIDATE_FILE = "measurement-candidate.json";
export const MANIFEST_FILE = "measurement.json";

export type MeasurementErrorCode =
	| "ARGUMENT_ERROR"
	| "ARTIFACT_HASH_MISMATCH"
	| "ARTIFACT_NOT_REGULAR"
	| "ARTIFACT_PATH_INVALID"
	| "ARTIFACT_ROLE_INVALID"
	| "AXIS_SCORE_MISMATCH"
	| "CANDIDATE_INCOMPLETE"
	| "CHECK_COUNT_MISMATCH"
	| "DUPLICATE_MEASUREMENT"
	| "IDENTITY_UNKNOWN"
	| "INCOMPATIBLE_IDENTITIES"
	| "LEGACY_SOURCE_IDENTITY"
	| "MANIFEST_INVALID"
	| "MEASUREMENT_ID_INVALID"
	| "MEASUREMENT_ID_MISMATCH"
	| "MEASUREMENT_NOT_FOUND"
	| "ORIGINAL_FIXTURE_UNAVAILABLE"
	| "PRIVACY_PRIVATE_PATH"
	| "PRIVACY_RAW_CONFIG"
	| "PRIVACY_SECRET"
	| "PRIVACY_TRANSCRIPT"
	| "REPLAY_MISMATCH"
	| "REVIEW_INVALID"
	| "REVIEW_MISSING"
	| "REVIEW_NOT_APPROVED"
	| "SCENARIO_NOT_PUBLIC_SYNTHETIC"
	| "SOURCE_IDENTITY_MISMATCH"
	| "SYMLINK_TRAVERSAL";

export class MeasurementError extends Error {
	constructor(
		readonly code: MeasurementErrorCode,
		message: string,
	) {
		super(message);
		this.name = "MeasurementError";
	}
}

const PUBLIC_SYNTHETIC_SOURCES: Record<string, string> = {
	"camera-with-track": "workbench/scenarios/camera-track.scn.ts",
	"camera-without-track": "workbench/scenarios/camera-track.scn.ts",
	consent: "workbench/scenarios/consent.scn.ts",
	"cursor-blind": "workbench/scenarios/cursor-question.scn.ts",
	"cursor-question": "workbench/scenarios/cursor-question.scn.ts",
	"cut-silences-clean": "workbench/scenarios/cut-silences-clean.scn.ts",
	"describe-project": "workbench/scenarios/describe-project.scn.ts",
	"describe-zooms": "workbench/scenarios/describe-zooms.scn.ts",
	"describe-zooms-migrated": "workbench/scenarios/describe-zooms.scn.ts",
	"no-invented-bounds": "workbench/scenarios/no-invented-bounds.scn.ts",
	"out-of-scope-styling": "workbench/scenarios/out-of-scope-styling.scn.ts",
	"remove-one-modifier": "workbench/scenarios/remove-one-modifier.scn.ts",
	"reorder-clips": "workbench/scenarios/reorder-clips.scn.ts",
	"target-right-clip": "workbench/scenarios/target-right-clip.scn.ts",
	"wizard-enhance": "workbench/scenarios/wizard-enhance.scn.ts",
	"wizard-enhance-bare": "workbench/scenarios/wizard-enhance-bare.scn.ts",
};

export const PUBLIC_SYNTHETIC_SCENARIOS = new Set(Object.keys(PUBLIC_SYNTHETIC_SOURCES));

export type ArtifactRole =
	| "input-fixture"
	| "main-cassette"
	| "judge-cassette"
	| "recorded-checks"
	| "report"
	| "review-receipt";

const ARTIFACT_ROLES = new Set<ArtifactRole>([
	"input-fixture",
	"main-cassette",
	"judge-cassette",
	"recorded-checks",
	"report",
	"review-receipt",
]);

export interface ArtifactReference {
	role: ArtifactRole;
	path: string;
	sha256: string;
}

export interface RecordedCheck {
	id: string;
	axis: "behaviour" | "dsl";
	weight: number;
	ok: boolean;
	indeterminate: boolean;
}

export interface RecordedChecks {
	schema: 1;
	scenarioId: string;
	complete: boolean;
	repetitions: Array<{ rep: number; checks: RecordedCheck[] }>;
}

export interface CheckCounts {
	id: string;
	axis: "behaviour" | "dsl";
	weight: number;
	passed: number;
	decided: number;
	indeterminate: number;
	total: number;
}

export interface AxisCounts {
	passed: number;
	decided: number;
	indeterminate: number;
	total: number;
}

export interface MeasurementCounts {
	repetitions: number;
	axes: { behaviour: AxisCounts; dsl: AxisCounts };
	/** Mean of each repetition's weighted axis score, matching report.ts. */
	axisScores: { behaviour: number; dsl: number };
	checks: CheckCounts[];
}

export interface MeasurementIdentity {
	scenario: { id: string; kind: "public-synthetic" | "original-real"; judged: boolean };
	source: SourceIdentity;
	input: {
		fixtureSha256: string;
		documentSha256: string;
		telemetrySha256: string;
	};
	fingerprints: {
		promptSha256: string;
		systemSha256: string;
		toolsSha256: string;
		wireSha256: string;
		rubricSha256: string;
		/** Missing on historical manifests; treated as legacy/unknown. */
		transportSha256?: string;
	};
	models: {
		agent: { requested: string; observed: string };
		judge: { requested: string; observed: string };
	};
	provider: EndpointIdentity;
}

export interface ReviewReceipt {
	schema: 1;
	measurementId: string;
	reviewer: { kind: "human" | "independent"; label: string };
	disposition: "approved" | "rejected";
	reviewedAt: string;
	summary: string;
}

export interface MeasurementManifest extends MeasurementIdentity {
	schema: 1;
	id: string;
	createdAt: string;
	complete: boolean;
	artifacts: ArtifactReference[];
	results: MeasurementCounts;
	review: {
		disposition: ReviewReceipt["disposition"] | "unreviewed";
		reviewerKind: ReviewReceipt["reviewer"]["kind"] | "unknown";
	};
	usage?: {
		agent: ObservedUsageSummary;
		judge: ObservedUsageSummary | { status: "none" | "pending" };
	};
}

export interface ObservedUsageSummary {
	status: "complete" | "incomplete";
	attempts: number;
	rounds: number;
	withUsage: number;
	missingUsageRounds: number[];
	totals: Record<string, number>;
}

export interface PublicSyntheticFixture {
	schema: 1;
	kind: "public-synthetic";
	scenarioId: string;
	generator: string;
	documentSha256: string;
	telemetrySha256: string;
}

function fail(code: MeasurementErrorCode, message: string): never {
	throw new MeasurementError(code, message);
}

function requireSourceSchema(source: unknown): SourceIdentity {
	try {
		return validateSourceIdentity(source);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(
			error instanceof SourceIdentityError && message.includes("legacy dirty-only")
				? "LEGACY_SOURCE_IDENTITY"
				: "IDENTITY_UNKNOWN",
			message,
		);
	}
}

/** The exact source half of the replay gate; HEAD and dirty state are provenance only. */
export function assertReplaySourceCompatible(recorded: unknown, current: unknown): void {
	const recordedSource = requireSourceSchema(recorded);
	const currentSource = requireSourceSchema(current);
	if (recordedSource.effectiveSha256 !== currentSource.effectiveSha256) {
		fail("SOURCE_IDENTITY_MISMATCH", "effective source content differs from the measurement");
	}
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		fail("MANIFEST_INVALID", `${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function writeJson(file: string, value: unknown): void {
	const payload = `${JSON.stringify(value, null, "\t")}\n`;
	if (containsSecret(payload)) fail("PRIVACY_SECRET", `${file}: payload contains a credential`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, payload, "utf8");
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0)
		fail("MANIFEST_INVALID", `${label} is required`);
}

function assertSha(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		fail("MANIFEST_INVALID", `${label} must be a lowercase SHA256`);
	}
}

function validateMeasurementId(
	id: string,
	code: "ARGUMENT_ERROR" | "MEASUREMENT_ID_INVALID" = "ARGUMENT_ERROR",
): void {
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
		fail(code, "measurement id must be 1-64 lowercase letters, digits, dot, dash, or underscore");
	}
}

function validateRelativePath(path: unknown): asserts path is string {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path !== posix.normalize(path) ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		fail(
			"ARTIFACT_PATH_INVALID",
			`artifact path must be relative POSIX without dot segments: ${path}`,
		);
	}
}

function lowerPath(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function isWithin(root: string, candidate: string): boolean {
	const rootValue = lowerPath(resolve(root));
	const candidateValue = lowerPath(resolve(candidate));
	return candidateValue === rootValue || candidateValue.startsWith(`${rootValue}${sep}`);
}

function resolveArtifact(root: string, path: string): string {
	validateRelativePath(path);
	if (lstatSync(resolve(root)).isSymbolicLink()) {
		fail("SYMLINK_TRAVERSAL", "measurement package root is a symlink or junction");
	}
	const absolute = resolve(root, ...path.split("/"));
	if (!isWithin(root, absolute)) fail("ARTIFACT_PATH_INVALID", `${path} escapes its package`);
	let cursor = resolve(root);
	for (const segment of path.split("/")) {
		cursor = resolve(cursor, segment);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(cursor);
		} catch {
			fail("ARTIFACT_NOT_REGULAR", `${path} does not exist`);
		}
		if (stat.isSymbolicLink()) fail("SYMLINK_TRAVERSAL", `${path} traverses a symlink or junction`);
	}
	const stat = lstatSync(absolute);
	if (!stat.isFile()) fail("ARTIFACT_NOT_REGULAR", `${path} is not a regular file`);
	const realRoot = realpathSync(root);
	const realFile = realpathSync(absolute);
	if (!isWithin(realRoot, realFile))
		fail("SYMLINK_TRAVERSAL", `${path} resolves outside its package`);
	return absolute;
}

function hashFile(file: string): string {
	return sha256Bytes(readFileSync(file));
}

function assertArtifact(root: string, ref: ArtifactReference): string {
	if (!ref || typeof ref !== "object")
		fail("MANIFEST_INVALID", "artifact reference must be an object");
	if (!ARTIFACT_ROLES.has(ref.role))
		fail("ARTIFACT_ROLE_INVALID", `unallowlisted role: ${ref.role}`);
	validateRelativePath(ref.path);
	assertSha(ref.sha256, `${ref.path}.sha256`);
	const file = resolveArtifact(root, ref.path);
	const actual = hashFile(file);
	if (actual !== ref.sha256) {
		fail("ARTIFACT_HASH_MISMATCH", `${ref.path}: expected ${ref.sha256}, got ${actual}`);
	}
	return file;
}

function privacyFailure(payload: string, knownSecrets: string[]): MeasurementError | null {
	for (const secret of knownSecrets) {
		if (secret.length >= 8 && payload.includes(secret)) {
			return new MeasurementError(
				"PRIVACY_SECRET",
				"artifact contains a caller-supplied credential",
			);
		}
	}
	if (
		containsSecret(payload) ||
		/\b(?:authorization\s*:\s*bearer|api[_-]?key\s*[:=]|x-api-key\s*[:=])\s*\S+/i.test(payload) ||
		/"(?:apiKey|authorization)"\s*:/i.test(payload)
	) {
		return new MeasurementError(
			"PRIVACY_SECRET",
			"artifact contains a credential or authorization field",
		);
	}
	if (/"(?:baseUrl|rawEndpoint|endpoint|configuration)"\s*:/i.test(payload)) {
		return new MeasurementError(
			"PRIVACY_RAW_CONFIG",
			"artifact contains a raw endpoint or configuration field",
		);
	}
	const pathPayload = payload.replace(/\\\\/g, "\\");
	const privatePath = pathPayload.match(
		/(?:[A-Za-z]:\\|\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9$._-]+|\/(?:Users|home|tmp|opt|srv|mnt|Volumes|root|data|private\/var|var\/(?:folders|lib|tmp))\/)/i,
	);
	if (privatePath) {
		return new MeasurementError(
			"PRIVACY_PRIVATE_PATH",
			`artifact contains an OS absolute private path (${privatePath[0]})`,
		);
	}
	if (/"(?:transcripts?|documents?|rawDocument)"\s*:/i.test(payload)) {
		return new MeasurementError(
			"PRIVACY_TRANSCRIPT",
			"artifact contains a forbidden transcript/document field",
		);
	}
	return null;
}

export function assertPublicArtifact(file: string, knownSecrets: string[] = []): void {
	const payload = readFileSync(file, "utf8");
	const issue = privacyFailure(payload, knownSecrets);
	if (issue) throw new MeasurementError(issue.code, `${file}: ${issue.message}`);
}

function artifactRef(root: string, file: string, role: ArtifactRole): ArtifactReference {
	const path = relative(root, file).replace(/\\/g, "/");
	validateRelativePath(path);
	return { role, path, sha256: hashFile(file) };
}

export function recordedChecksFromScored(
	scenarioId: string,
	entries: Array<{ rep: number; scored: ScoredRun }>,
	complete: boolean,
): RecordedChecks {
	return {
		schema: 1,
		scenarioId,
		complete,
		repetitions: entries.map(({ rep, scored }) => ({
			rep,
			checks: [
				...scored.behaviour.results.map((check) => ({
					id: check.id,
					axis: "behaviour" as const,
					weight: check.weight,
					ok: check.ok,
					indeterminate: check.indeterminate,
				})),
				...scored.dsl.results.map((check) => ({
					id: check.id,
					axis: "dsl" as const,
					weight: check.weight,
					ok: check.ok,
					indeterminate: check.indeterminate,
				})),
			],
		})),
	};
}

export function recomputeMeasurementCounts(recorded: RecordedChecks): MeasurementCounts {
	if (
		recorded.schema !== 1 ||
		!recorded.scenarioId ||
		!Array.isArray(recorded.repetitions) ||
		recorded.repetitions.length === 0
	) {
		fail("MANIFEST_INVALID", "recorded checks are empty or malformed");
	}
	const reps = new Set<number>();
	const byCheck = new Map<string, CheckCounts>();
	let roster: string[] | null = null;
	for (const repetition of recorded.repetitions) {
		if (
			!Number.isInteger(repetition.rep) ||
			reps.has(repetition.rep) ||
			!Array.isArray(repetition.checks)
		) {
			fail("CHECK_COUNT_MISMATCH", `duplicate or invalid repetition ${repetition.rep}`);
		}
		for (const check of repetition.checks) {
			if (
				typeof check.id !== "string" ||
				check.id.length === 0 ||
				(check.axis !== "behaviour" && check.axis !== "dsl") ||
				typeof check.weight !== "number" ||
				!Number.isFinite(check.weight) ||
				check.weight <= 0 ||
				typeof check.ok !== "boolean" ||
				typeof check.indeterminate !== "boolean"
			) {
				fail("CHECK_COUNT_MISMATCH", `repetition ${repetition.rep} has a malformed check`);
			}
		}
		reps.add(repetition.rep);
		const keys = repetition.checks
			.map((check) => `${check.axis}:${check.id}:${check.weight}`)
			.sort();
		if (new Set(keys).size !== keys.length) {
			fail("CHECK_COUNT_MISMATCH", `repetition ${repetition.rep} has duplicate checks`);
		}
		if (roster === null) roster = keys;
		else if (canonicalJson(roster) !== canonicalJson(keys)) {
			fail("CHECK_COUNT_MISMATCH", `repetition ${repetition.rep} changed the check denominator`);
		}
		for (const check of repetition.checks) {
			if (check.indeterminate && check.ok) {
				fail("CHECK_COUNT_MISMATCH", `${check.id} is both passing and indeterminate`);
			}
			const key = `${check.axis}:${check.id}`;
			const entry = byCheck.get(key) ?? {
				id: check.id,
				axis: check.axis,
				weight: check.weight,
				passed: 0,
				decided: 0,
				indeterminate: 0,
				total: 0,
			};
			entry.total += 1;
			if (check.indeterminate) entry.indeterminate += 1;
			else {
				entry.decided += 1;
				if (check.ok) entry.passed += 1;
			}
			byCheck.set(key, entry);
		}
	}
	const checks = [...byCheck.values()].sort((left, right) =>
		`${left.axis}:${left.id}`.localeCompare(`${right.axis}:${right.id}`),
	);
	const axis = (name: "behaviour" | "dsl"): AxisCounts =>
		checks
			.filter((check) => check.axis === name)
			.reduce(
				(sum, check) => ({
					passed: sum.passed + check.passed,
					decided: sum.decided + check.decided,
					indeterminate: sum.indeterminate + check.indeterminate,
					total: sum.total + check.total,
				}),
				{ passed: 0, decided: 0, indeterminate: 0, total: 0 },
			);
	const scoreFor = (
		repetition: RecordedChecks["repetitions"][number],
		name: "behaviour" | "dsl",
	): number => {
		const checks = repetition.checks.filter((check) => check.axis === name);
		const decidedWeight = checks.reduce(
			(sum, check) => sum + (check.indeterminate ? 0 : check.weight),
			0,
		);
		if (decidedWeight === 0) return 1;
		const passedWeight = checks.reduce((sum, check) => sum + (check.ok ? check.weight : 0), 0);
		return passedWeight / decidedWeight;
	};
	const meanScore = (name: "behaviour" | "dsl"): number =>
		recorded.repetitions.reduce((sum, repetition) => sum + scoreFor(repetition, name), 0) /
		recorded.repetitions.length;
	return {
		repetitions: recorded.repetitions.length,
		axes: { behaviour: axis("behaviour"), dsl: axis("dsl") },
		axisScores: { behaviour: meanScore("behaviour"), dsl: meanScore("dsl") },
		checks,
	};
}

/** One independent trial per repetition, weighted the same way as `axisScores`. */
export function weightedAxisTrials(
	results: Pick<MeasurementCounts, "repetitions" | "axisScores">,
	axis: "behaviour" | "dsl",
): { k: number; n: number } {
	const n = results.repetitions;
	return { k: Math.round(results.axisScores[axis] * n), n };
}

function scenarioRubricSha256(scenario: Scenario): string {
	return sha256Canonical({
		behaviour: scenario.behaviour.map((check) => ({
			id: check.id,
			weight: check.weight,
		})),
		judged: (scenario.judged ?? []).map((check) => ({
			id: check.id,
			weight: check.weight,
			rubric: check.rubric,
		})),
		dsl: scenario.dsl.map((check) => ({
			id: check.id,
			weight: check.weight,
		})),
	});
}

function publicFixtureFor(scenario: Scenario): PublicSyntheticFixture {
	if (!PUBLIC_SYNTHETIC_SCENARIOS.has(scenario.id)) {
		fail(
			scenario.id.startsWith("real-")
				? "ORIGINAL_FIXTURE_UNAVAILABLE"
				: "SCENARIO_NOT_PUBLIC_SYNTHETIC",
			`${scenario.id}: only registered public synthetic scenarios may be exported`,
		);
	}
	const documentSha256 = sha256Canonical(scenario.document());
	const telemetrySha256 = sha256Canonical(scenario.cursorTelemetry?.() ?? null);
	return {
		schema: 1,
		kind: "public-synthetic",
		scenarioId: scenario.id,
		generator: PUBLIC_SYNTHETIC_SOURCES[scenario.id],
		documentSha256,
		telemetrySha256,
	};
}

function unknown(value: string | null | undefined): string {
	return value && value.trim().length > 0 ? value : "unknown";
}

function wireIdentity(results: RepetitionResult[]): MeasurementIdentity["fingerprints"] {
	const first = results[0]?.run.wire;
	return {
		promptSha256: "unknown",
		systemSha256: unknown(first?.systemSha256),
		toolsSha256: unknown(first?.toolsSha256),
		wireSha256: sha256Canonical(
			results.map((result) => ({
				systemSha256: result.run.wire.systemSha256,
				toolsSha256: result.run.wire.toolsSha256,
				toolNames: result.run.wire.toolNames,
			})),
		),
		rubricSha256: "unknown",
	};
}

function cassetteTransportProfiles(files: string[]): TransportIdentity[] | null {
	const profiles = files.map((file) => readCassette(file).transport);
	if (profiles.every((profile) => profile === undefined)) return null;
	if (profiles.some((profile) => profile === undefined)) {
		fail("INCOMPATIBLE_IDENTITIES", "measurement mixes legacy and transport-bound cassettes");
	}
	return profiles as TransportIdentity[];
}

function observedUsage(files: string[]): ObservedUsageSummary {
	const totals: Record<string, number> = {};
	const missingUsageRounds: number[] = [];
	let attempts = 0;
	let rounds = 0;
	let withUsage = 0;
	for (const file of files) {
		const cassette = readCassette(file);
		attempts += cassette.attempts?.length ?? cassette.rounds.length;
		for (const round of cassette.rounds) {
			const index = rounds++;
			if (!round.usage) {
				missingUsageRounds.push(index);
				continue;
			}
			withUsage += 1;
			for (const [name, value] of Object.entries(round.usage)) {
				if (typeof value === "number" && Number.isFinite(value)) {
					totals[name] = (totals[name] ?? 0) + value;
				}
			}
		}
	}
	return {
		status: missingUsageRounds.length === 0 && attempts === rounds ? "complete" : "incomplete",
		attempts,
		rounds,
		withUsage,
		missingUsageRounds,
		totals,
	};
}

export interface PrepareMeasurementCandidateOptions {
	runDir: string;
	scenario: Scenario;
	results: RepetitionResult[];
	cassetteFiles: string[];
	report: WorkbenchReport;
	requestedModel: string;
	observedModel?: string | null;
	provider: string;
	endpoint: string;
	source?: SourceIdentity;
	now?: Date;
}

/** Called by the real recording CLI; its run directory is the export input. */
export function prepareMeasurementCandidate(options: PrepareMeasurementCandidateOptions): {
	file: string;
	manifest: MeasurementManifest;
} {
	if (options.results.length === 0 || options.cassetteFiles.length !== options.results.length) {
		fail("CANDIDATE_INCOMPLETE", "a candidate needs one recorded cassette per repetition");
	}
	const runDir = resolve(options.runDir);
	mkdirSync(runDir, { recursive: true });
	const fixture = publicFixtureFor(options.scenario);
	const fixtureFile = resolve(runDir, "input-fixture.json");
	const checksFile = resolve(runDir, "recorded-checks.json");
	const reportFile = resolve(runDir, "measurement-report.json");
	writeJson(fixtureFile, fixture);
	const complete = (options.scenario.judged ?? []).length === 0;
	const recorded = recordedChecksFromScored(
		options.scenario.id,
		options.results.map((result) => ({ rep: result.rep, scored: result.scored })),
		complete,
	);
	writeJson(checksFile, recorded);
	writeJson(reportFile, options.report);
	const cassetteRefs = options.cassetteFiles.map((file) => {
		const absolute = resolve(file);
		if (!isWithin(runDir, absolute)) {
			fail("ARTIFACT_PATH_INVALID", `cassette must be recorded inside ${runDir}: ${file}`);
		}
		return artifactRef(runDir, absolute, "main-cassette");
	});
	const fingerprints = wireIdentity(options.results);
	fingerprints.promptSha256 = sha256Bytes(options.scenario.prompt.replace(/\r\n?/g, "\n"));
	fingerprints.rubricSha256 = scenarioRubricSha256(options.scenario);
	const agentTransports = cassetteTransportProfiles(options.cassetteFiles);
	if (agentTransports) {
		fingerprints.transportSha256 = measurementTransportSha256(agentTransports, "no-judge");
	}
	const manifest: MeasurementManifest = {
		schema: 1,
		id: "candidate",
		createdAt: (options.now ?? new Date()).toISOString(),
		complete,
		scenario: {
			id: options.scenario.id,
			kind: "public-synthetic",
			judged: (options.scenario.judged ?? []).length > 0,
		},
		source: options.source ?? captureSourceIdentity(),
		input: {
			fixtureSha256: hashFile(fixtureFile),
			documentSha256: fixture.documentSha256,
			telemetrySha256: fixture.telemetrySha256,
		},
		fingerprints,
		models: {
			agent: {
				requested: unknown(options.requestedModel),
				observed: unknown(options.observedModel),
			},
			judge: complete
				? { requested: "none", observed: "none" }
				: { requested: "unknown", observed: "unknown" },
		},
		provider: endpointIdentity(options.provider, options.endpoint),
		artifacts: [
			artifactRef(runDir, fixtureFile, "input-fixture"),
			...cassetteRefs,
			artifactRef(runDir, checksFile, "recorded-checks"),
			artifactRef(runDir, reportFile, "report"),
		],
		results: recomputeMeasurementCounts(recorded),
		review: { disposition: "unreviewed", reviewerKind: "unknown" },
		usage: {
			agent: observedUsage(options.cassetteFiles),
			judge: complete ? { status: "none" } : { status: "pending" },
		},
	};
	const file = resolve(runDir, CANDIDATE_FILE);
	writeJson(file, manifest);
	return { file, manifest };
}

export function finalizeJudgedMeasurementCandidate(options: {
	runDir: string;
	scenario: Scenario;
	scored: Array<{ rep: number; scored: ScoredRun }>;
	judgeCassetteFile: string;
	report: WorkbenchReport;
	requestedJudgeModel: string;
	observedJudgeModel?: string | null;
	provider: string;
	endpoint: string;
}): { file: string; manifest: MeasurementManifest } {
	const runDir = resolve(options.runDir);
	const file = resolve(runDir, CANDIDATE_FILE);
	const candidate = assertManifestShape(readJson(file));
	if (candidate.scenario.id !== options.scenario.id || !candidate.scenario.judged) {
		fail("MANIFEST_INVALID", "judge result does not match a judged measurement candidate");
	}
	const currentSource = captureSourceIdentity();
	assertReplaySourceCompatible(candidate.source, currentSource);
	if (
		canonicalJson(candidate.provider) !==
		canonicalJson(endpointIdentity(options.provider, options.endpoint))
	) {
		fail("INCOMPATIBLE_IDENTITIES", "judge provider/endpoint differs from the agent measurement");
	}
	if (!isWithin(runDir, resolve(options.judgeCassetteFile))) {
		fail(
			"ARTIFACT_PATH_INVALID",
			"judge cassette must be recorded inside the candidate run directory",
		);
	}
	const recorded = recordedChecksFromScored(options.scenario.id, options.scored, true);
	const checksFile = resolve(runDir, "recorded-checks.json");
	const reportFile = resolve(runDir, "measurement-report.json");
	writeJson(checksFile, recorded);
	writeJson(reportFile, options.report);
	const preserved = candidate.artifacts.filter(
		(ref) =>
			ref.role !== "recorded-checks" && ref.role !== "report" && ref.role !== "judge-cassette",
	);
	const agentCassetteFiles = candidate.artifacts
		.filter((ref) => ref.role === "main-cassette")
		.map((ref) => resolveArtifact(runDir, ref.path));
	const agentTransports = cassetteTransportProfiles(agentCassetteFiles);
	const judgeTransport = readCassette(resolve(options.judgeCassetteFile)).transport;
	if ((agentTransports === null) !== (judgeTransport === undefined)) {
		fail("INCOMPATIBLE_IDENTITIES", "agent and judge transport identity generations differ");
	}
	const manifest: MeasurementManifest = {
		...candidate,
		complete: true,
		fingerprints: {
			...candidate.fingerprints,
			...(agentTransports && judgeTransport
				? { transportSha256: measurementTransportSha256(agentTransports, judgeTransport) }
				: {}),
		},
		models: {
			...candidate.models,
			judge: {
				requested: unknown(options.requestedJudgeModel),
				observed: unknown(options.observedJudgeModel),
			},
		},
		artifacts: [
			...preserved,
			artifactRef(runDir, resolve(options.judgeCassetteFile), "judge-cassette"),
			artifactRef(runDir, checksFile, "recorded-checks"),
			artifactRef(runDir, reportFile, "report"),
		],
		results: recomputeMeasurementCounts(recorded),
		usage: {
			agent: candidate.usage?.agent ?? observedUsage(agentCassetteFiles),
			judge: observedUsage([resolve(options.judgeCassetteFile)]),
		},
	};
	writeJson(file, manifest);
	return { file, manifest };
}

function validateReview(value: unknown, id: string): ReviewReceipt {
	const receipt = value as Partial<ReviewReceipt>;
	const keys = value !== null && typeof value === "object" ? Object.keys(value).sort() : [];
	const reviewerKeys =
		receipt.reviewer !== null && typeof receipt.reviewer === "object"
			? Object.keys(receipt.reviewer).sort()
			: [];
	if (
		canonicalJson(keys) !==
			canonicalJson(
				["disposition", "measurementId", "reviewedAt", "reviewer", "schema", "summary"].sort(),
			) ||
		canonicalJson(reviewerKeys) !== canonicalJson(["kind", "label"].sort()) ||
		receipt.schema !== 1 ||
		receipt.measurementId !== id ||
		(receipt.reviewer?.kind !== "human" && receipt.reviewer?.kind !== "independent") ||
		typeof receipt.reviewer?.label !== "string" ||
		receipt.reviewer.label.trim().length === 0 ||
		(receipt.disposition !== "approved" && receipt.disposition !== "rejected") ||
		typeof receipt.reviewedAt !== "string" ||
		Number.isNaN(Date.parse(receipt.reviewedAt)) ||
		typeof receipt.summary !== "string" ||
		receipt.summary.trim().length === 0
	) {
		fail(
			"REVIEW_INVALID",
			"review receipt must identify the measurement, reviewer, disposition, time, and summary",
		);
	}
	return receipt as ReviewReceipt;
}

function assertManifestShape(value: unknown): MeasurementManifest {
	const manifest = value as Partial<MeasurementManifest>;
	if (
		manifest.schema !== 1 ||
		typeof manifest.id !== "string" ||
		typeof manifest.createdAt !== "string" ||
		typeof manifest.complete !== "boolean" ||
		!manifest.scenario ||
		!manifest.source ||
		!manifest.input ||
		!manifest.fingerprints ||
		!manifest.models ||
		!manifest.provider ||
		!Array.isArray(manifest.artifacts) ||
		!manifest.results ||
		!manifest.review
	) {
		fail("MANIFEST_INVALID", "measurement manifest is missing required version 1 fields");
	}
	validateMeasurementId(manifest.id, "MEASUREMENT_ID_INVALID");
	assertString(manifest.scenario.id, "scenario.id");
	if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.scenario.id)) {
		fail("MANIFEST_INVALID", "scenario.id must be kebab-case");
	}
	if (manifest.scenario.kind !== "public-synthetic" && manifest.scenario.kind !== "original-real") {
		fail("MANIFEST_INVALID", "scenario.kind is invalid");
	}
	if (typeof manifest.scenario.judged !== "boolean") {
		fail("MANIFEST_INVALID", "scenario.judged must be boolean");
	}
	try {
		validateSourceIdentity(manifest.source);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(
			error instanceof SourceIdentityError && message.includes("legacy dirty-only")
				? "LEGACY_SOURCE_IDENTITY"
				: "MANIFEST_INVALID",
			message,
		);
	}
	for (const [key, value] of Object.entries(manifest.input)) assertSha(value, `input.${key}`);
	for (const [key, value] of Object.entries(manifest.fingerprints)) {
		if (value !== "unknown") assertSha(value, `fingerprints.${key}`);
	}
	assertString(manifest.models.agent.requested, "models.agent.requested");
	assertString(manifest.models.agent.observed, "models.agent.observed");
	assertString(manifest.models.judge.requested, "models.judge.requested");
	assertString(manifest.models.judge.observed, "models.judge.observed");
	assertString(manifest.provider.provider, "provider.provider");
	assertSha(manifest.provider.endpointSha256, "provider.endpointSha256");
	return manifest as MeasurementManifest;
}

function roleRefs(manifest: MeasurementManifest, role: ArtifactRole): ArtifactReference[] {
	return manifest.artifacts.filter((ref) => ref.role === role);
}

function assertRequiredRoles(manifest: MeasurementManifest): void {
	for (const ref of manifest.artifacts) {
		if (!ARTIFACT_ROLES.has(ref.role))
			fail("ARTIFACT_ROLE_INVALID", `unallowlisted role: ${ref.role}`);
	}
	for (const role of ["input-fixture", "main-cassette", "recorded-checks", "report"] as const) {
		if (roleRefs(manifest, role).length === 0)
			fail("CANDIDATE_INCOMPLETE", `missing ${role} artifact`);
	}
	const judgeCassettes = roleRefs(manifest, "judge-cassette");
	if (judgeCassettes.length > 1) {
		fail("CANDIDATE_INCOMPLETE", "measurement must reference at most one judge cassette");
	}
	if (manifest.scenario.judged) {
		if (manifest.complete && judgeCassettes.length === 0) {
			fail("CANDIDATE_INCOMPLETE", "judged measurement is missing its judge cassette");
		}
	} else if (judgeCassettes.length !== 0) {
		fail("CANDIDATE_INCOMPLETE", "unjudged measurement must not include a judge cassette");
	}
}

function assertCountsAgainstReport(manifest: MeasurementManifest, report: WorkbenchReport): void {
	const scenario = report.scenarios.find((entry) => entry.scenarioId === manifest.scenario.id);
	if (!scenario) fail("CHECK_COUNT_MISMATCH", "report does not contain the measured scenario");
	const infrastructureFailures =
		(scenario.failureClasses.TRANSPORT ?? 0) + (scenario.failureClasses.TIMEOUT ?? 0);
	if (infrastructureFailures > 0) {
		fail(
			"CANDIDATE_INCOMPLETE",
			"measurement contains infrastructure failure classes and cannot be adopted",
		);
	}
	if (
		report.scenarios.length !== 1 ||
		scenario.reps !== manifest.results.repetitions ||
		scenario.checks.length !== manifest.results.checks.length
	) {
		fail("CHECK_COUNT_MISMATCH", "report scenario/check denominators do not match the measurement");
	}
	const reportModel = manifest.scenario.judged
		? manifest.models.judge.requested
		: manifest.models.agent.requested;
	if (
		report.fingerprint.systemSha256 !== manifest.fingerprints.systemSha256 ||
		report.fingerprint.toolsSha256 !== manifest.fingerprints.toolsSha256 ||
		report.fingerprint.model !== reportModel ||
		report.fingerprint.reps !== manifest.results.repetitions ||
		report.fingerprint.effectiveSourceSha256 !== manifest.source.effectiveSha256
	) {
		fail("INCOMPATIBLE_IDENTITIES", "report fingerprint does not match the measurement identity");
	}
	for (const count of manifest.results.checks) {
		const reported = scenario.checks.find(
			(entry) => entry.id === count.id && entry.axis === count.axis,
		);
		if (
			!reported ||
			reported.weight !== count.weight ||
			reported.passed !== count.passed ||
			reported.total !== count.total ||
			reported.indeterminate !== count.indeterminate
		) {
			fail("CHECK_COUNT_MISMATCH", `report summary changed ${count.axis}/${count.id}`);
		}
	}
	if (
		Math.abs(scenario.behaviour.rate - manifest.results.axisScores.behaviour) > 1e-12 ||
		Math.abs(scenario.dsl.rate - manifest.results.axisScores.dsl) > 1e-12
	) {
		fail("AXIS_SCORE_MISMATCH", "report weighted behaviour/DSL scores changed");
	}
}

function assertCassettes(manifest: MeasurementManifest, root: string): void {
	const assertOne = (ref: ArtifactReference, judged: boolean): void => {
		let cassette: ReturnType<typeof readCassette>;
		try {
			cassette = readCassette(resolveArtifact(root, ref.path));
		} catch (error) {
			fail("MANIFEST_INVALID", `${ref.path} is not a readable cassette: ${String(error)}`);
		}
		const expectedScenario = judged ? `judge-${manifest.scenario.id}` : manifest.scenario.id;
		const expectedModel = judged
			? manifest.models.judge.requested
			: manifest.models.agent.requested;
		const observedModel = judged ? manifest.models.judge.observed : manifest.models.agent.observed;
		if (
			cassette.scenario !== expectedScenario ||
			cassette.provider !== manifest.provider.provider ||
			cassette.model !== expectedModel ||
			!Array.isArray(cassette.rounds) ||
			cassette.rounds.length === 0
		) {
			fail("MANIFEST_INVALID", `${ref.path} cassette identity is inconsistent with the manifest`);
		}
		if (observedModel !== "unknown" && cassette.resolvedModel !== observedModel) {
			fail("MANIFEST_INVALID", `${ref.path} observed model is inconsistent with the manifest`);
		}
		if (
			cassette.rounds.some((round) => {
				if (cassette.wireApi === "responses") {
					return (
						round.terminalStatus !== "completed" ||
						!round.response ||
						round.response.status < 200 ||
						round.response.status >= 300
					);
				}
				return (
					typeof round.httpStatus === "number" &&
					(round.httpStatus < 200 || round.httpStatus >= 300)
				);
			})
		) {
			fail(
				"CANDIDATE_INCOMPLETE",
				`${ref.path} contains a failed ${cassette.wireApi === "responses" ? "Responses" : "Chat"} round`,
			);
		}
		if (
			cassette.wireApi === "responses" &&
			(!cassette.attempts ||
				cassette.attempts.length !== cassette.rounds.length ||
				cassette.attempts.some((attempt) => attempt.status !== "recorded"))
		) {
			fail(
				"CANDIDATE_INCOMPLETE",
				`${ref.path} contains an unmatched rejected or failed Responses attempt`,
			);
		}
	};
	for (const ref of roleRefs(manifest, "main-cassette")) assertOne(ref, false);
	for (const ref of roleRefs(manifest, "judge-cassette")) assertOne(ref, true);
}

function assertTransportFingerprint(manifest: MeasurementManifest, root: string): void {
	const agentFiles = roleRefs(manifest, "main-cassette").map((ref) =>
		resolveArtifact(root, ref.path),
	);
	const agent = cassetteTransportProfiles(agentFiles);
	const judgeRef = roleRefs(manifest, "judge-cassette")[0];
	const judge = judgeRef ? readCassette(resolveArtifact(root, judgeRef.path)).transport : undefined;
	if (agent === null && judge === undefined) {
		if (manifest.fingerprints.transportSha256 !== undefined) {
			fail("INCOMPATIBLE_IDENTITIES", "legacy cassettes cannot claim a transport fingerprint");
		}
		return;
	}
	if (agent === null || (judgeRef && judge === undefined)) {
		fail("INCOMPATIBLE_IDENTITIES", "measurement mixes legacy and transport-bound cassettes");
	}
	const expected = measurementTransportSha256(agent, judge ?? "no-judge");
	if (manifest.fingerprints.transportSha256 !== expected) {
		fail("INCOMPATIBLE_IDENTITIES", "measurement transport fingerprint does not match cassettes");
	}
}

function assertObservedUsage(manifest: MeasurementManifest, root: string): void {
	if (!manifest.usage) return;
	const agent = observedUsage(
		roleRefs(manifest, "main-cassette").map((ref) => resolveArtifact(root, ref.path)),
	);
	if (canonicalJson(agent) !== canonicalJson(manifest.usage.agent)) {
		fail("MANIFEST_INVALID", "agent observed usage summary does not match cassettes");
	}
	const judgeRefs = roleRefs(manifest, "judge-cassette");
	const judge =
		judgeRefs.length === 0
			? manifest.complete
				? { status: "none" as const }
				: { status: "pending" as const }
			: observedUsage(judgeRefs.map((ref) => resolveArtifact(root, ref.path)));
	if (canonicalJson(judge) !== canonicalJson(manifest.usage.judge)) {
		fail("MANIFEST_INVALID", "judge observed usage summary does not match cassettes");
	}
}

function assertFixture(manifest: MeasurementManifest, root: string): void {
	const refs = roleRefs(manifest, "input-fixture");
	if (refs.length !== 1) fail("CANDIDATE_INCOMPLETE", "exactly one input fixture is required");
	const fixture = readJson(resolveArtifact(root, refs[0].path)) as Partial<PublicSyntheticFixture>;
	const keys = Object.keys(fixture).sort();
	const expectedKeys = [
		"documentSha256",
		"generator",
		"kind",
		"scenarioId",
		"schema",
		"telemetrySha256",
	].sort();
	if (canonicalJson(keys) !== canonicalJson(expectedKeys)) {
		fail("MANIFEST_INVALID", "public synthetic fixture has fields outside its exact schema");
	}
	if (
		fixture.schema !== 1 ||
		fixture.kind !== "public-synthetic" ||
		fixture.scenarioId !== manifest.scenario.id ||
		fixture.generator !== PUBLIC_SYNTHETIC_SOURCES[manifest.scenario.id]
	) {
		fail("MANIFEST_INVALID", "public synthetic fixture identity does not match the manifest");
	}
	assertSha(fixture.documentSha256, "fixture.documentSha256");
	assertSha(fixture.telemetrySha256, "fixture.telemetrySha256");
	if (
		manifest.input.fixtureSha256 !== refs[0].sha256 ||
		manifest.input.documentSha256 !== fixture.documentSha256 ||
		manifest.input.telemetrySha256 !== fixture.telemetrySha256
	) {
		fail("MANIFEST_INVALID", "fixture/document/telemetry identity does not match the manifest");
	}
}

export interface VerifiedMeasurement {
	directory: string;
	manifest: MeasurementManifest;
	recorded: RecordedChecks;
	review: ReviewReceipt;
}

export function verifyMeasurementDirectory(
	directory: string,
	options: { knownSecrets?: string[]; requireApprovedReview?: boolean } = {},
): VerifiedMeasurement {
	const root = resolve(directory);
	if (!existsSync(root)) fail("MEASUREMENT_NOT_FOUND", `${directory} does not exist`);
	const manifestFile = resolve(root, MANIFEST_FILE);
	assertPublicArtifact(manifestFile, options.knownSecrets);
	const manifest = assertManifestShape(readJson(manifestFile));
	if (!manifest.complete) fail("CANDIDATE_INCOMPLETE", `${manifest.id} is not complete`);
	if (
		manifest.scenario.kind !== "public-synthetic" ||
		!PUBLIC_SYNTHETIC_SCENARIOS.has(manifest.scenario.id)
	) {
		fail(
			"SCENARIO_NOT_PUBLIC_SYNTHETIC",
			`${manifest.scenario.id} is not registered public synthetic input`,
		);
	}
	assertRequiredRoles(manifest);
	const paths = new Set<string>();
	for (const ref of manifest.artifacts) {
		if (paths.has(ref.path)) fail("MANIFEST_INVALID", `duplicate artifact path ${ref.path}`);
		paths.add(ref.path);
		const file = assertArtifact(root, ref);
		assertPublicArtifact(file, options.knownSecrets);
	}
	assertFixture(manifest, root);
	assertCassettes(manifest, root);
	assertTransportFingerprint(manifest, root);
	assertObservedUsage(manifest, root);
	if (roleRefs(manifest, "main-cassette").length !== manifest.results.repetitions) {
		fail("CANDIDATE_INCOMPLETE", "main cassette count must equal the recorded repetition count");
	}
	const checksRefs = roleRefs(manifest, "recorded-checks");
	if (checksRefs.length !== 1)
		fail("CANDIDATE_INCOMPLETE", "exactly one recorded-checks artifact is required");
	const recorded = readJson(resolveArtifact(root, checksRefs[0].path)) as RecordedChecks;
	if (!recorded.complete) fail("CANDIDATE_INCOMPLETE", "recorded checks are not complete");
	if (recorded.scenarioId !== manifest.scenario.id) {
		fail(
			"CHECK_COUNT_MISMATCH",
			"recorded-checks scenario does not match the measurement scenario",
		);
	}
	const recomputed = recomputeMeasurementCounts(recorded);
	if (canonicalJson(recomputed) !== canonicalJson(manifest.results)) {
		fail("CHECK_COUNT_MISMATCH", "manifest k/n does not match recorded check outcomes");
	}
	const reportRefs = roleRefs(manifest, "report");
	if (reportRefs.length !== 1)
		fail("CANDIDATE_INCOMPLETE", "exactly one report artifact is required");
	assertCountsAgainstReport(
		manifest,
		readJson(resolveArtifact(root, reportRefs[0].path)) as WorkbenchReport,
	);
	const reviewRefs = roleRefs(manifest, "review-receipt");
	if (reviewRefs.length !== 1)
		fail("REVIEW_MISSING", "exactly one explicit review receipt is required");
	const review = validateReview(readJson(resolveArtifact(root, reviewRefs[0].path)), manifest.id);
	if (
		manifest.review.disposition !== review.disposition ||
		manifest.review.reviewerKind !== review.reviewer.kind
	) {
		fail("REVIEW_INVALID", "manifest review summary does not match its receipt");
	}
	if (options.requireApprovedReview && review.disposition !== "approved") {
		fail(
			"REVIEW_NOT_APPROVED",
			`${manifest.id} was reviewed with disposition ${review.disposition}`,
		);
	}
	return { directory: root, manifest, recorded, review };
}

export function exportMeasurement(options: {
	runDir: string;
	id: string;
	reviewFile: string;
	measurementsDir?: string;
	knownSecrets?: string[];
}): string {
	validateMeasurementId(options.id);
	const runDir = resolve(options.runDir);
	if (!existsSync(runDir)) fail("MEASUREMENT_NOT_FOUND", `${options.runDir} does not exist`);
	const candidate = assertManifestShape(readJson(resolve(runDir, CANDIDATE_FILE)));
	if (!candidate.complete)
		fail("CANDIDATE_INCOMPLETE", `${candidate.scenario.id} still needs its judge pass`);
	if (
		candidate.scenario.kind !== "public-synthetic" ||
		!PUBLIC_SYNTHETIC_SCENARIOS.has(candidate.scenario.id)
	) {
		fail("SCENARIO_NOT_PUBLIC_SYNTHETIC", `${candidate.scenario.id} cannot be exported`);
	}
	assertRequiredRoles(candidate);
	const reviewPath = resolve(options.reviewFile);
	if (!existsSync(reviewPath)) fail("REVIEW_MISSING", `${options.reviewFile} does not exist`);
	assertPublicArtifact(reviewPath, options.knownSecrets);
	const review = validateReview(readJson(reviewPath), options.id);
	const sourceFiles = candidate.artifacts.map((ref) => ({
		ref,
		file: assertArtifact(runDir, ref),
	}));
	for (const entry of sourceFiles) assertPublicArtifact(entry.file, options.knownSecrets);
	const root = resolve(options.measurementsDir ?? MEASUREMENTS_DIR);
	const destination = resolve(root, options.id);
	if (!isWithin(root, destination))
		fail("ARTIFACT_PATH_INVALID", "measurement id escapes destination");
	if (existsSync(destination)) fail("DUPLICATE_MEASUREMENT", `${options.id} already exists`);
	const temporary = resolve(root, `.tmp-${options.id}-${randomUUID()}`);
	mkdirSync(temporary, { recursive: true });
	try {
		const refs: ArtifactReference[] = [];
		for (const entry of sourceFiles) {
			const target = resolve(temporary, ...entry.ref.path.split("/"));
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(entry.file, target, constants.COPYFILE_EXCL);
			const copiedHash = hashFile(target);
			if (copiedHash !== entry.ref.sha256) {
				fail("ARTIFACT_HASH_MISMATCH", `${entry.ref.path} changed during adoption`);
			}
			refs.push(entry.ref);
		}
		const reviewName = "review.json";
		const reviewTarget = resolve(temporary, reviewName);
		copyFileSync(reviewPath, reviewTarget, constants.COPYFILE_EXCL);
		refs.push(artifactRef(temporary, reviewTarget, "review-receipt"));
		const manifest: MeasurementManifest = {
			...candidate,
			id: options.id,
			artifacts: refs,
			review: { disposition: review.disposition, reviewerKind: review.reviewer.kind },
		};
		writeJson(resolve(temporary, MANIFEST_FILE), manifest);
		verifyMeasurementDirectory(temporary, { knownSecrets: options.knownSecrets });
		mkdirSync(root, { recursive: true });
		renameSync(temporary, destination);
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
	return destination;
}

const IDENTITY_FIELDS: Array<[string, (identity: MeasurementIdentity) => string]> = [
	["scenario", (x) => `${x.scenario.kind}:${x.scenario.id}:${x.scenario.judged}`],
	["source.effectiveSha256", (x) => x.source.effectiveSha256],
	["fixture", (x) => x.input.fixtureSha256],
	["document", (x) => x.input.documentSha256],
	["telemetry", (x) => x.input.telemetrySha256],
	["prompt", (x) => x.fingerprints.promptSha256],
	["system", (x) => x.fingerprints.systemSha256],
	["tools", (x) => x.fingerprints.toolsSha256],
	["wire", (x) => x.fingerprints.wireSha256],
	["rubric", (x) => x.fingerprints.rubricSha256],
	["transport", (x) => x.fingerprints.transportSha256 ?? "unknown"],
	["provider", (x) => x.provider.provider],
	["endpoint", (x) => x.provider.endpointSha256],
	["agent.requested", (x) => x.models.agent.requested],
	["agent.observed", (x) => x.models.agent.observed],
	["judge.requested", (x) => x.models.judge.requested],
	["judge.observed", (x) => x.models.judge.observed],
];

export function identityDifferences(
	left: MeasurementIdentity,
	right: MeasurementIdentity,
): string[] {
	return IDENTITY_FIELDS.filter(([, read]) => read(left) !== read(right)).map(([name]) => name);
}

export function assertComparable(left: MeasurementIdentity, right: MeasurementIdentity): void {
	requireSourceSchema(left.source);
	requireSourceSchema(right.source);
	for (const [name, read] of IDENTITY_FIELDS) {
		if (
			name === "transport" &&
			left.fingerprints.transportSha256 === undefined &&
			right.fingerprints.transportSha256 === undefined
		) {
			continue;
		}
		if (read(left) === "unknown" || read(right) === "unknown") {
			fail("IDENTITY_UNKNOWN", `${name} is unknown and cannot establish comparability`);
		}
	}
	const differences = identityDifferences(left, right);
	if (differences.length > 0) {
		fail(
			"INCOMPATIBLE_IDENTITIES",
			`non-comparable measurement identities: ${differences.join(", ")}`,
		);
	}
}

function manifestPath(id: string, measurementsDir = MEASUREMENTS_DIR): string {
	validateMeasurementId(id);
	return resolve(measurementsDir, id);
}

export function verifyMeasurementId(
	id: string,
	measurementsDir = MEASUREMENTS_DIR,
): VerifiedMeasurement {
	const verified = verifyMeasurementDirectory(manifestPath(id, measurementsDir));
	if (verified.manifest.id !== id) {
		fail(
			"MEASUREMENT_ID_MISMATCH",
			`requested measurement ${id} contains manifest id ${verified.manifest.id}`,
		);
	}
	return verified;
}

export async function replayMeasurement(
	id: string,
	measurementsDir = MEASUREMENTS_DIR,
): Promise<MeasurementCounts> {
	const verified = verifyMeasurementId(id, measurementsDir);
	const current = captureSourceIdentity();
	assertReplaySourceCompatible(verified.manifest.source, current);
	const scenario = getScenario(verified.manifest.scenario.id);
	if ((scenario.judged ?? []).length > 0 !== verified.manifest.scenario.judged) {
		fail(
			"SOURCE_IDENTITY_MISMATCH",
			"current scenario judging contract differs from the measurement",
		);
	}
	const mainRefs = roleRefs(verified.manifest, "main-cassette");
	const results: RepetitionResult[] = [];
	for (const [rep, ref] of mainRefs.entries()) {
		const cassetteFile = resolveArtifact(verified.directory, ref.path);
		const cassette = readCassette(cassetteFile);
		const replay = await startReplay({
			file: cassetteFile,
			onStale: "throw",
		});
		try {
			results.push(
				await runRepetition({
					scenario,
					rep,
					endpoint: replay,
					store: offlineStore({
						baseUrl: replay.url,
						allowAgentEdits: scenario.allowAgentEdits ?? true,
						model: cassette.model,
					}),
					maxRetries: cassette.wireApi === "responses" ? 0 : undefined,
				}),
			);
		} finally {
			replay.close();
		}
		replay.assertFresh();
	}
	const judged = scenario.judged ?? [];
	let scored = results.map((result) => ({ rep: result.rep, scored: result.scored }));
	if (judged.length > 0) {
		const refs = roleRefs(verified.manifest, "judge-cassette");
		if (refs.length !== 1)
			fail("CANDIDATE_INCOMPLETE", "judged replay needs exactly one judge cassette");
		const judgeCassette = readCassette(resolveArtifact(verified.directory, refs[0].path));
		const replay = await startReplay({
			file: resolveArtifact(verified.directory, refs[0].path),
			onStale: "throw",
		});
		try {
			scored = [];
			for (const result of results) {
				const readings = new Map<string, JudgeReading>();
				for (const check of judged) {
					const reading = await askJudge({
						endpoint: {
							baseUrl: replay.url,
							model: judgeCassette.model,
							wireApi: judgeCassette.wireApi ?? "chat-completions",
						},
						rubric: check.rubric,
						input: {
							prompt: scenario.prompt,
							answer: result.run.answer,
							facts: check.facts(result.context),
						},
					});
					readings.set(check.id, reading);
				}
				scored.push({ rep: result.rep, scored: scoreRun(scenario, result.context, readings) });
			}
		} finally {
			replay.close();
		}
		replay.assertFresh();
	}
	const actual = recomputeMeasurementCounts(recordedChecksFromScored(scenario.id, scored, true));
	if (canonicalJson(actual) !== canonicalJson(verified.manifest.results)) {
		fail("REPLAY_MISMATCH", "offline cassette replay did not reproduce recorded check outcomes");
	}
	return actual;
}

export interface BoundBaseline {
	schema: 2;
	binding: "measurement-v1";
	measurementId: string;
	recordedAt: string;
	effectiveSourceSha256: string;
	identity: MeasurementIdentity;
	counts: MeasurementCounts;
	expectedFailures: string[];
}

export function boundBaselineFromMeasurement(verified: VerifiedMeasurement): BoundBaseline {
	if (verified.review.disposition !== "approved") {
		fail("REVIEW_NOT_APPROVED", `${verified.manifest.id} is not approved for a baseline claim`);
	}
	assertComparable(verified.manifest, verified.manifest);
	return {
		schema: 2,
		binding: "measurement-v1",
		measurementId: verified.manifest.id,
		recordedAt: verified.manifest.createdAt,
		effectiveSourceSha256: verified.manifest.source.effectiveSha256,
		identity: {
			scenario: verified.manifest.scenario,
			source: verified.manifest.source,
			input: verified.manifest.input,
			fingerprints: verified.manifest.fingerprints,
			models: verified.manifest.models,
			provider: verified.manifest.provider,
		},
		counts: verified.manifest.results,
		expectedFailures: verified.manifest.results.checks
			.filter((check) => check.decided > check.passed)
			.map((check) => check.id)
			.sort(),
	};
}

export function writeBoundBaseline(file: string, baseline: BoundBaseline): void {
	if (existsSync(file)) fail("DUPLICATE_MEASUREMENT", `${file} already exists`);
	writeJson(file, baseline);
}

export function verifyBoundBaseline(baseline: BoundBaseline, verified: VerifiedMeasurement): void {
	if (baseline.schema !== 2 || baseline.binding !== "measurement-v1") {
		fail("MANIFEST_INVALID", "baseline is legacy/unbound, so its numbers cannot be verified");
	}
	if (baseline.measurementId !== verified.manifest.id) {
		fail("INCOMPATIBLE_IDENTITIES", "baseline names a different measurement");
	}
	if (
		baseline.effectiveSourceSha256 !== baseline.identity.source.effectiveSha256 ||
		baseline.effectiveSourceSha256 !== verified.manifest.source.effectiveSha256
	) {
		fail("SOURCE_IDENTITY_MISMATCH", "baseline effective source does not match its measurement");
	}
	assertComparable(baseline.identity, verified.manifest);
	if (canonicalJson(baseline.counts) !== canonicalJson(verified.manifest.results)) {
		fail("CHECK_COUNT_MISMATCH", "baseline k/n does not match its bound measurement");
	}
}
