import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	WebmContainer,
	WebmFile,
	WebmFloat,
	WebmString,
	WebmUint,
} from "@fix-webm-duration/parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchWebmDurationOnDisk, readWebmDurationOnDisk } from "./webm-duration";

interface WebmElementMock {
	getSectionById: (id: number) => WebmElementMock;
	getValue: () => number;
}

// EBML element length encoded as a 4-byte VINT: 0x10 marker in the leading byte
// plus 28 bits of length, which covers both fixture sizes below.
function ebmlLength4(length: number): Buffer {
	return Buffer.from([
		0x10 | ((length >>> 24) & 0x0f),
		(length >>> 16) & 0xff,
		(length >>> 8) & 0xff,
		length & 0xff,
	]);
}

describe("webm-duration patching", () => {
	let dir: string;
	const pathFor = (name: string) => path.join(dir, name);

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "openscreen-duration-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function createDummyWebm(
		includeCluster = true,
		clusterSize = 100,
		metadata: { duration?: number; scale?: number | null } = {},
	): Uint8Array {
		const ebml = new WebmContainer("EBML");
		ebml.data = [];
		const docType = new WebmString("DocType");
		docType.setValue("webm");
		ebml.data.push({ id: 0x282, idHex: "282", data: docType });
		ebml.updateByData();

		const segment = new WebmContainer("Segment");
		segment.data = [];
		segment.isInfinite = true;

		const info = new WebmContainer("Info");
		info.data = [];
		const timecodeScale = new WebmUint("TimecodeScale");
		timecodeScale.setValue(metadata.scale ?? 1000000);
		if (metadata.scale !== null)
			info.data.push({ id: 0xad7b1, idHex: "ad7b1", data: timecodeScale });
		if (metadata.duration !== undefined) {
			const duration = new WebmFloat("Duration");
			duration.setValue(metadata.duration);
			info.data.push({ id: 0x489, idHex: "489", data: duration });
		}
		info.updateByData();
		segment.data.push({ id: 0x549a966, idHex: "549a966", data: info });

		segment.updateByData();

		if (includeCluster) {
			// The Cluster is appended as raw bytes rather than as a `WebmContainerItem`:
			// the parser's `sections` map has no entry for Cluster (0x1f43b675), so its
			// id is not a `SectionKey`, and `WebmBase`'s constructor is protected.
			// Bytes are all that matters here anyway — patchWebmDurationOnDisk re-parses
			// the fixture from disk, so appending the element to the Segment payload is
			// equivalent to registering it as a child.
			// A valid EBML element for Cluster: ID 0x1f43b675, a VINT length, then the
			// cluster data filled with 0x42.
			const body = Buffer.alloc(clusterSize, 0x42);
			const clusterBytes = Buffer.concat([
				Buffer.from([0x1f, 0x43, 0xb6, 0x75]),
				ebmlLength4(body.length),
				body,
			]);
			const segmentPayload = segment.source;
			if (!segmentPayload) throw new Error("fixture: Segment has no source after updateByData");
			segment.source = Buffer.concat([Buffer.from(segmentPayload), clusterBytes]);
		}

		const file = new WebmContainer("File");
		file.data = [];
		file.data.push({ id: 0xa45dfa3, idHex: "a45dfa3", data: ebml });
		file.data.push({ id: 0x8538067, idHex: "8538067", data: segment });

		file.updateByData();
		if (!file.source) throw new Error("fixture: File has no source after updateByData");
		return file.source;
	}

	it("reads finalized container duration without changing the file or using caller wall time", async () => {
		const file = pathFor("final.webm");
		const bytes = createDummyWebm(true, 2.5 * 1024 * 1024, { duration: 1966 });
		await writeFile(file, bytes);
		expect(await readWebmDurationOnDisk(file)).toBe(1966);
		expect(await readFile(file)).toEqual(Buffer.from(bytes));
	});
	it.each([
		null,
		2000000,
	])("honors TimestampScale (including EBML's omitted default): %s", async (scale) => {
		const file = pathFor("scaled.webm");
		await writeFile(file, createDummyWebm(true, 100, { duration: 983.25, scale }));
		expect(await readWebmDurationOnDisk(file)).toBe(scale === null ? 983.25 : 1966.5);
	});
	it.each([0, -1, NaN, Infinity])("does not use an invalid duration %s", async (duration) => {
		const file = pathFor("invalid.webm");
		await writeFile(file, createDummyWebm(true, 100, { duration }));
		expect(await readWebmDurationOnDisk(file)).toBeNull();
	});
	it("returns unknown for missing duration, truncated data, unavailable file and non-WebM", async () => {
		const file = pathFor("unknown.webm");
		await writeFile(file, createDummyWebm());
		expect(await readWebmDurationOnDisk(file)).toBeNull();
		await writeFile(file, Buffer.from([0x1a, 0x45]));
		expect(await readWebmDurationOnDisk(file)).toBeNull();
		expect(await readWebmDurationOnDisk(pathFor("missing.webm"))).toBeNull();
		const mp4 = pathFor("not-webm.mp4");
		await writeFile(mp4, createDummyWebm(true, 100, { duration: 1966 }));
		expect(await readWebmDurationOnDisk(mp4)).toBeNull();
	});

	it("patches small WebM files under 2MB successfully", async () => {
		const webmBytes = createDummyWebm(true, 100);
		const filePath = pathFor("small.webm");
		await writeFile(filePath, webmBytes);

		const result = await patchWebmDurationOnDisk(filePath, 5000);
		expect(result.patched).toBe(true);

		const patchedBytes = await readFile(filePath);
		const webm = new WebmFile(new Uint8Array(patchedBytes));

		const segment = webm.getSectionById(0x8538067) as unknown as WebmElementMock;
		const info = segment.getSectionById(0x549a966);
		const duration = info.getSectionById(0x489);

		expect(duration).toBeDefined();
		expect(duration.getValue()).toBe(5000);
	});

	it("preserves successive unknown-sized Clusters in a small MediaRecorder file", async () => {
		const header = createDummyWebm(false);
		const cluster = Buffer.from("1f43b67501ffffffffffffffe78100a3858100008000", "hex");
		const clusters = Buffer.concat([cluster, cluster]);
		const filePath = pathFor("live-clusters.webm");
		await writeFile(filePath, Buffer.concat([header, clusters]));

		expect(await patchWebmDurationOnDisk(filePath, 2000)).toEqual({ patched: true });
		const patched = await readFile(filePath);
		const firstCluster = patched.indexOf(Buffer.from("1f43b675", "hex"));
		expect(firstCluster).toBeGreaterThan(0);
		expect(patched.subarray(firstCluster)).toEqual(clusters);
	});

	it("patches large WebM files over 2MB using the optimized streaming method successfully", async () => {
		// Create a file larger than 2MB (e.g. 2.5MB cluster data) to trigger the optimized method
		const webmBytes = createDummyWebm(true, 2.5 * 1024 * 1024);
		const filePath = pathFor("large.webm");
		await writeFile(filePath, webmBytes);

		const result = await patchWebmDurationOnDisk(filePath, 12000);
		expect(result.patched).toBe(true);

		const patchedBytes = await readFile(filePath);
		const webm = new WebmFile(new Uint8Array(patchedBytes));
		const segment = webm.getSectionById(0x8538067) as unknown as WebmElementMock;
		const info = segment.getSectionById(0x549a966);
		const duration = info.getSectionById(0x489);

		expect(duration).toBeDefined();
		expect(duration.getValue()).toBe(12000);

		// Verify the Cluster data (filled with 0x42) is intact at the end
		const lastBytes = patchedBytes.subarray(patchedBytes.length - 100);
		expect(lastBytes.every((b) => b === 0x42)).toBe(true);
	});

	it("falls back to in-memory patching if no Cluster section is found in the large file header chunk", async () => {
		// File is over 2MB, but has no Cluster (very large header or weird file)
		const webmBytes = createDummyWebm(false);
		// Pad to 2.5MB without Cluster
		const padding = Buffer.alloc(2.5 * 1024 * 1024, 0);
		const largeNoClusterBytes = Buffer.concat([Buffer.from(webmBytes), padding]);

		const filePath = pathFor("large_no_cluster.webm");
		await writeFile(filePath, largeNoClusterBytes);

		const result = await patchWebmDurationOnDisk(filePath, 8000);
		expect(result.patched).toBe(true);

		const patchedBytes = await readFile(filePath);
		const webm = new WebmFile(new Uint8Array(patchedBytes));
		const segment = webm.getSectionById(0x8538067) as unknown as WebmElementMock;
		const info = segment.getSectionById(0x549a966);
		const duration = info.getSectionById(0x489);

		expect(duration).toBeDefined();
		expect(duration.getValue()).toBe(8000);
	});
});
