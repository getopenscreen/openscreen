import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

// The plugin's MCP launcher (plugin/scripts/openscreen-mcp.mjs), run as Claude Code runs it:
// `node <script>`, JSON-RPC lines on stdin and stdout.
const LAUNCHER = path.resolve(__dirname, "../../plugin/scripts/openscreen-mcp.mjs");

let dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "openscreen-launcher-"));
	dirs.push(dir);
	return dir;
}

/** A minimal app.asar holding only a package.json at `version`, as the launcher reads it. */
function asarWithVersion(version: string): Buffer {
	const pkg = Buffer.from(JSON.stringify({ version }));
	const json = Buffer.from(
		JSON.stringify({ files: { "package.json": { size: pkg.length, offset: "0" } } }),
	);
	const padded = Math.ceil(json.length / 4) * 4;
	const head = Buffer.alloc(16 + padded);
	head.writeUInt32LE(4, 0);
	head.writeUInt32LE(8 + padded, 4);
	head.writeUInt32LE(4 + padded, 8);
	head.writeUInt32LE(json.length, 12);
	json.copy(head, 16);
	return Buffer.concat([head, pkg]);
}

function startLauncher(env: Record<string, string>, cwd: string) {
	const child = spawn(process.execPath, [LAUNCHER], {
		cwd,
		env: { ...process.env, ...env },
	}) as ChildProcessWithoutNullStreams;
	const lines = createInterface({ input: child.stdout });
	const pending: Array<(line: string) => void> = [];
	lines.on("line", (line) => pending.shift()?.(line));
	const request = (message: object) =>
		new Promise<Record<string, unknown>>((resolve) => {
			pending.push((line) => resolve(JSON.parse(line)));
			child.stdin.write(`${JSON.stringify(message)}\n`);
		});
	const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
	return { child, request, exited };
}

describe("plugin MCP launcher", () => {
	it("hands the streams to `<OPENSCREEN_EXE> mcp` and mirrors its exit code", async () => {
		// The fake app is node itself: the launcher runs `<exe> mcp`, so node runs the file named
		// `mcp` in the working directory. That needs no executable bit and no .cmd on any OS.
		const cwd = tempDir();
		writeFileSync(
			path.join(cwd, "mcp"),
			`if (process.argv.length !== 2) process.exit(9);
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === "quit") process.exit(7);
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echo: message.method } }) + "\\n");
});
`,
		);
		const { child, request, exited } = startLauncher({ OPENSCREEN_EXE: process.execPath }, cwd);

		expect(await request({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: { echo: "tools/list" },
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "quit" })}\n`);
		expect(await exited).toBe(7);
	});

	it("answers MCP itself when OpenScreen is not found", async () => {
		const cwd = tempDir();
		// OPENSCREEN_EXE is the only location checked when set, so a real install on this machine
		// is never found.
		const missing = path.join(cwd, "no-such-openscreen");
		const { child, request, exited } = startLauncher({ OPENSCREEN_EXE: missing }, cwd);

		const init = await request({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
		});
		const result = init.result as { protocolVersion: string; instructions: string };
		expect(result.protocolVersion).toBe("2025-06-18");
		expect(result.instructions).toContain("not installed, or was not found");
		expect(result.instructions).toContain(missing);
		expect(result.instructions).toContain("/reload-plugins");

		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);
		expect(await request({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({
			jsonrpc: "2.0",
			id: 2,
			result: {},
		});

		const list = await request({ jsonrpc: "2.0", id: 3, method: "tools/list" });
		const tools = (list.result as { tools: Array<{ name: string }> }).tools;
		expect(tools.map((tool) => tool.name)).toEqual(["openscreenSetup"]);

		const call = await request({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "openscreenSetup", arguments: {} },
		});
		const content = (call.result as { content: Array<{ text: string }> }).content;
		expect(content[0].text).toBe(result.instructions);

		child.stdin.end();
		expect(await exited).toBe(0);
	});

	it("answers MCP itself, from the first message, when the app dies before answering", async () => {
		const cwd = tempDir();
		// An app that starts, then exits before it reads a line: a crash at launch.
		writeFileSync(path.join(cwd, "mcp"), "process.exit(3);\n");
		const { child, request, exited } = startLauncher({ OPENSCREEN_EXE: process.execPath }, cwd);
		const init = await request({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
		});
		const result = init.result as { serverInfo: { name: string }; instructions: string };
		expect(result.serverInfo.name).toBe("openscreen-setup");
		expect(result.instructions).toContain("stopped before its MCP server answered (exit code 3)");
		const list = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect((list.result as { tools: Array<{ name: string }> }).tools[0].name).toBe(
			"openscreenSetup",
		);
		child.stdin.end();
		expect(await exited).toBe(0);
	});

	it("answers MCP itself when the app dies halfway through its first answer", async () => {
		const cwd = tempDir();
		// An app that reads the first line, starts its answer, then crashes before finishing it.
		writeFileSync(
			path.join(cwd, "mcp"),
			`require("node:readline").createInterface({ input: process.stdin }).once("line", () => {
	process.stdout.write('{"jsonrpc":', () => process.exit(4));
});
`,
		);
		const { child, request, exited } = startLauncher({ OPENSCREEN_EXE: process.execPath }, cwd);
		const init = await request({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
		});
		// The half-written answer never reached the client: the notice answered instead.
		const result = init.result as { serverInfo: { name: string }; instructions: string };
		expect(result.serverInfo.name).toBe("openscreen-setup");
		expect(result.instructions).toContain("exit code 4");
		child.stdin.end();
		expect(await exited).toBe(0);
	});

	it("ends on SIGTERM once it serves the notice for an app that died", async (ctx) => {
		// Windows has no SIGTERM to send a process: there the client closes stdin instead.
		if (process.platform === "win32") return ctx.skip();
		const cwd = tempDir();
		writeFileSync(path.join(cwd, "mcp"), "process.exit(3);\n");
		const { child, request, exited } = startLauncher({ OPENSCREEN_EXE: process.execPath }, cwd);
		await request({ jsonrpc: "2.0", id: 1, method: "ping" });
		// stdin stays open: only the signal can end it.
		child.kill("SIGTERM");
		const ended = await Promise.race([
			exited.then(() => "ended"),
			new Promise((resolve) => setTimeout(() => resolve("still running"), 5_000)),
		]);
		expect(ended).toBe("ended");
		child.kill("SIGKILL");
	});

	it("reads the version beside the file a link on the PATH points to", async (ctx) => {
		const cwd = tempDir();
		const appDir = path.join(cwd, "opt");
		const exe = path.join(appDir, "openscreen");
		mkdirSync(path.join(appDir, "resources"), { recursive: true });
		writeFileSync(path.join(appDir, "resources", "app.asar"), asarWithVersion("2.0.0"));
		writeFileSync(exe, "", { mode: 0o755 });
		const bin = path.join(cwd, "bin");
		mkdirSync(bin);
		try {
			symlinkSync(exe, path.join(bin, "openscreen"));
		} catch {
			// Windows without the right to make links.
			return ctx.skip();
		}
		const { child, request, exited } = startLauncher(
			{ OPENSCREEN_EXE: path.join(bin, "openscreen") },
			cwd,
		);
		const init = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		expect((init.result as { instructions: string }).instructions).toContain("OpenScreen 2.0.0");
		child.stdin.end();
		expect(await exited).toBe(0);
	});

	it("does not start an app older than 2.1.0, which would open its window", async () => {
		// A minimal app.asar beside the executable, holding package.json at version 2.0.0.
		const cwd = tempDir();
		const appDir = path.join(cwd, "app");
		const exe = path.join(appDir, "Openscreen.exe");
		mkdirSync(path.join(appDir, "resources"), { recursive: true });
		writeFileSync(path.join(appDir, "resources", "app.asar"), asarWithVersion("2.0.0"));
		// Never run: an empty file marked executable is enough to be found.
		writeFileSync(exe, "", { mode: 0o755 });

		const { child, request, exited } = startLauncher({ OPENSCREEN_EXE: exe }, cwd);
		const init = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		expect((init.result as { instructions: string }).instructions).toContain("OpenScreen 2.0.0");
		child.stdin.end();
		expect(await exited).toBe(0);
	});
});
