#!/usr/bin/env node
// Builds the tree that plugin-mirror.yml pushes to getopenscreen/openscreen-plugin,
// the repository Claude's plugin directory reads.
//
//   node .github/scripts/build-plugin-mirror.mjs <plugin dir> <out dir> [--edition full|directory]
//
// The directory accepts a local MCP server and any file that is not text, JSON, YAML
// or an image only from Verified organizations. Until getopenscreen is one, the
// mirror carries the "directory" edition: the skills alone, without the server's
// launcher (.mcp.json, scripts/) or the headless capture script. The "full" edition
// is plugin/ as it is, less evals/.
//
// Text that differs between the two editions is marked in the Markdown files:
//
//   <!-- full-plugin -->text of the full plugin only<!-- /full-plugin -->
//   <!-- directory-plugin
//   text of the directory edition only
//   -->
//   <!-- directory-plugin inline text, for a table cell -->
//
// The full plugin is installed straight from plugin/, where the directory text stays
// an HTML comment. The directory edition drops the full-only text and unwraps the
// directory text. Markers stay out of the full edition's way: it is copied as it is.

import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { argv } from "node:process";

const FULL = /<!-- full-plugin -->([\s\S]*?)<!-- \/full-plugin -->\n?/g;
// A block on its own lines, or inline on one line: <!-- directory-plugin text -->.
const DIRECTORY = /<!-- directory-plugin(?:\n([\s\S]*?)-->\n?| (.*?) -->)/g;
const MARKER = /<!-- \/?(full-plugin|directory-plugin)\b/;

// What the directory accepts from an organization that is not Verified.
const ALLOWED = /\.(md|txt|json|ya?ml|png|jpe?g|gif|webp|ico)$/i;
const ALLOWED_NAMES = new Set(["LICENSE", ".gitignore"]);
// Paths the directory edition leaves out: the server's launcher and every script.
const DIRECTORY_DROPS = [".mcp.json", "scripts"];
// Manifest fields the directory refuses from an unverified organization. Claude Code
// reads `network` (the hosts the plugin reaches), but the directory does not list it.
const DIRECTORY_MANIFEST_DROPS = ["network"];
// Words that would point Claude at something the directory edition does not ship.
// The directory also refuses text that registers an MCP server the plugin does not declare,
// or that downloads and runs code without a pinned version and checksum.
const DANGLING = [
	/\bmcp add\b/,
	/\bwinget\b/,
	/\bgh release\b/,
	/releases\/latest/,
	/\/plugin marketplace add\b/,
	/\.mjs\b/,
	/openscreenSetup/,
	/\/reload-plugins/,
	/\b(the|plugin.s) launcher\b/,
	// Pointing at a local server, or at the full plugin that carries one, counts as adding it.
	/\bopenscreen(\.exe)?\s+mcp\b/i,
	/\bfull\s+(OpenScreen\s+)?plugin\b/i,
	/\bconnect\s+OpenScreen\b/i,
];

function walk(dir, root = dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path, root) : [relative(root, path)];
	});
}

function checkMarkers(file, text) {
	const unmatched = text.replace(FULL, "").replace(DIRECTORY, "");
	if (MARKER.test(unmatched)) throw new Error(`${file}: an edition marker is not closed`);
}

export function applyDirectoryEdition(text) {
	return text.replace(FULL, "").replace(DIRECTORY, (_, block, inline) => block ?? inline);
}

/**
 * @param {string} pluginDir plugin/ in the main repository.
 * @param {string} outDir An empty or missing folder to build into.
 * @param {{ edition?: "full" | "directory", license?: string }} options
 * @returns {string[]} The files of the built tree, relative to outDir.
 */
export function buildPluginMirror(pluginDir, outDir, { edition = "directory", license } = {}) {
	if (edition !== "full" && edition !== "directory") throw new Error(`Unknown edition: ${edition}`);
	mkdirSync(outDir, { recursive: true });
	cpSync(pluginDir, outDir, { recursive: true });
	// evals/ is development tooling (prompts, graders, mocks) and does not ship.
	rmSync(join(outDir, "evals"), { recursive: true, force: true });
	if (license) cpSync(license, join(outDir, "LICENSE"));

	for (const file of walk(outDir).filter((f) => f.endsWith(".md"))) {
		checkMarkers(file, readFileSync(join(outDir, file), "utf8"));
	}
	if (edition === "full") return walk(outDir).sort();

	for (const drop of DIRECTORY_DROPS) rmSync(join(outDir, drop), { recursive: true, force: true });
	const manifest = join(outDir, ".claude-plugin", "plugin.json");
	if (existsSync(manifest)) {
		const json = JSON.parse(readFileSync(manifest, "utf8"));
		for (const field of DIRECTORY_MANIFEST_DROPS) delete json[field];
		writeFileSync(manifest, `${JSON.stringify(json, null, "\t")}\n`);
	}
	const skills = join(outDir, "skills");
	if (existsSync(skills)) {
		for (const skill of readdirSync(skills)) {
			rmSync(join(skills, skill, "scripts"), { recursive: true, force: true });
		}
	}

	const problems = [];
	for (const file of walk(outDir)) {
		const path = join(outDir, file);
		const name = file.split(/[\\/]/).pop();
		if (!ALLOWED.test(name) && !ALLOWED_NAMES.has(name)) {
			problems.push(`${file}: not a file the directory accepts from an unverified organization`);
			continue;
		}
		if (!/\.(md|txt|json|ya?ml)$/i.test(name) && !ALLOWED_NAMES.has(name)) continue;
		let text = readFileSync(path, "utf8");
		if (text.startsWith("#!")) problems.push(`${file}: starts with #!`);
		if (name.endsWith(".md")) {
			text = applyDirectoryEdition(text);
			writeFileSync(path, text);
			for (const word of DANGLING) {
				if (word.test(text))
					problems.push(`${file}: still mentions ${word.source}, which this edition does not ship`);
			}
		}
	}
	if (problems.length)
		throw new Error(`The directory edition is not clean:\n${problems.join("\n")}`);
	return walk(outDir).sort();
}

if (import.meta.url === `file://${argv[1]}`) {
	const [, , pluginDir, outDir, ...rest] = argv;
	const at = rest.indexOf("--edition");
	const edition = at >= 0 ? rest[at + 1] : "directory";
	const li = rest.indexOf("--license");
	const license = li >= 0 ? rest[li + 1] : undefined;
	if (!pluginDir || !outDir) {
		console.error(
			"Usage: build-plugin-mirror.mjs <plugin dir> <out dir> [--edition full|directory] [--license <file>]",
		);
		process.exit(2);
	}
	const files = buildPluginMirror(pluginDir, outDir, { edition, license });
	console.log(`Built the ${edition} edition: ${files.length} files`);
	for (const f of files) console.log(`  ${f}`);
}
