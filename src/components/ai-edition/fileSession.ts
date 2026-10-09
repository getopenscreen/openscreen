import {
	type EditorProjectData,
	toFileUrl,
	validateProjectData,
} from "@/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { applyProbedDuration } from "@/lib/ai-edition/document/timeline";
import {
	type AxcutDocument,
	isAxcutDocumentFile,
	parseDocumentFile,
} from "@/lib/ai-edition/schema";
import {
	saveWithDeadline,
	useProjectStore,
	waitForDocumentSaves,
} from "@/lib/ai-edition/store/projectStore";
import { probeVideoDimensions, probeVideoDuration } from "@/lib/ai-edition/timeline/duration";
import { nativeBridgeClient } from "@/native/client";

/** Embed the editor in a caller-controlled, single-file workflow. */
export interface EditorFileSession {
	projectPath: string;
	onFinish: (document: AxcutDocument) => Promise<void>;
	onLoadError: (error: unknown) => void;
}

export async function loadEditorFile(projectPath: string): Promise<void> {
	const result = await window.electronAPI.loadProjectFileFromPath(projectPath);
	if (!result.success || !result.project) {
		throw new Error(result.error ?? result.message ?? "Failed to open project");
	}
	const raw: unknown = result.project;
	let document: AxcutDocument;
	if (isAxcutDocumentFile(raw)) {
		document = parseDocumentFile(raw);
	} else {
		if (!validateProjectData(raw)) throw new Error("Invalid project file");
		document = migrateProjectDataToAxcutDocument(raw as EditorProjectData);
		// Legacy files have no measured duration. Resolve it before enabling Done,
		// so immediately finishing cannot save a timeline with a placeholder length.
		const primary = document.assets[0];
		if (primary?.originalPath) {
			const url = toFileUrl(primary.originalPath);
			const [duration, dimensions] = await Promise.all([
				probeVideoDuration(url),
				probeVideoDimensions(url),
			]);
			if (duration === null || dimensions === null) {
				throw new Error(`Could not read recorded video: ${primary.originalPath}`);
			}
			document = applyProbedDuration(document, primary.id, duration);
			document = {
				...document,
				assets: document.assets.map((asset) =>
					asset.id === primary.id
						? { ...asset, video: { codec: "unknown", fps: 0, ...asset.video, ...dimensions } }
						: asset,
				),
			};
		}
	}
	const saved = await nativeBridgeClient.aiEdition.save(document);
	if (!saved.success) throw new Error(saved.error ?? "Failed to import project");
	await useProjectStore.getState().loadProject(document.project.id);
	const state = useProjectStore.getState();
	if (state.status !== "ready" || !state.document) {
		throw new Error(state.error ?? "Failed to load imported project");
	}
}

/** Drain edits before taking the document snapshot passed back to the caller. */
export async function finishEditorFile(
	onFinish: EditorFileSession["onFinish"],
	pendingEdits: Promise<unknown> = Promise.resolve(),
): Promise<void> {
	if ((await saveWithDeadline(pendingEdits.then(() => true))) !== true) {
		throw new Error("A queued edit has not finished. Please try again.");
	}
	if ((await waitForDocumentSaves()) !== "idle") {
		throw new Error("An edit is still being saved. Try again once it finishes.");
	}
	const state = useProjectStore.getState();
	if (!state.document) throw new Error("No project is loaded");
	if ((await saveWithDeadline(state.saveDocument(state.document, { history: false }))) !== true) {
		throw new Error("Could not save the current edits. Please try again.");
	}
	const document = useProjectStore.getState().document;
	if (!document) throw new Error("The project was closed while saving");
	await onFinish(document);
}
