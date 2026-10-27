import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	hyprlandSocketPath,
	monitorWorkArea,
	panelPositionNearBar,
	placeHudPanelNearBar,
} from "./hyprland";

const workArea = { x: 0, y: 22, width: 1920, height: 1058 };

describe("panelPositionNearBar", () => {
	it("centres the panel on the bar, just above it", () => {
		const bar = { x: 672, y: 476, width: 576, height: 150 };
		expect(panelPositionNearBar(bar, { width: 382, height: 300 }, workArea, 8)).toEqual({
			x: 769,
			y: 168,
		});
	});

	it("goes below the bar when there is not room above it", () => {
		const bar = { x: 672, y: 40, width: 576, height: 150 };
		expect(panelPositionNearBar(bar, { width: 382, height: 300 }, workArea, 8)).toEqual({
			x: 769,
			y: 198,
		});
	});

	it("stays inside the work area at a screen edge", () => {
		const bar = { x: 1700, y: 900, width: 200, height: 150 };
		expect(panelPositionNearBar(bar, { width: 382, height: 300 }, workArea, 8)).toEqual({
			x: 1920 - 382,
			y: 592,
		});
	});
});

describe("monitorWorkArea", () => {
	it("is the monitor in logical px less what bars reserve", () => {
		expect(
			monitorWorkArea({
				id: 0,
				x: 1920,
				y: 0,
				width: 3072,
				height: 1920,
				scale: 2,
				reserved: [0, 22, 0, 0],
			}),
		).toEqual({ x: 1920, y: 22, width: 1536, height: 938 });
	});
});

describe("hyprlandSocketPath", () => {
	it("is null outside a Hyprland session", () => {
		expect(hyprlandSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBeNull();
	});

	it("points at the instance's request socket", () => {
		expect(
			hyprlandSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000", HYPRLAND_INSTANCE_SIGNATURE: "abc" }),
		).toBe("/run/user/1000/hypr/abc/.socket.sock");
	});
});

describe("placeHudPanelNearBar", () => {
	let server: net.Server | null = null;
	let runtimeDir = "";

	afterEach(async () => {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = null;
		if (runtimeDir) fs.rmSync(runtimeDir, { recursive: true, force: true });
	});

	/** A stand-in for Hyprland's request socket: one reply per command, recorded. */
	async function fakeHyprland(replies: Record<string, string>) {
		runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-hypr-"));
		fs.mkdirSync(path.join(runtimeDir, "hypr", "sig"), { recursive: true });
		const received: string[] = [];
		server = net.createServer((socket) => {
			socket.on("data", (chunk) => {
				const command = chunk.toString("utf8");
				received.push(command);
				const key = command.startsWith("dispatch") ? "dispatch" : command;
				socket.end(replies[key] ?? "unknown request");
			});
		});
		const socketPath = path.join(runtimeDir, "hypr", "sig", ".socket.sock");
		await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
		return { env: { XDG_RUNTIME_DIR: runtimeDir, HYPRLAND_INSTANCE_SIGNATURE: "sig" }, received };
	}

	const clients = JSON.stringify([
		{
			address: "0xbar",
			pid: 42,
			title: "openscreen",
			at: [672, 476],
			size: [576, 150],
			monitor: 2,
		},
		{
			address: "0xpanel",
			pid: 42,
			title: "OpenScreen panel",
			at: [769, 306],
			size: [382, 300],
			monitor: 2,
		},
		{
			address: "0xother",
			pid: 7,
			title: "OpenScreen panel",
			at: [0, 0],
			size: [10, 10],
			monitor: 2,
		},
	]);
	const monitors = JSON.stringify([
		{ id: 2, x: 0, y: 0, width: 3840, height: 2160, scale: 2, reserved: [0, 22, 0, 0] },
	]);

	it("moves this process's panel above its bar", async () => {
		const { env, received } = await fakeHyprland({
			"j/clients": clients,
			"j/monitors": monitors,
			dispatch: "ok",
		});

		const placed = await placeHudPanelNearBar({
			env,
			pid: 42,
			panelTitle: "OpenScreen panel",
			barSize: { width: 576, height: 150 },
			gap: 8,
		});

		expect(placed).toBe(true);
		expect(received).toContain(
			'dispatch hl.dsp.window.move({ x = 769, y = 168, window = "address:0xpanel" })',
		);
	});

	it("falls back to the classic dispatcher on a Hyprland without Lua", async () => {
		const { env, received } = await fakeHyprland({
			"j/clients": clients,
			"j/monitors": monitors,
		});
		// The fake answers both dispatch forms alike, so make only the classic one succeed.
		server?.removeAllListeners("connection");
		server?.on("connection", (socket) => {
			socket.on("data", (chunk) => {
				const command = chunk.toString("utf8");
				received.push(command);
				if (command === "j/clients") socket.end(clients);
				else if (command === "j/monitors") socket.end(monitors);
				else socket.end(command.startsWith("dispatch movewindowpixel") ? "ok" : "error: lua");
			});
		});

		const placed = await placeHudPanelNearBar({
			env,
			pid: 42,
			panelTitle: "OpenScreen panel",
			barSize: { width: 576, height: 150 },
			gap: 8,
		});

		expect(placed).toBe(true);
		expect(received).toContain("dispatch movewindowpixel exact 769 168,address:0xpanel");
	});

	it("moves nothing when the bar is not among this process's windows", async () => {
		const { env, received } = await fakeHyprland({
			"j/clients": clients,
			"j/monitors": monitors,
			dispatch: "ok",
		});

		const placed = await placeHudPanelNearBar({
			env,
			pid: 42,
			panelTitle: "OpenScreen panel",
			barSize: { width: 999, height: 150 },
			gap: 8,
		});

		expect(placed).toBe(false);
		expect(received.some((command) => command.startsWith("dispatch"))).toBe(false);
	});

	it("gives up quietly outside Hyprland", async () => {
		await expect(
			placeHudPanelNearBar({
				env: {},
				pid: 42,
				panelTitle: "OpenScreen panel",
				barSize: { width: 576, height: 150 },
				gap: 8,
			}),
		).resolves.toBe(false);
	});
});
