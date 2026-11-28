import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDirectoryEdition, buildPluginMirror } from "./build-plugin-mirror.mjs";

let dir;

function write(rel, text) {
	const path = join(dir, "plugin", rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-mirror-"));
	write(
		".claude-plugin/plugin.json",
		'{ "name": "openscreen", "version": "2.4.0", "network": { "hosts": ["github.com"] } }\n',
	);
	write(".mcp.json", '{ "mcpServers": {} }\n');
	write("scripts/server.mjs", "#!/usr/bin/env node\n");
	write("evals/README.md", "graders\n");
	write("skills/demo/scripts/capture.mjs", "export {};\n");
	write(
		"skills/demo/SKILL.md",
		[
			"Setup. <!-- full-plugin -->The plugin's launcher starts it.<!-- /full-plugin -->",
			"<!-- directory-plugin",
			"Register it by hand.",
			"-->",
			"End.",
			"",
		].join("\n"),
	);
	writeFileSync(join(dir, "LICENSE"), "MIT\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildPluginMirror", () => {
	it("ships the skills alone in the directory edition", () => {
		const out = join(dir, "out");
		const files = buildPluginMirror(join(dir, "plugin"), out, { license: join(dir, "LICENSE") });
		expect(files).toEqual([".claude-plugin/plugin.json", "LICENSE", "skills/demo/SKILL.md"]);
		expect(JSON.parse(readFileSync(join(out, ".claude-plugin/plugin.json"), "utf8"))).toEqual({
			name: "openscreen",
			version: "2.4.0",
		});
		expect(readFileSync(join(out, "skills/demo/SKILL.md"), "utf8")).toBe(
			"Setup. Register it by hand.\nEnd.\n",
		);
	});

	it("keeps plugin/ as it is, less evals/, in the full edition", () => {
		const out = join(dir, "out");
		const files = buildPluginMirror(join(dir, "plugin"), out, { edition: "full" });
		expect(files).toContain(".mcp.json");
		expect(files).toContain("skills/demo/scripts/capture.mjs");
		expect(existsSync(join(out, "evals"))).toBe(false);
		expect(readFileSync(join(out, "skills/demo/SKILL.md"), "utf8")).toContain(
			"<!-- directory-plugin",
		);
	});

	it("refuses directory text that still points at what the edition drops", () => {
		write("skills/demo/SKILL.md", "Run capture.mjs.\n");
		expect(() => buildPluginMirror(join(dir, "plugin"), join(dir, "out"))).toThrow(
			/still mentions/,
		);
	});

	it("refuses a file the directory does not accept", () => {
		write("skills/demo/tool.py", "print(1)\n");
		expect(() => buildPluginMirror(join(dir, "plugin"), join(dir, "out"))).toThrow(/tool\.py/);
	});

	it("refuses an edition marker left open", () => {
		write("skills/demo/SKILL.md", "<!-- full-plugin -->never closed\n");
		expect(() =>
			buildPluginMirror(join(dir, "plugin"), join(dir, "out"), { edition: "full" }),
		).toThrow(/not closed/);
	});
});

describe("applyDirectoryEdition", () => {
	it("drops full-only text and unwraps the directory text", () => {
		expect(
			applyDirectoryEdition(
				"a<!-- full-plugin -->b<!-- /full-plugin -->c\n<!-- directory-plugin\nd\n-->\ne",
			),
		).toBe("ac\nd\ne");
	});

	it("unwraps inline directory text, as in a table cell", () => {
		expect(
			applyDirectoryEdition(
				"| <!-- full-plugin -->x<!-- /full-plugin --><!-- directory-plugin y --> |\n",
			),
		).toBe("| y |\n");
	});
});
