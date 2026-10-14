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
	let child: { handlers: Map<string, () => void>; on: unknown; unref: unknown } | undefined;

	beforeEach(() => {
		spawn.mockReset();
		spawn.mockImplementation(() => {
			const handlers = new Map<string, () => void>();
			child = {
				handlers,
				on: vi.fn((event, handler) => handlers.set(event, handler)),
				unref: vi.fn(),
			};
			return child;
		});
	});

	// Each test launches at its own time, far from the others, so the launch guard never
	// carries over between them.
	it("opens the bundle as a new instance, detached", () => {
		openGuiFromCli("/Applications/Openscreen.app/Contents/MacOS/Openscreen", 1_000_000);
		expect(spawn).toHaveBeenCalledWith("open", ["-n", "/Applications/Openscreen.app"], {
			detached: true,
			stdio: "ignore",
		});
	});

	it("runs afterLaunch once open is done, and not before", () => {
		const afterLaunch = vi.fn();
		openGuiFromCli(
			"/Applications/Openscreen.app/Contents/MacOS/Openscreen",
			1_500_000,
			afterLaunch,
		);
		expect(afterLaunch).not.toHaveBeenCalled();
		child?.handlers.get("exit")?.();
		expect(afterLaunch).toHaveBeenCalledTimes(1);
	});

	it("does nothing outside a bundle", () => {
		openGuiFromCli("/usr/local/bin/openscreen", 2_000_000);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("drops a second activate that comes right after a launch", () => {
		const exe = "/Applications/Openscreen.app/Contents/MacOS/Openscreen";
		openGuiFromCli(exe, 3_000_000);
		openGuiFromCli(exe, 3_000_500);
		openGuiFromCli(exe, 3_001_999);
		expect(spawn).toHaveBeenCalledTimes(1);
		openGuiFromCli(exe, 3_002_000);
		expect(spawn).toHaveBeenCalledTimes(2);
	});
});
