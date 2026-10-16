import { describe, expect, it } from "vitest";
import { adoptStoredUserMessage } from "./chatTranscript";

const local = {
	id: "local_1_u",
	role: "user",
	content: "cut the silence",
	checkpointId: "local_1_u",
};
const earlier = { id: "m0", role: "assistant", content: "hi", checkpointId: null };

describe("adoptStoredUserMessage", () => {
	it("gives the message just sent the id the session stored it under, so it can be rewound", () => {
		const next = adoptStoredUserMessage([earlier, local], "local_1_u", {
			userMessageId: "stored-1",
			userMessageCheckpointId: "stored-1",
		});
		expect(next[1]).toMatchObject({
			id: "stored-1",
			checkpointId: "stored-1",
			content: "cut the silence",
		});
		expect(next[0]).toBe(earlier);
	});

	it("hides the rewind of a message stored without a checkpoint", () => {
		// A text-only turn (no document open) records no snapshot: there is nothing to rewind to.
		const next = adoptStoredUserMessage([local], "local_1_u", { userMessageId: "stored-1" });
		expect(next[0]).toMatchObject({ id: "stored-1", checkpointId: null });
	});

	it("leaves the transcript as it is when the turn never stored the message", () => {
		const messages = [earlier, local];
		expect(adoptStoredUserMessage(messages, "local_1_u", {})).toBe(messages);
	});
});
