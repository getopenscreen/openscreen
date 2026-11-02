import { describe, expect, it, vi } from "vitest";
import { PROJECT_VERSION } from "@/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { legacyEditorForMigration, loadCliProject } from "./loadCliProject";

const loadProjectFileFromPath = vi.fn();
vi.mock("@/native", () => ({
	nativeBridgeClient: {
		project: { loadProjectFileFromPath: (p: string) => loadProjectFileFromPath(p) },
	},
}));

const migrate = (editor: Record<string, unknown>) =>
	migrateProjectDataToAxcutDocument({
		version: PROJECT_VERSION,
		media: { screenVideoPath: "/recordings/screen.mp4" },
		editor: legacyEditorForMigration(editor),
	});

describe("legacyEditorForMigration", () => {
	it("keeps the editor keys normalizeProjectEditor does not list (#1467)", () => {
		const settings = getEditorSettings(
			migrate({
				cursorModel3d: true,
				cursorClickImpact: true,
				cursorClickSound: true,
				cursorClickSoundGainDb: -4,
				audioGainDb: -3,
			}),
		);
		expect(settings.cursor.model3d).toBe(true);
		expect(settings.cursor.clickImpact).toBe(true);
		expect(settings.cursor.clickSound).toBe(true);
		expect(settings.cursor.clickSoundGainDb).toBe(-4);
		expect(settings.audioGainDb).toBe(-3);
	});

	it("lets the normalized value win over the raw one", () => {
		const settings = getEditorSettings(migrate({ aspectRatio: "not-a-ratio" }));
		expect(settings.aspectRatio).not.toBe("not-a-ratio");
	});
});

describe("loadCliProject", () => {
	it("carries those keys through the v2 loader into the exported document (#1467)", async () => {
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
