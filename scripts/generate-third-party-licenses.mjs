// Writes build-licenses/THIRD-PARTY-LICENSES.txt, the full licence texts of the third-party code
// compiled into the installers. electron-builder.json5 ships it in resources/, beside
// THIRD-PARTY-NOTICES.md, which covers the other bundled components.
//
// Two sources, both read at build time so a dependency bump needs no manual step:
//   - npm: every production entry of package-lock.json. node_modules is not packaged, but the
//     code is: Vite bundles it into dist/ and dist-electron/.
//   - Rust: every crate compiled into compositor_view.node, from `cargo metadata`.
//
// A package without a licence file is recorded with its declared licence, with a warning; that
// never fails a build. A missing or failing cargo does, and nothing is written: every installer
// ships the addon, so a file without its crates would be incomplete, and before-pack.cjs, which
// refuses to package when the file is absent, would accept it.
//
// Run: node scripts/generate-third-party-licenses.mjs [output path]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "build-licenses", "THIRD-PARTY-LICENSES.txt");
const ADDON_CRATE = "compositor-view-napi";
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;
const NO_FILE = "(no licence file in the package)";

/**
 * The licence and NOTICE files at the top of a package directory, in file-name order, then the
 * `extra` files that exist. A text read twice is printed once: renderSection merges it.
 */
function readLicenseTexts(dir, extra = []) {
	const names = fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
		.map((entry) => entry.name)
		.sort();
	return [
		...names.map((name) => path.join(dir, name)),
		...extra.filter((file) => fs.existsSync(file)),
	]
		.map((file) => fs.readFileSync(file, "utf8"))
		.filter((text) => text.trim());
}

/**
 * SPDX expression from a package.json or a cargo package; tolerates the legacy object forms.
 * A crate may declare only a `license_file`, a custom licence, which is then named instead.
 */
function declaredLicense({ license, licenses, license_file }) {
	const values = [license ?? licenses].flat();
	const ids = values.map((value) => (typeof value === "string" ? value : value?.type));
	return (
		ids.filter(Boolean).join(" OR ") ||
		(license_file ? `see ${license_file}` : "no declared licence")
	);
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

/**
 * Production npm packages: package-lock.json entries under node_modules/ that are not `dev`
 * (`optional` and `devOptional` ones included). An entry not installed on this machine, such as
 * another platform's optional binary, is skipped: none of its code was bundled here.
 */
export function collectNpmPackages(root = ROOT) {
	const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
	const packages = new Map();
	const skipped = [];
	for (const [key, entry] of Object.entries(lock.packages ?? {})) {
		if (!key.startsWith("node_modules/") || entry.dev) continue;
		const dir = path.join(root, key);
		if (!fs.existsSync(dir)) {
			skipped.push(key);
			continue;
		}
		const name = key.split("node_modules/").pop();
		const info = { name, ...entry, ...readJson(path.join(dir, "package.json")) };
		const label = `${info.name} ${info.version} (${declaredLicense(info)})`;
		if (!packages.has(label)) packages.set(label, readLicenseTexts(dir));
	}
	return { entries: [...packages].map(([label, texts]) => ({ label, texts })), skipped };
}

/**
 * Crates compiled into the addon: the closure of NORMAL dependencies of compositor-view-napi,
 * for every target platform. Build-dependencies never reach the binary, and neither do
 * procedural macros, which run inside rustc, nor what only they pull in, so the walk stops at
 * them. Workspace members are OpenScreen's own code, under its LICENSE.
 */
export function collectCrates(metadata) {
	const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
	const deps = new Map(metadata.resolve.nodes.map((node) => [node.id, node.deps]));
	const members = new Set(metadata.workspace_members);
	const isProcMacro = (pkg) => pkg.targets.some((target) => target.kind.includes("proc-macro"));
	const root = metadata.packages.find((pkg) => pkg.name === ADDON_CRATE && members.has(pkg.id));
	if (!root) throw new Error(`${ADDON_CRATE} is not a member of the cargo workspace`);

	const seen = new Set();
	const stack = [root.id];
	while (stack.length > 0) {
		const id = stack.pop();
		if (seen.has(id) || isProcMacro(packages.get(id))) continue;
		seen.add(id);
		for (const dep of deps.get(id) ?? []) {
			if (dep.dep_kinds.some((kind) => kind.kind === null)) stack.push(dep.pkg);
		}
	}
	return [...seen]
		.filter((id) => !members.has(id))
		.map((id) => packages.get(id))
		.map((pkg) => {
			const dir = path.dirname(pkg.manifest_path);
			// Cargo's `license-file` is relative to the manifest and may sit below the top level.
			const declared = pkg.license_file ? [path.resolve(dir, pkg.license_file)] : [];
			return {
				label: `${pkg.name} ${pkg.version} (${declaredLicense(pkg)})`,
				texts: readLicenseTexts(dir, declared),
			};
		});
}

// Code-unit order, not localeCompare: the same input must give the same bytes on every runner.
const byLabel = (a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
const RULE = "=".repeat(80);
const LINE = "-".repeat(80);

/** Each distinct text once, after the sorted labels of every package that ships it. */
function renderSection(title, entries) {
	const groups = new Map();
	for (const { label, texts } of [...entries].sort(byLabel)) {
		for (const text of texts.length > 0 ? texts : [NO_FILE]) {
			const key = text.replace(/\s+/g, " ").trim();
			const group = groups.get(key) ?? { text: text.replace(/\r\n?/g, "\n").trim(), labels: [] };
			groups.set(key, group);
			if (group.labels.at(-1) !== label) group.labels.push(label);
		}
	}
	const blocks = [...groups.values()].map(({ labels, text }) =>
		[LINE, ...labels, "", text, ""].join("\n"),
	);
	return [RULE, title, RULE, "", ...blocks].join("\n");
}

function summary(noun, entries) {
	const missing = entries.filter((entry) => entry.texts.length === 0).length;
	return `${noun}: ${entries.length} (${missing} without a licence file).`;
}

export function renderLicenses({ npm, crates }) {
	const header = [
		"OpenScreen: third-party licences",
		"",
		"The full licence texts of the third-party code compiled into OpenScreen: the npm",
		"production dependencies, which Vite bundles into the application, and the Rust crates",
		"compiled into the native compositor addon (compositor_view.node). Each distinct text",
		'appears once, preceded by the packages that ship it as "name version (declared licence)".',
		"",
		"The other bundled components (FFmpeg, whisper.cpp, ONNX Runtime, fonts, model weights",
		"and more) and their source offers are described in THIRD-PARTY-NOTICES.md, beside this",
		"file. Generated at build time by scripts/generate-third-party-licenses.mjs.",
		"",
		summary("npm packages", npm),
		summary("Rust crates", crates),
		"",
	];
	const sections = [
		renderSection("npm packages", npm),
		renderSection("Rust crates compiled into the compositor addon", crates),
	];
	return `${[...header, ...sections].join("\n").trimEnd()}\n`;
}

function cargoMetadata() {
	const exe = process.platform === "win32" ? "cargo.exe" : "cargo";
	const rustup = path.join(os.homedir(), ".cargo", "bin", exe);
	const crates = path.join(ROOT, "crates");
	const result = spawnSync(
		fs.existsSync(rustup) ? rustup : "cargo",
		["metadata", "--format-version", "1", "--manifest-path", path.join(crates, "Cargo.toml")],
		// cwd = crates/ so cargo reads crates/.cargo/config.toml, like the addon builds do.
		// The JSON is ~1 MB already, which is spawnSync's default buffer.
		{ cwd: crates, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
	);
	if (result.error) throw new Error(`cargo metadata could not run: ${result.error.message}`);
	if (result.status !== 0) {
		const last = result.stderr.trim().split("\n").pop();
		throw new Error(`cargo metadata failed, exit code ${result.status}: ${last}`);
	}
	return JSON.parse(result.stdout);
}

// An annotation on GitHub Actions, so a degraded file shows on the run summary rather than
// scrolling past in a build log that still ends green.
const warn = (message) =>
	console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);

function main() {
	const output = process.argv[2] ? path.resolve(process.argv[2]) : OUTPUT;
	const { entries: npm, skipped } = collectNpmPackages();
	// Throws without cargo: no fallback, see the top of this file.
	const crates = collectCrates(cargoMetadata());
	const missing = [...npm, ...crates].filter((entry) => entry.texts.length === 0);
	if (missing.length > 0) {
		warn(
			`third-party licences: ${missing.length} packages have no licence file; ` +
				"recorded with their declared licence.",
		);
	}

	const text = renderLicenses({ npm, crates });
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, text);
	console.log(
		`Wrote ${path.relative(ROOT, output)} (${Math.round(Buffer.byteLength(text) / 1024)} KB): ` +
			`${npm.length} npm packages, ${crates.length} Rust crates` +
			(skipped.length > 0 ? `; ${skipped.length} lock entries not installed here skipped.` : "."),
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	main();
}
