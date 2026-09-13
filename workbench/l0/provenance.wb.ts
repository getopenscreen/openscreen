import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertReplaySourceCompatible, MeasurementError } from "../lib/measurement";
import {
	captureSourceIdentity,
	endpointIdentity,
	isRelevantSourcePath,
	MANDATORY_SOURCE_ANCHORS,
	MINIMUM_SOURCE_ANCHORS,
	normalizeEndpoint,
	SourceIdentityError,
	sha256Bytes,
	sha256Canonical,
	validateSourceIdentity,
} from "../lib/provenance";

const roots: string[] = [];

function git(root: string, args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, contents: string | Buffer): void {
	const file = join(root, ...path.split("/"));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

function commit(root: string, message: string): string {
	git(root, ["add", "-A"]);
	git(root, [
		"-c",
		"user.name=Workbench",
		"-c",
		"user.email=workbench@example.invalid",
		"commit",
		"-m",
		message,
		"--quiet",
	]);
	return git(root, ["rev-parse", "HEAD"]);
}

function expectReplaySourceMismatch(recorded: unknown, current: unknown): void {
	try {
		assertReplaySourceCompatible(recorded, current);
		throw new Error("expected replay source mismatch");
	} catch (error) {
		expect(error).toBeInstanceOf(MeasurementError);
		expect((error as MeasurementError).code).toBe("SOURCE_IDENTITY_MISMATCH");
	}
}

function seedRepository(): string {
	const root = mkdtempSync(join(tmpdir(), "wb-source-identity-"));
	roots.push(root);
	git(root, ["init", "--quiet"]);
	git(root, ["config", "core.autocrlf", "false"]);
	for (const path of MANDATORY_SOURCE_ANCHORS) write(root, path, `anchor ${path}\n`);
	for (const path of ["tsconfig.json", "tsconfig.node.json", "vitest.workbench.config.ts"]) {
		write(root, path, `config ${path}\n`);
	}
	commit(root, "seed source anchors");
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("source relevance and endpoint identity", () => {
	it("uses the closed relevance predicate and retains its fourteen anchors", () => {
		expect(MINIMUM_SOURCE_ANCHORS).toBe(14);
		expect(MANDATORY_SOURCE_ANCHORS).toHaveLength(14);
		for (const anchor of MANDATORY_SOURCE_ANCHORS) expect(isRelevantSourcePath(anchor)).toBe(true);
		expect(isRelevantSourcePath("src/feature.tsx")).toBe(true);
		expect(isRelevantSourcePath("electron/native/helper.wasm")).toBe(true);
		expect(isRelevantSourcePath("workbench/lib/check.mts")).toBe(true);
		expect(isRelevantSourcePath("tsconfig.test.json")).toBe(false);
		expect(isRelevantSourcePath("workbench/l0/probe.ts")).toBe(false);
		expect(isRelevantSourcePath("workbench/l1/probe.ts")).toBe(false);
		expect(isRelevantSourcePath("workbench/baselines/probe.json")).toBe(false);
		expect(isRelevantSourcePath("workbench/docs/example.ts")).toBe(false);
		expect(isRelevantSourcePath("workbench/measurements/probe/measurement.json")).toBe(false);
		expect(isRelevantSourcePath("src/node_modules/pkg/index.ts")).toBe(false);
		expect(isRelevantSourcePath("src/generated.TS")).toBe(false);
		expect(isRelevantSourcePath("docs/example.ts")).toBe(false);
	});

	it.each(["workbench", "src", "electron"])("includes the %s source root", (root) => {
		expect(isRelevantSourcePath(`${root}/feature.ts`)).toBe(true);
	});

	it.each([
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
	])("includes the case-sensitive %s suffix", (suffix) => {
		expect(isRelevantSourcePath(`src/feature${suffix}`)).toBe(true);
	});

	it.each([
		"workbench/.build/probe.ts",
		"workbench/baselines/probe.json",
		"workbench/cassettes/probe.json",
		"workbench/docs/probe.ts",
		"workbench/fixtures/probe.json",
		"workbench/l0/probe.ts",
		"workbench/l1/probe.ts",
		"workbench/measurements/probe/measurement.json",
		"workbench/reports/probe.json",
		"workbench/runs/probe.json",
		"src/probe.test.ts",
		"src/probe.test.tsx",
		"src/probe.wb.ts",
	])("excludes the non-runtime path %s", (path) => {
		expect(isRelevantSourcePath(path)).toBe(false);
	});

	it.each([
		"node_modules",
		"build",
		"target",
		"dist",
		"dist-electron",
		".agent-evidence",
		"goal-runs",
		"__snapshots__",
	])("excludes the %s path segment", (segment) => {
		expect(isRelevantSourcePath(`src/${segment}/probe.ts`)).toBe(false);
	});

	it("includes only the six exact root configuration files", () => {
		for (const path of [
			"package.json",
			"package-lock.json",
			"tsconfig.json",
			"tsconfig.node.json",
			"tsconfig.workbench.json",
			"vitest.workbench.config.ts",
		]) {
			expect(isRelevantSourcePath(path)).toBe(true);
		}
		expect(isRelevantSourcePath("tsconfig.test.json")).toBe(false);
		expect(isRelevantSourcePath("vite.config.ts")).toBe(false);
	});

	it("normalizes origin/path while rejecting credentials, query, and fragment", () => {
		const raw = "HTTPS://Example.COM:443/v1//";
		expect(normalizeEndpoint(raw)).toBe("https://example.com/v1");
		const identity = endpointIdentity("openai-compatible", raw);
		expect(identity).toEqual({
			provider: "openai-compatible",
			endpointSha256: sha256Bytes("https://example.com/v1"),
		});
		expect(JSON.stringify(identity)).not.toContain("example.com");
		expect(() => normalizeEndpoint("https://user:secret@example.com/v1")).toThrow(/credentials/);
		expect(() => normalizeEndpoint("https://example.com/v1?deployment=a")).toThrow(/query/);
		expect(() => normalizeEndpoint("https://example.com/v1#fragment")).toThrow(/fragment/);
	});
});

describe("effective source identity across commits and clones", () => {
	it("survives committing identical source, an artifact-only commit, and a local clone", () => {
		const root = seedRepository();
		const initial = captureSourceIdentity(root);
		write(root, "workbench/lib/runner.ts", "edited runner\r\nsecond line\r\n");
		write(root, "src/new-source.ts", "export const value = 1;\n");
		const dirty = captureSourceIdentity(root);
		expect(dirty.commit).toBe(initial.commit);
		expect(dirty.dirtyManifest.map((entry) => entry.path)).toEqual([
			"src/new-source.ts",
			"workbench/lib/runner.ts",
		]);
		expect(dirty.effectiveSha256).not.toBe(initial.effectiveSha256);

		const sourceCommit = commit(root, "commit identical source bytes");
		const clean = captureSourceIdentity(root);
		expect(clean.commit).toBe(sourceCommit);
		expect(clean.commit).not.toBe(dirty.commit);
		expect(clean.dirtyManifest).toEqual([]);
		expect(clean.dirtySha256).not.toBe(dirty.dirtySha256);
		expect(clean.effectiveSha256).toBe(dirty.effectiveSha256);
		expect(clean.effectiveManifest).toEqual(dirty.effectiveManifest);
		expect(() => assertReplaySourceCompatible(dirty, clean)).not.toThrow();

		write(root, "workbench/measurements/m1/measurement.json", '{"schema":1}\n');
		const artifactCommit = commit(root, "add measurement evidence only");
		const withArtifact = captureSourceIdentity(root);
		expect(withArtifact.commit).toBe(artifactCommit);
		expect(withArtifact.commit).not.toBe(clean.commit);
		expect(withArtifact.effectiveSha256).toBe(clean.effectiveSha256);
		expect(() => assertReplaySourceCompatible(clean, withArtifact)).not.toThrow();
		write(root, "workbench/README.md", "documentation only\n");
		const docsCommit = commit(root, "add excluded documentation");
		const withDocs = captureSourceIdentity(root);
		expect(withDocs.commit).toBe(docsCommit);
		expect(withDocs.effectiveSha256).toBe(withArtifact.effectiveSha256);
		expect(() => assertReplaySourceCompatible(withArtifact, withDocs)).not.toThrow();

		const clone = `${root}-clone`;
		roots.push(clone);
		execFileSync("git", ["clone", "--quiet", root, clone]);
		const cloned = captureSourceIdentity(clone);
		expect(cloned.commit).toBe(withDocs.commit);
		expect(cloned.dirtyManifest).toEqual([]);
		expect(cloned.effectiveSha256).toBe(withDocs.effectiveSha256);
		expect(cloned.effectiveManifest).toEqual(withDocs.effectiveManifest);
		expect(() => assertReplaySourceCompatible(dirty, cloned)).not.toThrow();
	});

	it("changes effective identity for source additions, edits, deletions, and renames", () => {
		const root = seedRepository();
		const initial = captureSourceIdentity(root);
		write(root, "src/new-source.ts", "export const value = 1;\n");
		const added = captureSourceIdentity(root);
		expect(added.effectiveSha256).not.toBe(initial.effectiveSha256);
		expectReplaySourceMismatch(initial, added);
		commit(root, "add source");

		write(root, "electron/ai-edition/agent-tools.ts", "edited agent tools\n");
		const edited = captureSourceIdentity(root);
		expect(edited.effectiveSha256).not.toBe(added.effectiveSha256);
		expectReplaySourceMismatch(added, edited);
		git(root, ["checkout", "--", "electron/ai-edition/agent-tools.ts"]);

		git(root, ["mv", "src/new-source.ts", "src/renamed-source.ts"]);
		const renamed = captureSourceIdentity(root);
		expect(renamed.effectiveSha256).not.toBe(added.effectiveSha256);
		expectReplaySourceMismatch(added, renamed);
		expect(renamed.dirtyManifest.some((entry) => entry.kind === "deleted")).toBe(true);
		git(root, ["reset", "--hard", "HEAD"]);

		rmSync(join(root, "src", "new-source.ts"));
		const deleted = captureSourceIdentity(root);
		expect(deleted.effectiveSha256).not.toBe(added.effectiveSha256);
		expectReplaySourceMismatch(added, deleted);
		expect(deleted.dirtyManifest).toContainEqual({
			path: "src/new-source.ts",
			kind: "deleted",
			sha256: sha256Bytes("<deleted>\n"),
		});
		const deletionCommit = commit(root, "commit source deletion");
		const committedDeletion = captureSourceIdentity(root);
		expect(committedDeletion.commit).toBe(deletionCommit);
		expect(committedDeletion.dirtyManifest).toEqual([]);
		expect(committedDeletion.effectiveSha256).toBe(deleted.effectiveSha256);
		expect(() => assertReplaySourceCompatible(deleted, committedDeletion)).not.toThrow();
	});

	it("canonicalizes text line endings and hashes binary bytes raw", () => {
		const root = seedRepository();
		write(root, "src/line-endings.ts", "first\r\nsecond\r\n");
		write(root, "src/payload.wasm", Buffer.from([0x00, 0x0d, 0x0a]));
		const crlf = captureSourceIdentity(root);
		const binary = crlf.effectiveManifest.find((entry) => entry.path === "src/payload.wasm");
		expect(binary).toEqual({
			path: "src/payload.wasm",
			kind: "binary",
			sha256: sha256Bytes(Buffer.from([0x00, 0x0d, 0x0a])),
		});
		write(root, "src/line-endings.ts", "first\nsecond\n");
		expect(captureSourceIdentity(root).effectiveSha256).toBe(crlf.effectiveSha256);
		write(root, "src/payload.wasm", Buffer.from([0x00, 0x0a]));
		expect(captureSourceIdentity(root).effectiveSha256).not.toBe(crlf.effectiveSha256);
	});

	it("rejects malformed digests, missing anchors, legacy schema, and symlink traversal", ({
		skip,
	}) => {
		const root = seedRepository();
		const source = captureSourceIdentity(root);
		expect(() =>
			captureSourceIdentity(root, {
				readFile: (file) => {
					if (file.replace(/\\/g, "/").endsWith("workbench/lib/runner.ts")) {
						throw new Error("synthetic read denial");
					}
					return readFileSync(file);
				},
			}),
		).toThrow(/runner\.ts is unreadable: synthetic read denial/);
		const badDigest = structuredClone(source);
		badDigest.effectiveSha256 = "0".repeat(64);
		expect(() => validateSourceIdentity(badDigest)).toThrow(/effectiveSha256/);
		const missingAnchor = structuredClone(source);
		missingAnchor.effectiveManifest = missingAnchor.effectiveManifest.slice(1);
		missingAnchor.effectiveSha256 = sha256Canonical(missingAnchor.effectiveManifest);
		expect(() => validateSourceIdentity(missingAnchor)).toThrow(/missing anchor/);
		const duplicate = structuredClone(source);
		duplicate.effectiveManifest.splice(1, 0, structuredClone(duplicate.effectiveManifest[0]));
		duplicate.effectiveSha256 = sha256Canonical(duplicate.effectiveManifest);
		expect(() => validateSourceIdentity(duplicate)).toThrow(/duplicated/);
		const caseFolded = structuredClone(source);
		const schemaAnchor = caseFolded.effectiveManifest.find(
			(entry) => entry.path === "src/lib/ai-edition/schema/index.ts",
		)!;
		caseFolded.effectiveManifest.push({
			...schemaAnchor,
			path: "src/lib/ai-edition/schema/Index.ts",
		});
		caseFolded.effectiveManifest.sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		);
		caseFolded.effectiveSha256 = sha256Canonical(caseFolded.effectiveManifest);
		expect(() => validateSourceIdentity(caseFolded)).toThrow(/duplicated/);
		const unsorted = structuredClone(source);
		unsorted.effectiveManifest.reverse();
		unsorted.effectiveSha256 = sha256Canonical(unsorted.effectiveManifest);
		expect(() => validateSourceIdentity(unsorted)).toThrow(/code-point order/);
		const nonportable = structuredClone(source);
		nonportable.effectiveManifest[0].path = "../escape.ts";
		nonportable.effectiveSha256 = sha256Canonical(nonportable.effectiveManifest);
		expect(() => validateSourceIdentity(nonportable)).toThrow(/not portable/);
		const invalidKind = structuredClone(source);
		invalidKind.effectiveManifest[0].kind = "deleted";
		invalidKind.effectiveSha256 = sha256Canonical(invalidKind.effectiveManifest);
		expect(() => validateSourceIdentity(invalidKind)).toThrow(/invalid source kind/);
		const malformedHash = structuredClone(source);
		malformedHash.effectiveManifest[0].sha256 = "not-a-hash";
		malformedHash.effectiveSha256 = sha256Canonical(malformedHash.effectiveManifest);
		expect(() => validateSourceIdentity(malformedHash)).toThrow(/invalid SHA256/);
		expect(() =>
			validateSourceIdentity({
				commit: source.commit,
				contentManifest: source.dirtyManifest,
				contentSha256: source.dirtySha256,
			}),
		).toThrow(/legacy dirty-only/);
		expect(() =>
			validateSourceIdentity({
				...source,
				contentManifest: source.dirtyManifest,
				contentSha256: source.dirtySha256,
			}),
		).toThrow(/legacy dirty-only/);

		const outside = mkdtempSync(join(tmpdir(), "wb-source-outside-"));
		roots.push(outside);
		write(outside, "nested.ts", "outside source\n");
		const link = join(root, "src", "linked");
		try {
			symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
		} catch {
			skip();
			return;
		}
		expect(() => captureSourceIdentity(root)).toThrow(SourceIdentityError);
	});

	it("fails closed on an empty effective tree and a non-regular mandatory anchor", () => {
		const empty = mkdtempSync(join(tmpdir(), "wb-source-empty-"));
		roots.push(empty);
		git(empty, ["init", "--quiet"]);
		git(empty, ["config", "core.autocrlf", "false"]);
		write(empty, "README.md", "irrelevant\n");
		commit(empty, "irrelevant file only");
		expect(() => captureSourceIdentity(empty)).toThrow(/missing anchor/);

		const irregular = seedRepository();
		rmSync(join(irregular, "package.json"));
		mkdirSync(join(irregular, "package.json"));
		expect(() => captureSourceIdentity(irregular)).toThrow(/not a regular source file/);
	});

	it("refuses a relevant Git submodule instead of hashing through it", () => {
		const root = seedRepository();
		const submodule = mkdtempSync(join(tmpdir(), "wb-source-submodule-"));
		roots.push(submodule);
		git(submodule, ["init", "--quiet"]);
		git(submodule, ["config", "core.autocrlf", "false"]);
		write(submodule, "index.ts", "export const fromSubmodule = true;\n");
		commit(submodule, "seed local submodule");
		git(root, [
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"--quiet",
			submodule,
			"src/submodule",
		]);
		expect(() => captureSourceIdentity(root)).toThrow(/submodule/);
	});
});
