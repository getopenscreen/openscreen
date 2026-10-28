import { describe, expect, it } from "vitest";
import { transcriptSchema } from "../schema";
import { SrtImportError, transcriptFromSrt } from "./fromSrt";

describe("SRT import", () => {
	it("preserves cues and provenance through schema serialization", () => {
		const t = transcriptFromSrt(
			"a",
			"\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\n<b>Hello</b> 世界\r\nnext line\r\n\r\n2\r\n00:00:02,010 --> 00:00:03,000\r\nAgain",
			4,
			"captions.srt",
		);
		expect(t.segments.map((s) => s.text)).toEqual(["Hello 世界\nnext line", "Again"]);
		expect(t.words).toHaveLength(5);
		const serialized = JSON.stringify(t);
		expect(transcriptSchema.parse(JSON.parse(serialized)).importSource).toEqual({
			format: "srt",
			fileName: "captions.srt",
			wordTiming: "estimated",
		});
		expect(t.words[0].id).not.toBe("word_1");
	});
	it.each([
		["", "empty"],
		["1\n00:00:00,000 --> 00:00:04,001\nx", "bounds"],
		["x\n00:00:00,000 --> 00:00:01,000\nx", "index"],
		["1\n00:60:00,000 --> 00:00:01,000\nx", "timestamp"],
		["1\n00:00:00,000 -> 00:00:01,000\nx", "timestamp"],
		["1\n00:00:01,000 --> 00:00:01,000\nx", "duration"],
		["1\n00:00:00,000 --> 00:00:05,000\nx", "bounds"],
		["1\n00:00:00,000 --> 00:00:01,000\n<script>x</script>", "markup"],
		["1\n00:00:00,000 --> 00:00:02,000\nx\n\n2\n00:00:01,000 --> 00:00:03,000\ny", "overlap"],
		["1\n00:00:00,000 --> 00:00:01,000", "text"],
	])("rejects invalid file with typed location: %s", (text, code) => {
		try {
			transcriptFromSrt("a", text, 4, "x.srt");
			throw new Error("accepted");
		} catch (e) {
			expect(e).toBeInstanceOf(SrtImportError);
			expect(e).toMatchObject({ code });
			expect((e as SrtImportError).line).toBeGreaterThan(0);
		}
	});
});
