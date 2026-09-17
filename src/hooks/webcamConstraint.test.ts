import { describe, expect, it } from "vitest";
import { isRecoverableWebcamConstraintError } from "./useScreenRecorder";

describe("isRecoverableWebcamConstraintError", () => {
	it("waits when a saved camera name can still resolve a stale id", () => {
		expect(
			isRecoverableWebcamConstraintError(
				new DOMException("exact id gone", "OverconstrainedError"),
				"Camera 2",
			),
		).toBe(true);
		expect(
			isRecoverableWebcamConstraintError(new DOMException("missing", "NotFoundError"), "Camera 2"),
		).toBe(true);
	});

	it("does not wait when there is no saved name or the error is not a constraint", () => {
		expect(
			isRecoverableWebcamConstraintError(
				new DOMException("exact id gone", "OverconstrainedError"),
				undefined,
			),
		).toBe(false);
		expect(
			isRecoverableWebcamConstraintError(
				new DOMException("blocked", "NotAllowedError"),
				"Camera 2",
			),
		).toBe(false);
	});
});
