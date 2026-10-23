import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { createZip } from "./zip";

/** Reads the archive back through its central directory, the way an unzip tool does. */
function readZip(zip: Buffer) {
	const end = zip.length - 22;
	expect(zip.readUInt32LE(end)).toBe(0x06054b50);
	const count = zip.readUInt16LE(end + 10);
	let at = zip.readUInt32LE(end + 16);
	const files: Record<string, string> = {};
	for (let i = 0; i < count; i++) {
		expect(zip.readUInt32LE(at)).toBe(0x02014b50);
		const crc = zip.readUInt32LE(at + 16);
		const size = zip.readUInt32LE(at + 20);
		const nameLength = zip.readUInt16LE(at + 28);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.toString("utf-8", at + 46, at + 46 + nameLength);
		expect(zip.readUInt32LE(local)).toBe(0x04034b50);
		const start = local + 30 + zip.readUInt16LE(local + 26);
		const data = zlib.inflateRawSync(zip.subarray(start, start + size));
		expect(zlib.crc32(data)).toBe(crc);
		files[name] = data.toString("utf-8");
		at += 46 + nameLength;
	}
	return files;
}

describe("createZip", () => {
	it("round-trips every entry", () => {
		const big = "line\n".repeat(100_000);
		const zip = createZip([
			{ name: "diagnostic.json", data: Buffer.from('{"a":1}') },
			{ name: "main.log", data: Buffer.from(big) },
			{ name: "empty.log", data: Buffer.alloc(0) },
			{ name: "é.txt", data: Buffer.from("ü") },
		]);

		expect(readZip(zip)).toEqual({
			"diagnostic.json": '{"a":1}',
			"main.log": big,
			"empty.log": "",
			"é.txt": "ü",
		});
		expect(zip.length).toBeLessThan(big.length / 10);
	});

	it("opens with the system unzip, where there is one", () => {
		let unzip = true;
		try {
			execFileSync("unzip", ["-v"], { stdio: "ignore" });
		} catch {
			unzip = false;
		}
		if (!unzip) return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-zip-"));
		try {
			const file = path.join(dir, "bundle.zip");
			fs.writeFileSync(file, createZip([{ name: "main.log", data: Buffer.from("hello\n") }]));
			execFileSync("unzip", ["-tq", file], { stdio: "ignore" });
			expect(execFileSync("unzip", ["-p", file, "main.log"], { encoding: "utf-8" })).toBe(
				"hello\n",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
