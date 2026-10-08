// Standard AppImage update information complements electron-updater's embedded blockmap.
// artifactBuildCompleted runs before artifactCreated, where electron-builder schedules the feed
// and upload. Mutating the file after that point would leave latest-linux.yml's hashes stale.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPOSITORY = "getopenscreen/openscreen";
const ASSET_PATTERN = "Openscreen-Linux-*.AppImage.zsync";

function readBuffer(fd, offset, length, limit) {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length < 0 ||
		offset + length > limit
	) {
		throw new Error("AppImage ELF section extends beyond the artifact");
	}
	const buffer = Buffer.alloc(length);
	let read = 0;
	while (read < length) {
		const count = fs.readSync(fd, buffer, read, length - read, offset + read);
		if (count === 0) throw new Error("AppImage ELF section is truncated");
		read += count;
	}
	return buffer;
}

function findUpdateSection(fd, payloadSize) {
	const header = readBuffer(fd, 0, 64, payloadSize);
	if (
		header.subarray(0, 4).toString("hex") !== "7f454c46" ||
		header.subarray(8, 11).toString("hex") !== "414902" ||
		![1, 2].includes(header[4]) ||
		header[5] !== 1
	) {
		throw new Error("Expected a little-endian ELF32 or ELF64 type-2 AppImage");
	}
	const is64 = header[4] === 2;
	const tableOffset = is64 ? Number(header.readBigUInt64LE(40)) : header.readUInt32LE(32);
	const entrySize = header.readUInt16LE(is64 ? 58 : 46);
	const entryCount = header.readUInt16LE(is64 ? 60 : 48);
	const namesIndex = header.readUInt16LE(is64 ? 62 : 50);
	if (entrySize !== (is64 ? 64 : 40) || namesIndex >= entryCount) {
		throw new Error("AppImage ELF section table is invalid");
	}
	const table = readBuffer(fd, tableOffset, entrySize * entryCount, payloadSize);
	const section = (index) => {
		const offset = index * entrySize;
		return {
			name: table.readUInt32LE(offset),
			offset: is64 ? Number(table.readBigUInt64LE(offset + 24)) : table.readUInt32LE(offset + 16),
			size: is64 ? Number(table.readBigUInt64LE(offset + 32)) : table.readUInt32LE(offset + 20),
		};
	};
	const namesSection = section(namesIndex);
	const names = readBuffer(fd, namesSection.offset, namesSection.size, payloadSize);
	for (let index = 0; index < entryCount; index++) {
		const entry = section(index);
		const end = names.indexOf(0, entry.name);
		if (end < 0) throw new Error("AppImage ELF section name is invalid");
		if (names.subarray(entry.name, end).toString("utf8") === ".upd_info") {
			// Validate the complete reserved range before changing any bytes.
			readBuffer(fd, entry.offset, entry.size, payloadSize);
			return entry;
		}
	}
	throw new Error("AppImage runtime has no reserved .upd_info section");
}

exports.artifactBuildCompleted = async function artifactBuildCompleted(event) {
	if (event.target?.name !== "appImage" || !event.file?.endsWith(".AppImage")) return;
	const version = event.packager.appInfo.version;
	// Stable installs discover stable releases. AppImageUpdate's latest-all / latest-pre
	// choose a release before matching assets, so helper-only prereleases such as
	// v0.0.0-stt-models would break RC discovery. Leave RCs without automatic discovery;
	// their tagged .zsync still supports an explicitly selected update.
	const information = version.includes("-")
		? Buffer.alloc(0)
		: Buffer.from(`gh-releases-zsync|${REPOSITORY.replace("/", "|")}|latest|${ASSET_PATTERN}`);
	const blockMapSize = event.updateInfo?.blockMapSize;
	const fd = fs.openSync(event.file, "r+");
	try {
		const size = fs.fstatSync(fd).size;
		if (!Number.isSafeInteger(blockMapSize) || blockMapSize <= 0 || blockMapSize + 4 >= size) {
			throw new Error("AppImage embedded blockmap size is invalid");
		}
		const trailer = readBuffer(fd, size - 4, 4, size);
		if (trailer.readUInt32BE(0) !== blockMapSize) {
			throw new Error("AppImage embedded blockmap trailer disagrees with update metadata");
		}
		const payloadSize = size - blockMapSize - 4;
		const section = findUpdateSection(fd, payloadSize);
		if (information.length >= section.size) {
			throw new Error("AppImage update information does not fit in .upd_info");
		}
		const padded = Buffer.alloc(section.size);
		information.copy(padded);
		fs.ftruncateSync(fd, payloadSize);
		fs.writeSync(fd, padded, 0, padded.length, section.offset);
	} finally {
		fs.closeSync(fd);
	}
	// This internal helper is verified against app-builder-lib 26.15.3. Recheck its return
	// shape and artifactBuildCompleted ordering when upgrading electron-builder.
	const { appendBlockmap } = require("app-builder-lib/out/targets/differentialUpdateInfoBuilder");
	event.updateInfo = await appendBlockmap(event.file);
	const filename = path.basename(event.file);
	childProcess.execFileSync(
		"zsyncmake",
		[
			"-e",
			"-f",
			filename,
			"-u",
			`https://github.com/${REPOSITORY}/releases/download/v${version}/${encodeURIComponent(filename)}`,
			"-o",
			`${event.file}.zsync`,
			event.file,
		],
		{ stdio: "inherit" },
	);
};

exports.afterAllArtifactBuild = function afterAllArtifactBuild(result) {
	return result.artifactPaths
		.filter((file) => file.endsWith(".AppImage"))
		.map((file) => `${file}.zsync`);
};
