// Guards the pointer udev rule that the deb, rpm and pacman packages ship for Linux click
// capture, and the install scripts that reload udev so the rule takes effect at once.
//
// Three things here fail silently if they go wrong, which is why they are asserted rather
// than trusted:
//
//   * build/linux/after-*.tpl REPLACE electron-builder's own scripts, they do not extend
//     them. Those templates create /usr/bin/openscreen, set chrome-sandbox's mode and
//     install the AppArmor profile. Ours are copies with a udev block appended, so an
//     electron-builder upgrade that changes the upstream template would leave us shipping
//     the old one, and nothing would say so. The first test is that check.
//   * The rule exists to open mice and touchpads WITHOUT opening keyboards; a rule edited
//     to drop the keyboard exclusion would still "work".
//   * The rule text is also printed in the install docs for AppImage users, who have to
//     copy it by hand.
//
// A text assertion rather than a package build: fpm, rpmbuild and a udev daemon are not
// on every CI runner. That the `fpm` mapping really lands the file at /usr/lib/udev/rules.d
// is checked on the built packages by scripts/verify-linux-package.sh.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { objectBody, stripJson5Comments } from "./macos-floor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RULE_NAME = "70-openscreen-pointer.rules";
const RULE_SOURCE = path.join("build", "linux", RULE_NAME);
const RULE_TARGET = `/usr/lib/udev/rules.d/${RULE_NAME}`;
const UPSTREAM_TEMPLATES = path.join(ROOT, "node_modules", "app-builder-lib", "templates", "linux");

function read(...segments) {
	return readFileSync(path.join(ROOT, ...segments), "utf8");
}

function ruleLines(source) {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe("Linux package install scripts", () => {
	for (const name of ["after-install.tpl", "after-remove.tpl"]) {
		it(`${name} is electron-builder's template verbatim, plus our udev block`, () => {
			const upstream = readFileSync(path.join(UPSTREAM_TEMPLATES, name), "utf8");
			const ours = read("build", "linux", name);
			// If this fails after an electron-builder upgrade: copy the new template over
			// build/linux/<name> and re-append everything from the "# OpenScreen." block on.
			expect(ours.startsWith(upstream.trimEnd())).toBe(true);
			const appended = ours.slice(upstream.trimEnd().length);
			expect(appended).toContain("udevadm control --reload-rules");
			expect(appended).toContain("udevadm trigger --subsystem-match=input --action=change");
			// The udev daemon is absent in a chroot or a container; the install must not fail
			// there, so the calls sit behind a guard and are never fatal.
			expect(appended).toContain("[ -S /run/udev/control ]");
			const appendedLines = appended.split("\n").map((line) => line.trim());
			const guard = appendedLines.findIndex((line) => line.includes("[ -S /run/udev/control ]"));
			const calls = appendedLines.flatMap((line, index) =>
				line.startsWith("udevadm ") ? [{ line, index }] : [],
			);
			expect(calls).toHaveLength(2);
			for (const call of calls) {
				expect(call.line).toMatch(/\|\| true$/);
				// Inside the guard, not merely somewhere in the block.
				expect(call.index).toBeGreaterThan(guard);
			}
		});
	}

	for (const target of ["deb", "pacman", "rpm"]) {
		it(`the ${target} package ships the rule and runs our scripts`, () => {
			const block = objectBody(stripJson5Comments(read("electron-builder.json5")), target);
			expect(block, `no "${target}" block in electron-builder.json5`).toBeTruthy();
			expect(block).toMatch(/"afterInstall"\s*:\s*"build\/linux\/after-install\.tpl"/);
			expect(block).toMatch(/"afterRemove"\s*:\s*"build\/linux\/after-remove\.tpl"/);
			// In the `fpm` arguments, the one key that maps a file into the package.
			const fpm = block.match(/"fpm"\s*:\s*\[([^\]]*)\]/)?.[1];
			expect(fpm, `no "fpm" array in the ${target} block`).toBeTruthy();
			expect(fpm).toContain(`"${RULE_SOURCE}=${RULE_TARGET}"`);
		});
	}
});

describe("pointer udev rule", () => {
	const rule = read(RULE_SOURCE);
	const lines = ruleLines(rule);

	it("sorts before systemd's 73-seat-late.rules, which applies uaccess", () => {
		expect(existsSync(path.join(ROOT, RULE_SOURCE))).toBe(true);
		expect(RULE_NAME.localeCompare("73-seat-late.rules")).toBeLessThan(0);
	});

	it("tags only mice and touchpads, and never a node that reports keyboard keys", () => {
		// Both classes: dropping either line would leave every check below passing.
		for (const kind of ["MOUSE", "TOUCHPAD"]) {
			expect(lines.some((line) => line.includes(`ENV{ID_INPUT_${kind}}=="1"`))).toBe(true);
		}
		for (const line of lines) {
			expect(line).toContain('SUBSYSTEM=="input"');
			expect(line).toContain('KERNEL=="event*"');
			expect(line).toContain('ENV{ID_INPUT_KEY}!="1"');
			expect(line).toMatch(/ENV\{ID_INPUT_(MOUSE|TOUCHPAD)\}=="1"/);
			expect(line).toContain('TAG+="uaccess"');
			expect(line).not.toMatch(/GROUP|MODE|OWNER/);
		}
	});

	it("is printed verbatim in the install docs, for the AppImage", () => {
		const docs = read("website", "docs", "installation.md");
		for (const line of lines) {
			expect(docs).toContain(line);
		}
		expect(docs).toContain(`/etc/udev/rules.d/${RULE_NAME}`);
	});

	it("is installed by the Nix package, where the NixOS module picks it up", () => {
		expect(read("nix", "package.nix")).toContain(`$out/lib/udev/rules.d/${RULE_NAME}`);
		expect(read("nix", "module.nix")).toMatch(
			/services\.udev\.packages\s*=\s*\[\s*cfg\.package\s*\]/,
		);
	});
});
