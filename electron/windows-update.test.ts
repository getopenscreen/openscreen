import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	let child: EventEmitter & { stderr: PassThrough; unref: ReturnType<typeof vi.fn> };
	let download: ReturnType<typeof vi.fn<() => Promise<string[]>>>;
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("process", { ...process, resourcesPath: "C:\\OpenScreen\\resources" });
		mocks.window.isEnabled.mockReturnValue(true);
		mocks.window.isDestroyed.mockReturnValue(false);
		child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), unref: vi.fn() });
		vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
		download = vi.fn(async () => ["C:\\update\\installer.exe"]);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("retains the app and controls after No, and permits retry", async () => {
		const install = installWindowsUpdate(download);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		expect(mocks.quit).not.toHaveBeenCalled();
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false]]);
		expect(child.unref).not.toHaveBeenCalled();
		child.stderr.write("C:\\update\\installer.exe could not be launched: 12");
		child.stderr.write("23\r\n");
		child.emit("close", 1);
		await install;
		expect(mocks.quit).not.toHaveBeenCalled();
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false], [true]]);
		const retry = installWindowsUpdate(download);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
		child.stderr.write("C:\\update\\installer.exe could not be launched: 1223\r\n");
		child.emit("close", 1);
		await retry;
	});

	it("quits normally only after elevation succeeds, with controls disabled until quit", async () => {
		const install = installWindowsUpdate(download);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		expect(mocks.quit).not.toHaveBeenCalled();
		child.emit("exit", 0);
		expect(mocks.quit).not.toHaveBeenCalled();
		child.emit("close", 0);
		await install;
		expect(mocks.quit).toHaveBeenCalledOnce();
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false]]);
	});

	it("passes the verified installer as a literal without shell interpolation", async () => {
		download.mockResolvedValue(["C:\\update\\it's $a`b.exe"]);
		const install = installWindowsUpdate(download);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		const [executable, args, options] = vi.mocked(spawn).mock.calls[0];
		expect(executable).toBe(path.join(process.resourcesPath, "elevate.exe"));
		expect(args).toEqual(["C:\\update\\it's $a`b.exe", "--updated", "/S", "--force-run"]);
		expect(options).toEqual({
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		child.emit("close", 0);
		await install;
	});

	it.each([
		[1, ""],
		[1, "installer.exe could not be launched: 12230\r\n"],
		[1223, "installer.exe could not be launched: 1223\r\n"],
		[null, "installer.exe could not be launched: 1223\r\n"],
	])("reports an unrecognised helper result (%s, %s)", async (exitCode, stderr) => {
		const install = installWindowsUpdate(download);
		const rejection = expect(install).rejects.toThrow("Windows update elevation failed");
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		child.stderr.write(stderr);
		child.emit("close", exitCode);
		await rejection;
		expect(mocks.quit).not.toHaveBeenCalled();
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false], [true]]);
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
		const rejection = expect(install).rejects.toThrow(
			"failed (1): installer.exe could not be launched: 3",
		);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		mocks.window.isDestroyed.mockReturnValue(true);
		child.stderr.write("installer.exe could not be launched: 3\r\n");
		child.emit("close", 1);
		await rejection;
		expect(mocks.window.setEnabled.mock.calls).toEqual([[false]]);
		expect(mocks.quit).not.toHaveBeenCalled();
	});
});
