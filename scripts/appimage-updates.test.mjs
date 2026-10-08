import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { blake2b } = require("@noble/hashes/blake2.js");
const { appendBlockmap } = require("app-builder-lib/out/targets/differentialUpdateInfoBuilder");
const { artifactBuildCompleted, afterAllArtifactBuild } = require("./appimage-updates.cjs");
const temporaryDirectories = [];
const UPDATE_OFFSET = 1536;
const UPDATE_SIZE = 1024;

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

// A small ELF header, section table and reserved runtime area, followed by payload bytes.
// Real legacy/static runtimes use these same ELF32/64 layouts; no Linux executable is needed.
function runtimeFixture({
	is64 = true,
	sectionName = ".upd_info",
	sectionSize = UPDATE_SIZE,
	updateInformation = "",
} = {}) {
	const buffer = Buffer.alloc(4096, 0x5a);
	buffer.fill(0, 0, 64);
	Buffer.from("7f454c46", "hex").copy(buffer);
	buffer[4] = is64 ? 2 : 1;
	buffer[5] = 1;
	Buffer.from("414902", "hex").copy(buffer, 8);
	const tableOffset = 512;
	const entrySize = is64 ? 64 : 40;
	if (is64) buffer.writeBigUInt64LE(BigInt(tableOffset), 40);
	else buffer.writeUInt32LE(tableOffset, 32);
	buffer.writeUInt16LE(entrySize, is64 ? 58 : 46);
	buffer.writeUInt16LE(3, is64 ? 60 : 48);
	buffer.writeUInt16LE(1, is64 ? 62 : 50);
	buffer.fill(0, tableOffset, tableOffset + entrySize * 3);
	const names = Buffer.from(`\0.shstrtab\0${sectionName}\0`);
	names.copy(buffer, 1024);
	const setSection = (index, name, offset, size) => {
		const at = tableOffset + index * entrySize;
		buffer.writeUInt32LE(name, at);
		if (is64) {
			buffer.writeBigUInt64LE(BigInt(offset), at + 24);
			buffer.writeBigUInt64LE(BigInt(size), at + 32);
		} else {
			buffer.writeUInt32LE(offset, at + 16);
			buffer.writeUInt32LE(size, at + 20);
		}
	};
	setSection(1, 1, 1024, names.length);
	setSection(2, 11, UPDATE_OFFSET, sectionSize);
	buffer.fill(0, UPDATE_OFFSET, UPDATE_OFFSET + UPDATE_SIZE);
	Buffer.from(updateInformation).copy(buffer, UPDATE_OFFSET);
	return buffer;
}

async function artifact({ version = "2.0.1", filename, ...fixtureOptions } = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-appimage-update-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, filename ?? `Openscreen-Linux-${version}.AppImage`);
	fs.writeFileSync(file, runtimeFixture(fixtureOptions));
	const updateInfo = await appendBlockmap(file);
	return {
		file,
		target: { name: "appImage" },
		packager: { appInfo: { version } },
		updateInfo,
	};
}

describe("AppImage standard update information", () => {
	it.each([
		true,
		false,
	])("preserves payload and refreshes all update hashes (ELF64=%s)", async (is64) => {
		const event = await artifact({ is64 });
		const before = fs.readFileSync(event.file);
		const beforeInfo = event.updateInfo;
		const payloadSize = before.length - beforeInfo.blockMapSize - 4;
		const zsync = vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
			const finalBytes = fs.readFileSync(event.file);
			expect(event.updateInfo.sha512).toBe(
				createHash("sha512").update(finalBytes).digest("base64"),
			);
			fs.writeFileSync(`${event.file}.zsync`, "generated from final bytes");
		});

		await artifactBuildCompleted(event);

		const after = fs.readFileSync(event.file);
		expect(after.subarray(0, UPDATE_OFFSET)).toEqual(before.subarray(0, UPDATE_OFFSET));
		expect(after.subarray(UPDATE_OFFSET + UPDATE_SIZE, payloadSize)).toEqual(
			before.subarray(UPDATE_OFFSET + UPDATE_SIZE, payloadSize),
		);
		const information = after.subarray(UPDATE_OFFSET, UPDATE_OFFSET + UPDATE_SIZE);
		const end = information.indexOf(0);
		expect(information.subarray(0, end).toString()).toBe(
			"gh-releases-zsync|getopenscreen|openscreen|latest|Openscreen-Linux-*.AppImage.zsync",
		);
		expect(information.subarray(end).every((byte) => byte === 0)).toBe(true);
		expect(event.updateInfo).not.toBe(beforeInfo);
		expect(event.updateInfo.sha512).not.toBe(beforeInfo.sha512);
		expect(event.updateInfo.size).toBe(after.length);
		expect(after.readUInt32BE(after.length - 4)).toBe(event.updateInfo.blockMapSize);
		const map = JSON.parse(
			inflateRawSync(after.subarray(payloadSize, after.length - 4)).toString(),
		);
		expect(map.files[0].sizes).toEqual([payloadSize]);
		expect(map.files[0].checksums).toEqual([
			Buffer.from(blake2b(after.subarray(0, payloadSize), { dkLen: 18 })).toString("base64"),
		]);
		expect(zsync).toHaveBeenCalledWith(
			"zsyncmake",
			[
				"-e",
				"-f",
				"Openscreen-Linux-2.0.1.AppImage",
				"-u",
				"https://github.com/getopenscreen/openscreen/releases/download/v2.0.1/Openscreen-Linux-2.0.1.AppImage",
				"-o",
				`${event.file}.zsync`,
				event.file,
			],
			{ stdio: "inherit" },
		);
		expect(
			afterAllArtifactBuild({
				artifactPaths: [event.file, path.join(path.dirname(event.file), "other.deb")],
			}),
		).toEqual([`${event.file}.zsync`]);
	});

	it("leaves RC discovery empty while generating a tagged zsync URL", async () => {
		const event = await artifact({
			version: "2.1.0-rc.2",
			filename: "Openscreen-Linux-2.1.0-rc.2 beta.AppImage",
			updateInformation: "gh-releases-zsync|getopenscreen|openscreen|latest-all|*.AppImage.zsync",
		});
		const zsync = vi.spyOn(childProcess, "execFileSync").mockImplementation(() => undefined);
		await artifactBuildCompleted(event);
		const after = fs.readFileSync(event.file);
		// latest-all / latest-pre may select a helper-only release without an AppImage asset.
		expect(
			after.subarray(UPDATE_OFFSET, UPDATE_OFFSET + UPDATE_SIZE).every((byte) => byte === 0),
		).toBe(true);
		expect(event.updateInfo.size).toBe(after.length);
		expect(event.updateInfo.sha512).toBe(createHash("sha512").update(after).digest("base64"));
		expect(zsync.mock.calls[0][1]).toContain(
			"https://github.com/getopenscreen/openscreen/releases/download/v2.1.0-rc.2/Openscreen-Linux-2.1.0-rc.2%20beta.AppImage",
		);
	});

	it.each([
		["a missing reserved section", { sectionName: ".other" }, /no reserved .upd_info/],
		["an undersized reserved section", { sectionSize: 8 }, /does not fit/],
		["an out-of-range reserved section", { sectionSize: 4096 }, /beyond the artifact/],
	])("rejects %s before changing any bytes", async (_label, fixtureOptions, message) => {
		const event = await artifact(fixtureOptions);
		const before = fs.readFileSync(event.file);
		const zsync = vi.spyOn(childProcess, "execFileSync");
		await expect(artifactBuildCompleted(event)).rejects.toThrow(message);
		expect(fs.readFileSync(event.file)).toEqual(before);
		expect(zsync).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		-1,
		0,
		1,
		Number.MAX_SAFE_INTEGER,
	])("rejects invalid or stale blockmap size %s before changing any bytes", async (blockMapSize) => {
		const event = await artifact();
		event.updateInfo.blockMapSize = blockMapSize;
		const before = fs.readFileSync(event.file);
		await expect(artifactBuildCompleted(event)).rejects.toThrow(/blockmap/);
		expect(fs.readFileSync(event.file)).toEqual(before);
	});

	it.each([
		{ target: null },
		{ target: { name: "deb" }, file: "missing.deb" },
		{ target: { name: "appImage" }, file: "missing.blockmap" },
	])("ignores an unrelated artifact %j", async (event) => {
		const zsync = vi.spyOn(childProcess, "execFileSync");
		await artifactBuildCompleted(event);
		expect(zsync).not.toHaveBeenCalled();
	});
});
