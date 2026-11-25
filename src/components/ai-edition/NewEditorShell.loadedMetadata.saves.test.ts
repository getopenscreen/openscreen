// `runLoadedMetadataWrite` against the store's real `saveDocument`, so a save is genuinely in
// flight when the video's metadata arrives: the import's camera-look save (the recording bar's
// Custom shape) is that save on a fresh recording. Only the bridge is stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: bridge } }));

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig: vi.fn(),
			closeConfig: vi.fn(),
			setShortcuts: vi.fn(),
			persistShortcuts: () => Promise.resolve(true),
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
	useScopedT: () => (key: string) => key,
}));

import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings, patchEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { runLoadedMetadataWrite } from "./NewEditorShell";

const PROJECT = "proj_a";

function freshImport(): AxcutDocument {
	const doc = createEmptyDocument({ projectId: PROJECT, title: "A" });
	return {
		...doc,
		project: { ...doc.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.mp4",
				originalPath: "/tmp/screen.mp4",
				cameraTrack: null,
			},
		],
	};
}

describe("runLoadedMetadataWrite with a save still landing", () => {
	beforeEach(() => {
		bridge.save.mockReset();
		useProjectStore.setState({ document: freshImport(), projectId: PROJECT });
	});

	it("builds on the save in flight instead of undoing it when it lands", async () => {
		let landCameraSave: (() => void) | undefined;
		bridge.save
			.mockImplementationOnce(
				(document: AxcutDocument) =>
					new Promise((resolve) => {
						landCameraSave = () => resolve({ success: true, document });
					}),
			)
			.mockImplementation(async (document: AxcutDocument) => ({ success: true, document }));
		const withCamera = patchEditorSettings(freshImport(), {
			webcamMaskShape: "square",
			webcamRoundness: 0.25,
		});

		// The import's camera-look save, still on its way when the video loads.
		const cameraSave = useProjectStore.getState().saveDocument(withCamera, { history: false });
		const metadataWrite = runLoadedMetadataWrite(12.5, "asset_1", PROJECT, {
			autoZoom: async () => undefined,
		});
		landCameraSave?.();
		await cameraSave;
		await metadataWrite;

		expect(bridge.save).toHaveBeenCalledTimes(2);
		const written = bridge.save.mock.calls[1][0] as AxcutDocument;
		expect(written.assets[0].durationSec).toBe(12.5);
		expect(getEditorSettings(written)).toMatchObject({
			webcamMaskShape: "square",
			webcamRoundness: 0.25,
		});
	});
});
