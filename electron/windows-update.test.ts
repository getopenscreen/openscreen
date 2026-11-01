import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installWindowsUpdate } from "./windows-update";

const mocks = vi.hoisted(() => ({
	quit: vi.fn(),
	window: {
		isEnabled: vi.fn(() => true),
		setEnabled: vi.fn(),
		isDestroyed: vi.fn(() => false),
	},
}));
vi.mock("electron", () => ({
	app: { quit: mocks.quit },
	BrowserWindow: { getAllWindows: () => [mocks.window] },
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("installWindowsUpdate", () => {
	let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };
	let download: ReturnType<typeof vi.fn<() => Promise<string[]>>>;
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.window.isEnabled.mockReturnValue(true);
		mocks.window.isDestroyed.mockReturnValue(false);
		child = Object.assign(new EventEmitter(), { unref: vi.fn() });
		vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
		download = vi.fn(async () => ["C:\\update\\installer.exe"]);
	});

	it("retains the app and controls after No, and permits retry", async () => {
		const install = installWindowsUpdate(download);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		expect(mocks.quit).not.toHaveBeenCalled();
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false]]);
		expect(child.unref).not.toHaveBeenCalled();
		child.emit("exit", 1223);
		await install;
		expect(mocks.quit).not.toHaveBeenCalled();
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false], [true]]);
		const retry = installWindowsUpdate(download);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
		child.emit("exit", 1223);
		await retry;
	});

	it("quits normally only after elevation succeeds, with controls disabled until quit", async () => {
		const install = installWindowsUpdate(download);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		expect(mocks.quit).not.toHaveBeenCalled();
		child.emit("exit", 0);
		await install;
		expect(mocks.quit).toHaveBeenCalledOnce();
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false]]);
	});

	it("passes the verified installer as a literal without shell interpolation", async () => {
		download.mockResolvedValue(["C:\\update\\it's $a`b.exe"]);
		const install = installWindowsUpdate(download);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		const [executable, args, options] = vi.mocked(spawn).mock.calls[0];
		expect(executable).toMatch(/powershell\.exe$/);
		expect(args).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			expect.any(String),
		]);
		const script = Buffer.from((args as string[])[4], "base64").toString("utf16le");
		expect(script).toContain("-FilePath 'C:\\update\\it''s $a`b.exe'");
		expect(script).toContain("@('--updated', '/S', '--force-run') -Verb RunAs");
		expect(script).toContain("NativeErrorCode -eq 1223");
		expect(options).toEqual({ detached: false, stdio: "ignore", windowsHide: true });
		child.emit("exit", 1223);
		await install;
	});

	it("restores an already disabled window after a spawn error", async () => {
		mocks.window.isEnabled.mockReturnValue(false);
		const install = installWindowsUpdate(download);
		const rejection = expect(install).rejects.toThrow("spawn failed");
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		child.emit("error", new Error("spawn failed"));
		await rejection;
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false], [false]]);
		expect(mocks.quit).not.toHaveBeenCalled();
	});

	it("restores the app if verifying the cached download fails", async () => {
		download.mockRejectedValue(new Error("checksum mismatch"));
		await expect(installWindowsUpdate(download)).rejects.toThrow("checksum mismatch");
		expect(spawn).not.toHaveBeenCalled();
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false], [true]]);
	});

	it("refuses to launch without a verified installer", async () => {
		download.mockResolvedValue([]);
		await expect(installWindowsUpdate(download)).rejects.toThrow("No downloaded");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("reports failure without quitting or touching a closed window", async () => {
		const install = installWindowsUpdate(download);
		const rejection = expect(install).rejects.toThrow("failed (1)");
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		mocks.window.isDestroyed.mockReturnValue(true);
		child.emit("exit", 1);
		await rejection;
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false]]);
		expect(mocks.quit).not.toHaveBeenCalled();
	});
});
