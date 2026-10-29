// `openscreen mcp` sends the GUI's anonymous usage ping: an install driven only by an agent
// counts as active. runCli runs for real here; only Electron and the heavy services around
// the MCP server are stubbed.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendUsagePing, setUsagePingEnabled } from "../usage-ping";
import { runCli } from "./cliMain";

const mocks = vi.hoisted(() => ({
	userData: "",
	isPackaged: false,
	channel: "nsis",
	serve: vi.fn(async (_options: { updateNotice?: string }) => undefined),
	netFetch: vi.fn(),
}));

vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return mocks.isPackaged;
		},
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
	net: { fetch: mocks.netFetch },
	session: {
		defaultSession: {
			setPermissionCheckHandler: vi.fn(),
			setPermissionRequestHandler: vi.fn(),
			setDisplayMediaRequestHandler: vi.fn(),
		},
	},
	systemPreferences: {},
}));
// The real `ownsItsUpdates`, so the notice tests follow the channel rule rather than a copy of it.
vi.mock("../install-channel", async (importOriginal) => ({
	...(await importOriginal<typeof import("../install-channel")>()),
	getInstallChannel: () => mocks.channel,
}));
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
	mocks.isPackaged = false;
	mocks.channel = "nsis";
	mocks.serve.mockClear();
	mocks.netFetch.mockReset();
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

// The user who only reaches OpenScreen through an agent: the notice the cache holds has to reach
// the server it starts, or it is never said.
describe("openscreen mcp update notice", () => {
	function cacheLookup(latestVersion: string, checkedAt = Date.now()) {
		writeFileSync(
			path.join(mocks.userData, "mcp-update-check.json"),
			JSON.stringify({ latestVersion, checkedAt }),
		);
	}

	it("hands the cached newer version to the server on an install that updates itself", async () => {
		mocks.isPackaged = true;
		cacheLookup("9.9.9");
		await runMcp();
		expect(mocks.serve.mock.calls[0][0].updateNotice).toContain(
			"OpenScreen 9.9.9 is available; this is 2.1.0.",
		);
		// The cache is fresh, so the background lookup did not go out.
		expect(mocks.netFetch).not.toHaveBeenCalled();
	});

	it("says nothing from a dev build, which a package manager may own", async () => {
		cacheLookup("9.9.9");
		await runMcp();
		expect(mocks.serve.mock.calls[0][0].updateNotice).toBeUndefined();
	});

	// The Store updates its copy: telling the user to open the app would offer a button that is not
	// there, and looking the release up would be wasted.
	it("says nothing, and looks nothing up, on a Store install", async () => {
		mocks.isPackaged = true;
		mocks.channel = "store";
		// Stale, so a lookup started by mistake would reach the network and fail the assertion.
		cacheLookup("9.9.9", 0);
		await runMcp();
		expect(mocks.serve.mock.calls[0][0].updateNotice).toBeUndefined();
		expect(mocks.netFetch).not.toHaveBeenCalled();
	});
});
