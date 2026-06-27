import { create } from "zustand";
import { nativeBridgeClient } from "@/native/client";
import {
	type Interval,
	replaceTimeline as replaceTimelineOp,
	restoreFullTimeline as restoreFullTimelineOp,
} from "../document/timeline";
import {
	type AxcutAsset,
	type AxcutDocument,
	type AxcutTranscript,
	documentSchema,
} from "../schema";

// ponytail: thin Zustand wrapper over the native-bridge client. Keeps the
// current project + revision counter in renderer memory; mutations round-trip
// through the main process via the bridge so disk state stays authoritative.

export type ProjectStatus = "idle" | "loading" | "ready" | "error";

export interface ProjectState {
	projectId: string | null;
	document: AxcutDocument | null;
	revision: number;
	status: ProjectStatus;
	error: string | null;
	sourceDurationSec: number;
	currentTimeSec: number;

	loadProject: (projectId: string) => Promise<void>;
	createProject: (title: string) => Promise<AxcutDocument>;
	refresh: () => Promise<void>;
	addAsset: (path: string, label?: string) => Promise<AxcutAsset | null>;
	removeAsset: (assetId: string) => Promise<void>;
	saveDocument: (document: AxcutDocument) => Promise<void>;
	setDocument: (document: AxcutDocument) => void;
	replaceTimeline: (intervals: Interval[], reason: string) => Promise<void>;
	restoreFullTimeline: () => Promise<void>;
	setTranscript: (transcript: AxcutTranscript) => Promise<void>;
	setSourceDuration: (sec: number) => void;
	setCurrentTime: (sec: number) => void;
	clear: () => void;
}

function parseDocument(value: unknown): AxcutDocument {
	return documentSchema.parse(value);
}

export const useProjectStore = create<ProjectState>((set, get) => ({
	projectId: null,
	document: null,
	revision: 0,
	status: "idle",
	error: null,
	sourceDurationSec: 0,
	currentTimeSec: 0,

	async loadProject(projectId) {
		set({ status: "loading", error: null });
		try {
			const result = await nativeBridgeClient.aiEdition.get(projectId);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to load project");
			}
			const document = parseDocument(result.document);
			set({
				projectId,
				document,
				revision: get().revision + 1,
				status: "ready",
				error: null,
			});
		} catch (error) {
			set({
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},

	async createProject(title) {
		set({ status: "loading", error: null });
		try {
			const result = await nativeBridgeClient.aiEdition.create(title);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to create project");
			}
			const document = parseDocument(result.document);
			set({
				projectId: document.project.id,
				document,
				revision: get().revision + 1,
				status: "ready",
				error: null,
			});
			return document;
		} catch (error) {
			set({
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	},

	async refresh() {
		const { projectId } = get();
		if (!projectId) return;
		await get().loadProject(projectId);
	},

	async addAsset(path, label) {
		const { projectId } = get();
		if (!projectId) throw new Error("No project loaded");
		const result = await nativeBridgeClient.aiEdition.addAsset(projectId, path, label);
		const document = parseDocument(result.document);
		const addedAsset =
			document.assets.find((a) => a.originalPath === path && (label ? a.label === label : true)) ??
			document.assets.at(-1) ??
			null;
		set({
			document,
			revision: get().revision + 1,
		});
		return addedAsset;
	},

	async removeAsset(assetId) {
		const { projectId } = get();
		if (!projectId) throw new Error("No project loaded");
		const result = await nativeBridgeClient.aiEdition.removeAsset(projectId, assetId);
		const document = parseDocument(result.document);
		set({
			document,
			revision: get().revision + 1,
		});
	},

	async saveDocument(document) {
		const result = await nativeBridgeClient.aiEdition.save(document);
		if (!result.success || !result.document) {
			throw new Error(result.error ?? "Failed to save project");
		}
		const parsed = parseDocument(result.document);
		set({
			document: parsed,
			revision: get().revision + 1,
		});
	},

	setDocument(document) {
		set({ document, revision: get().revision + 1 });
	},

	async replaceTimeline(intervals, reason) {
		const doc = get().document;
		if (!doc) throw new Error("No project loaded");
		const next = replaceTimelineOp(doc, intervals, reason);
		await get().saveDocument(next);
	},

	async restoreFullTimeline() {
		const doc = get().document;
		if (!doc) throw new Error("No project loaded");
		const next = restoreFullTimelineOp(doc);
		await get().saveDocument(next);
	},

	async setTranscript(transcript) {
		const doc = get().document;
		if (!doc) throw new Error("No project loaded");
		const transcripts = [
			...doc.transcripts.filter((t) => t.assetId !== transcript.assetId),
			transcript,
		];
		const next: AxcutDocument = {
			...doc,
			transcript: doc.project.primaryAssetId === transcript.assetId ? transcript : doc.transcript,
			transcripts,
			preview: { ...doc.preview, revision: doc.preview.revision + 1 },
		};
		await get().saveDocument(next);
	},

	setSourceDuration(sec) {
		set({ sourceDurationSec: sec });
	},

	setCurrentTime(sec) {
		set({ currentTimeSec: sec });
	},

	clear() {
		set({
			projectId: null,
			document: null,
			revision: 0,
			status: "idle",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 0,
		});
	},
}));
