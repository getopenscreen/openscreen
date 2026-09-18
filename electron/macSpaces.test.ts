// Regression cover for the app losing its Dock icon, its Cmd+Tab entry and its menu bar on
// macOS: see macSpaces.ts for why `skipTransformProcessType` is the whole fix.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { followAcrossSpaces } from "./macSpaces";

const electronDir = path.dirname(fileURLToPath(import.meta.url));

describe("followAcrossSpaces", () => {
	it("follows across Spaces on macOS without transforming the process type", () => {
		const setVisibleOnAllWorkspaces = vi.fn();
		followAcrossSpaces({ setVisibleOnAllWorkspaces }, "darwin");
		expect(setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
			visibleOnFullScreen: true,
			skipTransformProcessType: true,
		});
	});

	it("does nothing elsewhere", () => {
		const setVisibleOnAllWorkspaces = vi.fn();
		followAcrossSpaces({ setVisibleOnAllWorkspaces }, "win32");
		followAcrossSpaces({ setVisibleOnAllWorkspaces }, "linux");
		expect(setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
	});

	// The defect was three direct calls, each of which silently called `app.dock.hide()`. A new
	// window that copies the old one-liner would bring it straight back, so no main-process
	// source may call the API except through the helper.
	it("is the only caller of setVisibleOnAllWorkspaces in the main process", () => {
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== "native" && entry.name !== "node_modules") walk(full);
				} else if (
					/\.ts$/.test(entry.name) &&
					!/\.test\.ts$/.test(entry.name) &&
					entry.name !== "macSpaces.ts" &&
					/\.setVisibleOnAllWorkspaces\(/.test(fs.readFileSync(full, "utf8"))
				) {
					offenders.push(path.relative(electronDir, full));
				}
			}
		};
		walk(electronDir);
		expect(offenders).toEqual([]);
	});
});
