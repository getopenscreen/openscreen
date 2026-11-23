import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ execFile: vi.fn(), toDip: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: io.execFile }));
vi.mock("electron", () => ({ screen: { screenToDipPoint: io.toDip } }));

import { readX11PointerPosition } from "./x11PointerPosition";

beforeEach(() => {
	io.execFile.mockReset();
	io.toDip.mockReset().mockImplementation(({ x, y }) => ({ x: x / 2, y: y / 2 }));
});

describe("fresh X11 pointer position", () => {
	it("only queries the pointer and converts pixels to DIP, including the real origin", async () => {
		io.execFile.mockImplementation((_command, _args, _options, callback) =>
			callback(null, "X=-1920\nY=540\nSCREEN=0\nWINDOW=0\n"),
		);
		expect(await readX11PointerPosition()).toEqual({ x: -960, y: 270 });
		expect(io.execFile.mock.calls[0].slice(0, 3)).toEqual([
			"xdotool",
			["getmouselocation", "--shell"],
			{ timeout: 250, maxBuffer: 4096, encoding: "utf8" },
		]);
		io.execFile.mockImplementation((_command, _args, _options, callback) =>
			callback(null, "X=0\nY=0\n"),
		);
		expect(await readX11PointerPosition()).toEqual({ x: 0, y: 0 });
	});
	it("does not reuse a cached nonzero point between queries", async () => {
		let x = 100;
		io.execFile.mockImplementation((_command, _args, _options, callback) =>
			callback(null, `X=${x}\nY=200\n`),
		);
		expect(await readX11PointerPosition()).toEqual({ x: 50, y: 100 });
		x = 1800;
		expect(await readX11PointerPosition()).toEqual({ x: 900, y: 100 });
	});
	it("rejects unavailable or malformed queries instead of substituting stale Electron coordinates", async () => {
		io.execFile.mockImplementation((_command, _args, _options, callback) =>
			callback(new Error("ENOENT"), ""),
		);
		await expect(readX11PointerPosition()).rejects.toThrow("ENOENT");
		io.execFile.mockImplementation((_command, _args, _options, callback) =>
			callback(null, "WINDOW=12\n"),
		);
		await expect(readX11PointerPosition()).rejects.toThrow("no position");
	});
});
