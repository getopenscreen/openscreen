import { describe, expect, it, vi } from "vitest";
import { PROJECT_VERSION } from "@/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { legacyEditorForMigration } from "./loadCliProject";

vi.mock("@/native", () => ({ nativeBridgeClient: {} }));

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
