// `openscreen mcp` sends the GUI's anonymous usage ping: an install driven only by an agent
// counts as active. runCli runs for real here; only Electron and the heavy services around
// the MCP server are stubbed.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendUsagePing, setUsagePingEnabled } from "../usage-ping";
import { runCli } from "./cliMain";

const mocks = vi.hoisted(() => ({ userData: "", serve: vi.fn(async () => undefined) }));

vi.mock("electron", () => ({
	app: {
		getPath: () => mocks.userData,
		getVersion: () => "2.1.0",
		exit: vi.fn(),
		on: vi.fn(),
		whenReady: () => Promise.resolve(),
		commandLine: { appendSwitch: vi.fn() },
	},
	BrowserWindow: class {},
	ipcMain: { handle: vi.fn() },
	Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
	session: {
		defaultSession: {
			setPermissionCheckHandler: vi.fn(),
			setPermissionRequestHandler: vi.fn(),
			setDisplayMediaRequestHandler: vi.fn(),
		},
	},
	systemPreferences: {},
}));
vi.mock("../install-channel", () => ({ getInstallChannel: () => "nsis" }));
vi.mock("../ipc/handlers", () => ({
	getSelectedDesktopSource: () => null,
	registerIpcHandlers: () => ({ agentServices: {} }),
}));
vi.mock("../mcp/hidden-video", () => ({ openVideoInHiddenWindow: vi.fn() }));
vi.mock("../mcp/stdio-server", () => ({ serveMcpOverStdio: mocks.serve }));
vi.mock("../stt", () => ({ registerSttIpc: vi.fn(), shutdownStt: vi.fn() }));
vi.mock("../windows", () => ({ createRunnerWindow: vi.fn() }));
vi.mock("./runnerHost", () => ({ createRunnerHost: () => ({}) }));
vi.mock("./sessionData", () => ({ isolateCliSessionData: vi.fn() }));

const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));
const savedConsole = { ...console };
let stdoutWrite: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	mocks.userData = mkdtempSync(path.join(os.tmpdir(), "cli-usage-ping-"));
	mocks.serve.mockClear();
	fetchMock.mockClear();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("DO_NOT_TRACK", "");
	vi.stubEnv("CI", "");
	// The darwin branch touches the dock and menu, which this test is not about.
	vi.spyOn(process, "platform", "get").mockReturnValue("linux");
	// runCli's fatal-error handlers would outlive the test and exit the worker.
	vi.spyOn(process, "on").mockReturnValue(process);
	stdoutWrite = vi.spyOn(process.stdout, "write");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	Object.assign(console, savedConsole);
	rmSync(mocks.userData, { recursive: true, force: true });
});

/** Runs `openscreen mcp` up to the point its server is listening and the ping went out. */
async function runMcp() {
	runCli({ kind: "mcp" });
	await vi.waitFor(() => expect(mocks.serve).toHaveBeenCalled());
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("openscreen mcp usage ping", () => {
	it("pings once, as the mcp surface, and writes nothing to stdout", async () => {
		await runMcp();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
		expect(body.properties).toMatchObject({
			version: "2.1.0",
			channel: "nsis",
			surface: "mcp",
		});
		expect(stdoutWrite).not.toHaveBeenCalled();
	});

	it("honours the tray toggle and DO_NOT_TRACK", async () => {
		setUsagePingEnabled(mocks.userData, false);
		await runMcp();
		setUsagePingEnabled(mocks.userData, true);
		vi.stubEnv("DO_NOT_TRACK", "1");
		await runMcp();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("counts a day the app already counted only once", async () => {
		const facts = { version: "2.1.0", os: "linux", arch: "x64", channel: "nsis" } as const;
		await sendUsagePing(mocks.userData, { ...facts, surface: "app" });
		fetchMock.mockClear();
		await runMcp();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
