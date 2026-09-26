import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface SourceContentEntry {
	path: string;
	kind: "text" | "binary" | "deleted";
	sha256: string;
}

export interface SourceIdentity {
	schema: 2;
	/** Git HEAD when the measurement was captured. Provenance, not compatibility. */
	commit: string;
	/** Current bytes for relevant paths changed from HEAD, plus deleted markers. */
	dirtyManifest: SourceContentEntry[];
	dirtySha256: string;
	/** Current effective relevant tree. Deleted paths are absent. */
	effectiveManifest: SourceContentEntry[];
	effectiveSha256: string;
}

export interface EndpointIdentity {
	provider: string;
	endpointSha256: string;
}

export const MANDATORY_SOURCE_ANCHORS = [
	"package.json",
	"package-lock.json",
	"tsconfig.workbench.json",
	"workbench/cli-entry.ts",
	"workbench/cli.ts",
	"workbench/lib/harness.ts",
	"workbench/lib/runner.ts",
	"workbench/lib/score.ts",
	"workbench/lib/measurement.ts",
	"workbench/lib/provenance.ts",
	"workbench/scenarios/registry.ts",
	"src/lib/ai-edition/schema/index.ts",
	"electron/ai-edition/agent-tools.ts",
	"electron/ai-edition/deep-agent/service.ts",
] as const;

export const MINIMUM_SOURCE_ANCHORS = 14;

const ROOT_SOURCE_FILES = new Set([
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.node.json",
	"tsconfig.workbench.json",
	"vitest.workbench.config.ts",
]);

const SOURCE_SUFFIXES = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".json",
	".wasm",
] as const;

const EXCLUDED_SOURCE_PREFIXES = [
	"workbench/.build/",
	"workbench/baselines/",
	"workbench/cassettes/",
	"workbench/docs/",
	"workbench/fixtures/",
	"workbench/l0/",
	"workbench/l1/",
	"workbench/measurements/",
	"workbench/reports/",
	"workbench/runs/",
] as const;

const EXCLUDED_SOURCE_SEGMENTS = new Set([
	".agent-evidence",
	"build",
	"dist",
	"dist-electron",
	"goal-runs",
	"node_modules",
	"target",
	"__snapshots__",
]);

export class SourceIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SourceIdentityError";
	}
}

export function sha256Bytes(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

/** JSON whose hashes must survive platforms: sorted keys, LF-only strings. */
export function canonicalJson(value: unknown): string {
	const normalize = (input: unknown): unknown => {
		if (typeof input === "string") return input.replace(/\r\n?/g, "\n");
		if (Array.isArray(input)) return input.map(normalize);
		if (input !== null && typeof input === "object") {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(input as Record<string, unknown>).sort()) {
				out[key] = normalize((input as Record<string, unknown>)[key]);
			}
			return out;
		}
		return input;
	};
	return JSON.stringify(normalize(value));
}

export function sha256Canonical(value: unknown): string {
	return sha256Bytes(canonicalJson(value));
}

function codePointOrder(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sortEntries(entries: SourceContentEntry[]): SourceContentEntry[] {
	return [...entries].sort((left, right) => codePointOrder(left.path, right.path));
}

function splitNullList(value: string): string[] {
	return value.split("\0").filter(Boolean);
}

function portable(path: string): string {
	return path.replace(/\\/g, "/");
}

function validatePortablePath(path: unknown): asserts path is string {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new SourceIdentityError(`source path is not portable: ${String(path)}`);
	}
}

/** Closed, shared capture/validation predicate from the issue #459 amendment. */
export function isRelevantSourcePath(path: string): boolean {
	const normalized = portable(path);
	if (ROOT_SOURCE_FILES.has(normalized)) return true;
	if (EXCLUDED_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
	if (
		normalized.endsWith(".test.ts") ||
		normalized.endsWith(".test.tsx") ||
		normalized.endsWith(".wb.ts")
	) {
		return false;
	}
	const segments = normalized.split("/");
	if (segments.some((segment) => EXCLUDED_SOURCE_SEGMENTS.has(segment))) return false;
	if (
		!(["workbench", "src", "electron"] as const).some((root) => normalized.startsWith(`${root}/`))
	) {
		return false;
	}
	return SOURCE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function excludedTree(path: string): boolean {
	const normalized = portable(path);
	const asDirectory = `${normalized.replace(/\/$/, "")}/`;
	if (
		EXCLUDED_SOURCE_PREFIXES.some(
			(prefix) => asDirectory === prefix || asDirectory.startsWith(prefix),
		)
	) {
		return true;
	}
	return normalized.split("/").some((segment) => EXCLUDED_SOURCE_SEGMENTS.has(segment));
}

function assertNoRelevantSubmodules(root: string): void {
	const records = splitNullList(
		execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "utf8" }),
	);
	for (const record of records) {
		const separator = record.indexOf("\t");
		if (separator < 0) continue;
		const [mode] = record.slice(0, separator).split(" ");
		if (mode !== "160000") continue;
		const path = portable(record.slice(separator + 1));
		if (
			!excludedTree(path) &&
			(["workbench", "src", "electron"] as const).some(
				(includedRoot) => path === includedRoot || path.startsWith(`${includedRoot}/`),
			)
		) {
			throw new SourceIdentityError(`relevant Git submodule is not supported: ${path}`);
		}
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

type SourceReader = (file: string) => Buffer;

function currentEntry(
	root: string,
	path: string,
	read: SourceReader = (file) => readFileSync(file),
): SourceContentEntry {
	validatePortablePath(path);
	const absolute = resolve(root, ...path.split("/"));
	if (!isWithin(root, absolute)) throw new SourceIdentityError(`${path} escapes the source root`);
	let cursor = resolve(root);
	for (const segment of path.split("/")) {
		cursor = resolve(cursor, segment);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) {
			throw new SourceIdentityError(`${path} traverses a symlink or reparse point`);
		}
	}
	const stat = lstatSync(absolute);
	if (!stat.isFile()) throw new SourceIdentityError(`${path} is not a regular source file`);
	if (!isWithin(realpathSync(root), realpathSync(absolute))) {
		throw new SourceIdentityError(`${path} resolves outside the source root`);
	}
	let bytes: Buffer;
	try {
		bytes = read(absolute);
	} catch (error) {
		throw new SourceIdentityError(
			`${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const text = isUtf8(bytes) && !bytes.includes(0);
	const canonical = text ? bytes.toString("utf8").replace(/\r\n?/g, "\n") : bytes;
	return {
		path,
		kind: text ? "text" : "binary",
		sha256: sha256Bytes(canonical),
	};
}

function validateEntries(
	entries: unknown,
	options: { allowDeleted: boolean; requireAnchors: boolean },
): SourceContentEntry[] {
	if (!Array.isArray(entries)) throw new SourceIdentityError("source manifest must be an array");
	const typed = entries as SourceContentEntry[];
	const paths = new Set<string>();
	const caseFolded = new Set<string>();
	let previous: string | null = null;
	for (const entry of typed) {
		if (!entry || typeof entry !== "object") {
			throw new SourceIdentityError("source manifest entry must be an object");
		}
		if (canonicalJson(Object.keys(entry).sort()) !== canonicalJson(["kind", "path", "sha256"])) {
			throw new SourceIdentityError(
				"source manifest entry must contain only path, kind, and sha256",
			);
		}
		validatePortablePath(entry.path);
		if (!isRelevantSourcePath(entry.path)) {
			throw new SourceIdentityError(`source manifest contains an irrelevant path: ${entry.path}`);
		}
		if (
			entry.kind !== "text" &&
			entry.kind !== "binary" &&
			!(options.allowDeleted && entry.kind === "deleted")
		) {
			throw new SourceIdentityError(`${entry.path} has invalid source kind ${String(entry.kind)}`);
		}
		if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
			throw new SourceIdentityError(`${entry.path} has an invalid SHA256`);
		}
		const folded = entry.path.toLowerCase();
		if (paths.has(entry.path) || caseFolded.has(folded)) {
			throw new SourceIdentityError(`source manifest path is duplicated: ${entry.path}`);
		}
		if (previous !== null && codePointOrder(previous, entry.path) >= 0) {
			throw new SourceIdentityError("source manifest is not in deterministic code-point order");
		}
		paths.add(entry.path);
		caseFolded.add(folded);
		previous = entry.path;
	}
	if (options.requireAnchors) {
		if (MANDATORY_SOURCE_ANCHORS.length < MINIMUM_SOURCE_ANCHORS) {
			throw new SourceIdentityError("source anchor policy dropped below its 14-anchor floor");
		}
		for (const anchor of MANDATORY_SOURCE_ANCHORS) {
			if (!paths.has(anchor))
				throw new SourceIdentityError(`effective source is missing anchor ${anchor}`);
		}
	}
	return typed;
}

export function validateSourceIdentity(value: unknown): SourceIdentity {
	const source = value as Partial<SourceIdentity> & {
		contentManifest?: unknown;
		contentSha256?: unknown;
	};
	if (source.schema !== 2) {
		if (source.contentManifest !== undefined || source.contentSha256 !== undefined) {
			throw new SourceIdentityError(
				"legacy dirty-only source identity is non-comparable; source.schema 2 is required",
			);
		}
		throw new SourceIdentityError("source.schema 2 is required");
	}
	const keys = value !== null && typeof value === "object" ? Object.keys(value).sort() : [];
	if (
		canonicalJson(keys) !==
		canonicalJson(
			[
				"commit",
				"dirtyManifest",
				"dirtySha256",
				"effectiveManifest",
				"effectiveSha256",
				"schema",
			].sort(),
		)
	) {
		if (source.contentManifest !== undefined || source.contentSha256 !== undefined) {
			throw new SourceIdentityError(
				"legacy dirty-only source identity fields are non-comparable and forbidden in schema 2",
			);
		}
		throw new SourceIdentityError("source.schema 2 contains unknown or missing fields");
	}
	if (typeof source.commit !== "string" || !/^[a-f0-9]{40}$/.test(source.commit)) {
		throw new SourceIdentityError("source.commit must be a full lowercase Git SHA");
	}
	const dirty = validateEntries(source.dirtyManifest, {
		allowDeleted: true,
		requireAnchors: false,
	});
	const effective = validateEntries(source.effectiveManifest, {
		allowDeleted: false,
		requireAnchors: true,
	});
	if (
		typeof source.dirtySha256 !== "string" ||
		!SHA256_PATTERN.test(source.dirtySha256) ||
		sha256Canonical(dirty) !== source.dirtySha256
	) {
		throw new SourceIdentityError("source.dirtySha256 does not match dirtyManifest");
	}
	if (
		typeof source.effectiveSha256 !== "string" ||
		!SHA256_PATTERN.test(source.effectiveSha256) ||
		sha256Canonical(effective) !== source.effectiveSha256
	) {
		throw new SourceIdentityError("source.effectiveSha256 does not match effectiveManifest");
	}
	return source as SourceIdentity;
}

export function sourceIdentityFromManifests(options: {
	commit: string;
	dirtyManifest: SourceContentEntry[];
	effectiveManifest: SourceContentEntry[];
}): SourceIdentity {
	const dirtyManifest = sortEntries(options.dirtyManifest);
	const effectiveManifest = sortEntries(options.effectiveManifest);
	return validateSourceIdentity({
		schema: 2,
		commit: options.commit,
		dirtyManifest,
		dirtySha256: sha256Canonical(dirtyManifest),
		effectiveManifest,
		effectiveSha256: sha256Canonical(effectiveManifest),
	});
}

/**
 * Capture both provenance (HEAD plus dirty overlay) and the effective current
 * source tree. Compatibility uses only the latter; committing identical bytes
 * or committing excluded evidence changes provenance without changing code.
 */
export function captureSourceIdentity(
	cwd = process.cwd(),
	options: { readFile?: SourceReader } = {},
): SourceIdentity {
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf8",
	}).trim();
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	const tracked = splitNullList(
		execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: root, encoding: "utf8" }),
	);
	const untracked = splitNullList(
		execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
			cwd: root,
			encoding: "utf8",
		}),
	);
	const changed = splitNullList(
		execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}),
	);
	assertNoRelevantSubmodules(root);
	const normalizePaths = (paths: string[]) =>
		[...new Set(paths.map(portable))].filter(isRelevantSourcePath).sort(codePointOrder);
	const untrackedRelevant = normalizePaths(untracked);
	const effectivePaths = normalizePaths([...tracked, ...untrackedRelevant]).filter((path) =>
		pathExists(resolve(root, ...path.split("/"))),
	);
	const dirtyPaths = normalizePaths([...changed, ...untrackedRelevant]);
	const dirtyManifest = dirtyPaths.map((path) =>
		pathExists(resolve(root, ...path.split("/")))
			? currentEntry(root, path, options.readFile)
			: { path, kind: "deleted" as const, sha256: sha256Bytes("<deleted>\n") },
	);
	const effectiveManifest = effectivePaths.map((path) =>
		currentEntry(root, path, options.readFile),
	);
	return sourceIdentityFromManifests({ commit, dirtyManifest, effectiveManifest });
}

export function normalizeEndpoint(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("endpoint must be an absolute URL");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("endpoint must use http or https");
	}
	if (parsed.username || parsed.password) throw new Error("endpoint must not contain credentials");
	if (parsed.search) throw new Error("endpoint must not contain a query string");
	if (parsed.hash) throw new Error("endpoint must not contain a fragment");
	const path = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
	return `${parsed.origin.toLowerCase()}${path}`;
}

export function endpointIdentity(provider: string, rawEndpoint: string): EndpointIdentity {
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider)) {
		throw new Error("provider label must contain only letters, digits, dot, underscore, or dash");
	}
	return {
		provider,
		endpointSha256: sha256Bytes(normalizeEndpoint(rawEndpoint)),
	};
}
