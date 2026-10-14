import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import { appBundleOf, openGuiFromCli } from "./openGui";

describe("appBundleOf", () => {
	it("climbs from Contents/MacOS to the .app bundle", () => {
		expect(appBundleOf("/Applications/Openscreen.app/Contents/MacOS/Openscreen")).toBe(
			"/Applications/Openscreen.app",
		);
		expect(appBundleOf("/Users/me/Downloads/Open Screen.app/Contents/MacOS/Openscreen")).toBe(
			"/Users/me/Downloads/Open Screen.app",
		);
	});

	it("refuses anything that is not an executable inside an .app", () => {
		// A dev run is node_modules' Electron.app driving this repo: it is an .app, but not ours
		// to launch, and openGuiFromCli is only reached from a packaged CLI run anyway.
		expect(appBundleOf("/usr/local/bin/openscreen")).toBeNull();
		expect(appBundleOf("/Applications/Openscreen.app/Contents/Resources/openscreen")).toBeNull();
		expect(appBundleOf("/opt/Openscreen/Contents/MacOS/Openscreen")).toBeNull();
	});
});

describe("openGuiFromCli", () => {
	beforeEach(() => {
		spawn.mockReset();
		spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
	});

	it("opens the bundle as a new instance, detached", () => {
		openGuiFromCli("/Applications/Openscreen.app/Contents/MacOS/Openscreen");
		expect(spawn).toHaveBeenCalledWith("open", ["-n", "/Applications/Openscreen.app"], {
			detached: true,
			stdio: "ignore",
		});
	});

	it("does nothing outside a bundle", () => {
		openGuiFromCli("/usr/local/bin/openscreen");
		expect(spawn).not.toHaveBeenCalled();
	});
});
