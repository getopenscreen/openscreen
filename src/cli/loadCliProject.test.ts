import { describe, expect, it, vi } from "vitest";
import { PROJECT_VERSION } from "@/components/video-editor/projectPersistence";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { loadCliProject } from "./loadCliProject";

const loadProjectFileFromPath = vi.fn();
vi.mock("@/native", () => ({
	nativeBridgeClient: {
		project: { loadProjectFileFromPath: (p: string) => loadProjectFileFromPath(p) },
	},
}));

// `legacyProjectEditor` has its own tests in exportProject.test.ts; this one guards the loader
// actually using it, so a v2 export cannot drop the keys again behind a green helper test.
describe("loadCliProject", () => {
	it("carries render settings the normalizer does not know into the exported document (#1467)", async () => {
		loadProjectFileFromPath.mockResolvedValue({
			success: true,
			project: {
				version: PROJECT_VERSION,
				media: { screenVideoPath: "/recordings/screen.mp4" },
				editor: { cursorModel3d: true, cursorClickSound: true, audioGainDb: -3 },
			},
		});
		vi.stubGlobal("window", {
			electronAPI: { getCurrentRecordingSession: async () => ({ session: null }) },
		});
		// The probe's <video>: answers with metadata as soon as it is given a source.
		vi.stubGlobal("document", {
			createElement: () => {
				const video = {
					videoWidth: 1920,
					videoHeight: 1080,
					duration: 12,
					onloadedmetadata: null as null | (() => void),
					removeAttribute: vi.fn(),
					load: vi.fn(),
					set src(_: string) {
						queueMicrotask(() => video.onloadedmetadata?.());
					},
				};
				return video;
			},
		});
		try {
			const { document } = await loadCliProject("/projects/demo.openscreen");
			const settings = getEditorSettings(document);
			expect(settings.cursor.model3d).toBe(true);
			expect(settings.cursor.clickSound).toBe(true);
			expect(settings.audioGainDb).toBe(-3);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
