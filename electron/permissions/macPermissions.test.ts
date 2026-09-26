import { describe, expect, it, vi } from "vitest";
import {
	createMacPermissions,
	type MacPermissionsDeps,
	type NotedKind,
	permissionSettingsUrl,
	type ScreenProbe,
} from "./macPermissions";

function setup(overrides: Partial<MacPermissionsDeps> = {}) {
	const requested = new Set<NotedKind>();
	const completed = { value: false };
	const deps: MacPermissionsDeps = {
		platform: "darwin",
		macosMajor: 26,
		systemPickerOwnsScreen: () => false,
		requestSystemAudio: vi.fn(async () => undefined),
		probeScreen: vi.fn(async (): Promise<ScreenProbe> => ({ answered: true, granted: false })),
		appScreenGranted: vi.fn(() => false),
		accessibilityTrusted: vi.fn(() => false),
		mediaStatus: vi.fn(() => "not-determined"),
		askForMedia: vi.fn(async () => true),
		raiseScreenPrompt: vi.fn(),
		openExternal: vi.fn(async () => undefined),
		store: {
			hasRequested: (kind) => requested.has(kind),
			markRequested: (kind) => {
				requested.add(kind);
			},
			isCompleted: () => completed.value,
			markCompleted: () => {
				completed.value = true;
			},
		},
		...overrides,
	};
	return { deps, requested, completed, permissions: createMacPermissions(deps) };
}

describe("read", () => {
	it("reports a first run as not requested, not as refused", async () => {
		const { permissions } = setup();

		expect(await permissions.read()).toMatchObject({
			supported: true,
			macosMajor: 26,
			screen: "not-requested",
			screenRequiresRelaunch: false,
			accessibility: "not-requested",
			microphone: "not-requested",
			camera: "not-requested",
		});
	});

	it("reports a refusal once the app has asked", async () => {
		const { permissions, requested } = setup();
		requested.add("screen");
		requested.add("accessibility");

		expect(await permissions.read()).toMatchObject({ screen: "denied", accessibility: "denied" });
	});

	it("trusts the fresh-process read over the app's cached one", async () => {
		// The case the helper exists for: granted in System Settings while the app runs.
		const { permissions } = setup({
			probeScreen: async () => ({ answered: true, granted: true }),
			appScreenGranted: () => false,
		});

		expect(await permissions.read()).toMatchObject({
			screen: "granted",
			screenRequiresRelaunch: true,
		});
	});

	it("needs no relaunch when both reads agree on a grant", async () => {
		const { permissions } = setup({
			probeScreen: async () => ({ answered: true, granted: true }),
			appScreenGranted: () => true,
		});

		expect(await permissions.read()).toMatchObject({
			screen: "granted",
			screenRequiresRelaunch: false,
		});
	});

	it("falls back to the app's own read when the helper cannot answer", async () => {
		const granted = setup({
			probeScreen: async () => ({ answered: false }),
			appScreenGranted: () => true,
		});
		const refused = setup({ probeScreen: async () => ({ answered: false }) });

		expect((await granted.permissions.read()).screen).toBe("granted");
		expect((await refused.permissions.read()).screen).toBe("not-requested");
	});

	it("maps the camera and microphone statuses, restricted included", async () => {
		const { permissions } = setup({
			mediaStatus: (kind) => (kind === "microphone" ? "restricted" : "denied"),
		});

		expect(await permissions.read()).toMatchObject({ microphone: "restricted", camera: "denied" });
	});

	it("reads system audio as granted with the app's own picker, where Screen Recording covers it", async () => {
		const { permissions } = setup();
		expect((await permissions.read()).systemAudio).toBe("granted");
	});

	it("reads everything as granted off macOS without touching the helper", async () => {
		const { permissions, deps } = setup({ platform: "win32" });

		expect(await permissions.read()).toMatchObject({
			supported: false,
			screen: "granted",
			accessibility: "granted",
		});
		expect(deps.probeScreen).not.toHaveBeenCalled();
	});
});

describe("request", () => {
	it("raises the Screen Recording prompt once, noting it first", async () => {
		const { permissions, deps, requested } = setup();

		await permissions.request("screen");

		expect(requested.has("screen")).toBe(true);
		expect(deps.raiseScreenPrompt).toHaveBeenCalledTimes(1);
		expect(deps.openExternal).not.toHaveBeenCalled();
	});

	it("opens System Settings instead once macOS will not prompt again", async () => {
		const { permissions, deps } = setup();

		await permissions.request("screen");
		await permissions.request("screen");

		expect(deps.raiseScreenPrompt).toHaveBeenCalledTimes(1);
		expect(deps.openExternal).toHaveBeenCalledWith(permissionSettingsUrl("screen"));
	});

	it("prompts for Accessibility the first time and opens its pane after", async () => {
		const { permissions, deps } = setup();

		await permissions.request("accessibility");
		expect(deps.accessibilityTrusted).toHaveBeenCalledWith(true);

		await permissions.request("accessibility");
		expect(deps.openExternal).toHaveBeenCalledWith(permissionSettingsUrl("accessibility"));
	});

	it("asks macOS for the microphone while it is undetermined", async () => {
		const { permissions, deps } = setup();

		await permissions.request("microphone");

		expect(deps.askForMedia).toHaveBeenCalledWith("microphone");
	});

	it("sends a refused camera to its pane", async () => {
		const { permissions, deps } = setup({ mediaStatus: () => "denied" });

		await permissions.request("camera");

		expect(deps.askForMedia).not.toHaveBeenCalled();
		expect(deps.openExternal).toHaveBeenCalledWith(permissionSettingsUrl("camera"));
	});

	it("does nothing for a granted or policy-restricted permission", async () => {
		const { permissions, deps } = setup({
			probeScreen: async () => ({ answered: true, granted: true }),
			mediaStatus: () => "restricted",
		});

		await permissions.request("screen");
		await permissions.request("microphone");

		expect(deps.raiseScreenPrompt).not.toHaveBeenCalled();
		expect(deps.askForMedia).not.toHaveBeenCalled();
		expect(deps.openExternal).not.toHaveBeenCalled();
	});
});

describe("shouldShowAtLaunch", () => {
	const granted = { probeScreen: async () => ({ answered: true, granted: true }) as const };

	it("shows while Screen Recording is missing", async () => {
		const { permissions } = setup();
		expect(permissions.shouldShowAtLaunch(await permissions.read())).toBe(true);
	});

	it("comes back after System Settings' Quit & Reopen, mid-onboarding", async () => {
		// The grant is in and the app was relaunched by System Settings: the other rows are
		// still waiting, and the window promised to return.
		const { permissions, requested } = setup({ ...granted, appScreenGranted: () => true });
		requested.add("screen");
		expect(permissions.shouldShowAtLaunch(await permissions.read())).toBe(true);
	});

	it("stays away once the window was closed with the grant in hand", async () => {
		const { permissions, requested } = setup({ ...granted, appScreenGranted: () => true });
		requested.add("screen");
		permissions.noteWindowClosed(await permissions.read());
		expect(permissions.shouldShowAtLaunch(await permissions.read())).toBe(false);
	});

	it("does not count a close without the grant as finishing", async () => {
		const { permissions, completed } = setup();
		permissions.noteWindowClosed(await permissions.read());
		expect(completed.value).toBe(false);
	});

	it("never shows to someone who held the grant before the window existed", async () => {
		const { permissions } = setup({ ...granted, appScreenGranted: () => true });
		expect(permissions.shouldShowAtLaunch(await permissions.read())).toBe(false);
	});

	it("never shows off macOS", async () => {
		const { permissions } = setup({ platform: "linux" });
		expect(permissions.shouldShowAtLaunch(await permissions.read())).toBe(false);
	});
});

describe("with Apple's system picker", () => {
	const picker = { systemPickerOwnsScreen: () => true };

	it("does not require Screen Recording to record", async () => {
		const { permissions } = setup(picker);
		expect(await permissions.read()).toMatchObject({
			screenRequired: false,
			screen: "not-requested",
		});
	});

	it("never offers a relaunch, since nothing reads the app's cached refusal", async () => {
		const { permissions } = setup({
			...picker,
			probeScreen: async () => ({ answered: true, granted: true }),
			appScreenGranted: () => false,
		});
		expect(await permissions.read()).toMatchObject({
			screen: "granted",
			screenRequiresRelaunch: false,
		});
	});

	it("shows the window once, as an offer, while something is still unasked", async () => {
		const { permissions } = setup(picker);
		expect(permissions.shouldShowAtLaunch(await permissions.read())).toBe(true);

		permissions.noteWindowClosed(await permissions.read());
		expect(permissions.shouldShowAtLaunch(await permissions.read())).toBe(false);
	});

	it("stays away from someone who already answered everything", async () => {
		const { permissions, requested } = setup({
			...picker,
			probeScreen: async () => ({ answered: true, granted: true }),
			appScreenGranted: () => true,
			accessibilityTrusted: () => true,
			mediaStatus: () => "denied",
		});
		requested.add("systemAudio");
		expect(permissions.shouldShowAtLaunch(await permissions.read())).toBe(false);
	});

	it("reports system audio as its own permission, never read, only asked", async () => {
		const { permissions, requested } = setup(picker);
		expect((await permissions.read()).systemAudio).toBe("not-requested");

		requested.add("systemAudio");
		// macOS exposes no public read of this grant: asked is all the app can know.
		expect((await permissions.read()).systemAudio).toBe("requested");
	});

	it("raises the system-audio prompt once, then opens its pane", async () => {
		const { permissions, deps } = setup(picker);

		await permissions.request("systemAudio");
		expect(deps.requestSystemAudio).toHaveBeenCalledTimes(1);

		await permissions.request("systemAudio");
		expect(deps.requestSystemAudio).toHaveBeenCalledTimes(1);
		expect(deps.openExternal).toHaveBeenCalledWith(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture",
		);
	});

	it("asks for system audio from the HUD toggle without ever sending anyone to Settings", async () => {
		const { permissions, deps } = setup(picker);

		await permissions.askForSystemAudioOnce();
		await permissions.askForSystemAudioOnce();

		expect(deps.requestSystemAudio).toHaveBeenCalledTimes(1);
		expect(deps.openExternal).not.toHaveBeenCalled();
	});
});

describe("permissionSettingsUrl", () => {
	it("uses the pane anchors that open on every supported macOS", () => {
		expect(permissionSettingsUrl("screen")).toBe(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
		);
		expect(permissionSettingsUrl("accessibility")).toBe(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
		);
	});
});
