#!/usr/bin/env node
// Starts OpenScreen's MCP server for the plugin: finds the installed app and runs `<app> mcp`
// with the standard streams handed over as they are. No shell sits in between: a PowerShell
// wrapper swallows the server's input after the first message.
//
// When the app is missing, too old or cannot start, this script answers MCP itself instead of
// failing, with one tool that says what to do. A server that fails is skipped by Claude Code for
// 15 minutes, which would leave the agent with no explanation at all.
//
// Plain Node 18+, no dependency. OPENSCREEN_EXE, when set, is the only location checked.

import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

const RELEASES = "https://github.com/getopenscreen/openscreen/releases/latest";
// `mcp` shipped in 2.1.0. An older app takes the unknown argument for a normal launch and
// opens its window, so it must not be started.
const FIRST_MCP_VERSION = [2, 1, 0];

const checked = [];

// accessSync, not existsSync: existsSync reports a Microsoft Store execution alias as missing.
function runnable(file) {
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function usable(file) {
	checked.push(file);
	return runnable(file);
}

function onPath(name) {
	checked.push(`${name} on the PATH`);
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (dir && runnable(path.join(dir, name))) return path.join(dir, name);
	}
	return null;
}

function appImages() {
	const found = [];
	for (const dir of ["Applications", "Downloads", ""].map((d) => path.join(homedir(), d))) {
		try {
			for (const name of readdirSync(dir)) {
				if (/^Openscreen-Linux-.*\.AppImage$/i.test(name)) found.push(path.join(dir, name));
			}
		} catch {
			// No such folder.
		}
	}
	// Newest version first.
	return found.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

function storeInstall() {
	const query = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"(Get-AppxPackage EtienneLescot.OpenScreen).InstallLocation",
		],
		{ encoding: "utf8", timeout: 10000, windowsHide: true },
	);
	const location = query.stdout?.trim();
	checked.push("Get-AppxPackage EtienneLescot.OpenScreen");
	return location ? path.join(location, "app", "Openscreen.exe") : null;
}

function findExecutable() {
	if (process.env.OPENSCREEN_EXE) {
		return usable(process.env.OPENSCREEN_EXE) ? process.env.OPENSCREEN_EXE : null;
	}
	const env = process.env;
	if (process.platform === "win32") {
		const local = env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
		for (const file of [
			path.join(local, "Programs", "Openscreen", "Openscreen.exe"),
			path.join(env.ProgramFiles ?? "C:\\Program Files", "Openscreen", "Openscreen.exe"),
		]) {
			if (usable(file)) return file;
		}
		const alias = path.join(local, "Microsoft", "WindowsApps", "openscreen.exe");
		const store = onPath("openscreen.exe") ?? (usable(alias) ? alias : null);
		if (store) return store;
		// Slowest lookup last: it starts PowerShell.
		const installed = storeInstall();
		return installed && usable(installed) ? installed : null;
	}
	if (process.platform === "darwin") {
		for (const root of ["/Applications", path.join(homedir(), "Applications")]) {
			const file = path.join(root, "Openscreen.app", "Contents", "MacOS", "Openscreen");
			if (usable(file)) return file;
		}
		return onPath("openscreen");
	}
	return (
		onPath("openscreen") ??
		(usable("/opt/Openscreen/openscreen") ? "/opt/Openscreen/openscreen" : null) ??
		appImages().find(usable) ??
		null
	);
}

// The version inside app.asar, or null where there is none to read (Store alias, AppImage, Nix).
function appVersion(executable) {
	// A package links the executable into the PATH (`/usr/bin/openscreen`): the archive sits
	// beside the file the link points to.
	let real = executable;
	try {
		real = realpathSync(executable);
	} catch {
		// An execution alias does not resolve: look beside it.
	}
	const dir = path.dirname(real);
	for (const asar of [
		path.join(dir, "resources", "app.asar"),
		path.join(dir, "..", "Resources", "app.asar"),
	]) {
		let fd;
		try {
			fd = openSync(asar, "r");
			const head = Buffer.alloc(16);
			readSync(fd, head, 0, 16, 0);
			const header = Buffer.alloc(head.readUInt32LE(12));
			readSync(fd, header, 0, header.length, 16);
			const entry = JSON.parse(header.toString("utf8")).files["package.json"];
			const json = Buffer.alloc(entry.size);
			readSync(fd, json, 0, entry.size, 8 + head.readUInt32LE(4) + Number(entry.offset));
			return JSON.parse(json.toString("utf8")).version;
		} catch {
			// No readable app.asar here: try the next layout.
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	return null;
}

function tooOld(version) {
	const parts = String(version).split(/[.-]/).map(Number);
	for (let i = 0; i < 3; i++) {
		if ((parts[i] || 0) !== FIRST_MCP_VERSION[i]) return (parts[i] || 0) < FIRST_MCP_VERSION[i];
	}
	return false;
}

const INSTALL_STEP = {
	win32:
		"Windows: from the Microsoft Store (`winget install --source msstore OpenScreen`), or the `Openscreen.Setup.<version>.exe` installer from the latest release, run with `/S /currentuser` for a silent install for the current user.",
	darwin:
		"macOS: the `Openscreen-macOS-Apple-Silicon-<version>.dmg` from the latest release, or `-Intel-` on an Intel Mac (`uname -m`). Mount it, copy `Openscreen.app` to `/Applications`, unmount it.",
	linux:
		"Linux: the `.deb`, `.rpm` or `.pacman` package from the latest release for the distribution, or the `.AppImage` made executable.",
};

function helpText(problem) {
	return [
		`OpenScreen's recording and editing tools are not available: ${problem}`,
		`Locations checked: ${checked.join("; ") || "none"}.`,
		"If OpenScreen is installed somewhere else, set the environment variable OPENSCREEN_EXE to its executable in the environment the agent starts from.",
		"Otherwise offer the user to install the latest OpenScreen, a free and open-source screen recorder and video editor, and install it only once they agree:",
		`- ${INSTALL_STEP[process.platform] ?? INSTALL_STEP.linux}`,
		`- Downloads: ${RELEASES} (or \`gh release view --repo getopenscreen/openscreen --json assets\`).`,
		"Then the user runs /reload-plugins, or starts a new session, and OpenScreen's real MCP server connects in place of this notice.",
		"Never stand in for the missing tools by driving OpenScreen's window with computer use or a mouse tool.",
	].join("\n");
}

// `replay`: what the client sent to an app that died before answering, read first.
function serveNotice(problem, replay) {
	const text = helpText(problem);
	const send = (message) =>
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	const input = new PassThrough();
	if (replay?.length) input.write(replay);
	process.stdin.pipe(input);
	const lines = createInterface({ input });
	lines.on("line", (line) => {
		let request;
		try {
			request = JSON.parse(line);
		} catch {
			return send({ id: null, error: { code: -32700, message: "Parse error" } });
		}
		const { id, method, params } = request;
		if (id === undefined || id === null) return; // a notification: nothing to answer
		if (method === "initialize") {
			return send({
				id,
				result: {
					protocolVersion: params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "openscreen-setup", version: "1.0.0" },
					instructions: text,
				},
			});
		}
		if (method === "ping") return send({ id, result: {} });
		if (method === "tools/list") {
			return send({
				id,
				result: {
					tools: [
						{
							name: "openscreenSetup",
							description:
								"OpenScreen is not connected. Call this to learn why and how to install or connect it.",
							inputSchema: { type: "object", properties: {} },
						},
					],
				},
			});
		}
		if (method === "tools/call" && params?.name === "openscreenSetup") {
			return send({ id, result: { content: [{ type: "text", text }] } });
		}
		send({ id, error: { code: -32601, message: `Not available: ${method}` } });
	});
	lines.on("close", () => process.exit(0));
}

const executable = findExecutable();
if (!executable) {
	serveNotice("OpenScreen is not installed, or was not found on this computer.");
} else {
	const version = appVersion(executable);
	if (version && tooOld(version)) {
		serveNotice(
			`OpenScreen ${version} at ${executable} is too old: its MCP server needs version 2.1.0 or later.`,
		);
	} else {
		// The streams go through this process, so that an app that dies before it answers (a
		// library missing, a crash at launch) still leaves the agent the notice. What the client
		// sent until the app's first answer is kept, and replayed to the notice.
		const child = spawn(executable, ["mcp"], {
			stdio: ["pipe", "pipe", "inherit"],
			windowsHide: true,
		});
		const early = [];
		let started = false;
		let failed = false;
		/** What the app wrote before its first whole message: held, so a partial one is never sent. */
		let unsent = Buffer.alloc(0);
		const keep = (chunk) => early.push(chunk);
		process.stdin.on("data", keep);
		process.stdin.pipe(child.stdin);
		// The app gone, its stdin is a broken pipe: what follows goes to the notice instead.
		child.stdin.on("error", () => undefined);
		const isMessage = (line) => {
			try {
				return JSON.parse(line)?.jsonrpc === "2.0";
			} catch {
				return false;
			}
		};
		child.stdout.on("data", (chunk) => {
			if (started) return process.stdout.write(chunk);
			// The server has spoken once a whole line of it parses. Electron on Windows writes a
			// lone line break first, and an app that dies mid-line has not answered at all.
			unsent = Buffer.concat([unsent, chunk]);
			const lines = unsent.toString("utf8").split("\n");
			lines.pop();
			if (!lines.some(isMessage)) return;
			started = true;
			process.stdin.off("data", keep);
			early.length = 0;
			process.stdout.write(unsent);
		});
		const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
		const forward = (signal) => child.kill(signal);
		const fallBack = (problem) => {
			if (failed) return;
			failed = true;
			// No app left to pass a signal to: the default, ending this process, applies again.
			for (const signal of signals) process.off(signal, forward);
			process.stdin.unpipe(child.stdin);
			process.stdin.off("data", keep);
			serveNotice(problem, Buffer.concat(early));
		};
		child.on("error", (error) =>
			fallBack(`OpenScreen at ${executable} could not be started (${error.message}).`),
		);
		child.on("close", (code) => {
			if (failed) return;
			if (!started) {
				fallBack(
					`OpenScreen at ${executable} stopped before its MCP server answered (exit code ${code}). Open OpenScreen once from its icon to see why, or reinstall it.`,
				);
				return;
			}
			// Everything the app wrote reaches the client before this process ends.
			process.stdout.write("", () => process.exit(code ?? 1));
		});
		for (const signal of signals) process.on(signal, forward);
	}
}
