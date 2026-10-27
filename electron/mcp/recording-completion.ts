// Tracks the app's actual take, including takes started by the person at the HUD.
// No project-folder watching: only that take's saved session and editor hand-off
// can complete it. Waiters own their deadlines, never the recording's lifetime.
import fs from "node:fs/promises";
import { clipAwaitsProbedDuration } from "../../src/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import type { RecordedTake } from "./media-tools";

export type CompletedRecording = RecordedTake & { recordingStartedAt: number };
type Outcome = { result: CompletedRecording } | { error: string };
interface Take {
	id: number;
	startedAt: number;
	videoPath?: string;
	listeners: Set<(outcome: Outcome) => void>;
}

export class RecordingCompletion {
	private current: Take | null = null;

	isActive(): boolean {
		return this.current !== null;
	}

	started(id: number, startedAt = Date.now()): void {
		if (this.current?.id === id) return;
		if (this.current) this.failed(this.current.id, "The recording was replaced by another take.");
		this.current = { id, startedAt, listeners: new Set() };
	}

	saved(id: number, videoPath: string): void {
		if (this.current?.id === id) this.current.videoPath = videoPath;
	}

	videoPath(id: number): string | undefined {
		return this.current?.id === id ? this.current.videoPath : undefined;
	}

	completed(id: number, result: RecordedTake): void {
		const take = this.current;
		if (!take || take.id !== id || take.videoPath !== result.videoPath) return;
		this.finish(take, { result: { ...result, recordingStartedAt: take.startedAt } });
	}

	/** The editor has acknowledged its saves. Verify against the persisted project. */
	async projectReady(
		id: number,
		projectId: string,
		readProject: (id: string) => Promise<AxcutDocument>,
	): Promise<void> {
		const videoPath = this.videoPath(id);
		if (!videoPath) return;
		try {
			const document = await readProject(projectId);
			const asset = document.assets.find((asset) => asset.originalPath === videoPath);
			if (
				!asset?.durationSec ||
				!document.timeline.clips.some((clip) => clip.assetId === asset.id) ||
				document.timeline.clips.some((clip) => clipAwaitsProbedDuration(clip, asset.id))
			) {
				throw new Error("The recording's project has no measured video clip.");
			}
			for (const filePath of [videoPath, asset.cameraTrack?.sourcePath]) {
				if (!filePath) continue;
				const stat = await fs.stat(filePath);
				if (!stat.isFile() || stat.size === 0)
					throw new Error("A recording media file is empty or missing.");
			}
			this.completed(id, {
				projectId: document.project.id,
				videoPath,
				durationSec: asset.durationSec,
				autoZooms: document.zoomRanges.length,
			});
		} catch (error) {
			this.failed(id, `The recording could not be prepared: ${String(error)}`);
		}
	}

	failed(id: number, error: string): void {
		if (this.current?.id === id) this.finish(this.current, { error });
	}

	private finish(take: Take, outcome: Outcome): void {
		this.current = null;
		for (const listener of take.listeners) listener(outcome);
		take.listeners.clear();
	}

	wait(timeoutMs: number, signal: AbortSignal): Promise<CompletedRecording> {
		const take = this.current;
		if (!take) return Promise.reject(new Error("No recording is running or being saved."));
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				take.listeners.delete(finished);
				signal.removeEventListener("abort", aborted);
			};
			const finished = (outcome: Outcome) => {
				cleanup();
				if ("error" in outcome) reject(new Error(outcome.error));
				else resolve(outcome.result);
			};
			const aborted = () =>
				finished({ error: "Waiting for the recording was cancelled. The recording is unchanged." });
			const timer = setTimeout(
				() =>
					finished({
						error:
							"Timed out waiting for the recording. The recording is unchanged; call waitForRecording again while it is running or being saved.",
					}),
				timeoutMs,
			);
			// Capture the target and subscribe synchronously, with no await between them.
			// Completion cannot fall between a state read and listener registration.
			take.listeners.add(finished);
			signal.addEventListener("abort", aborted, { once: true });
			if (signal.aborted) aborted();
		});
	}
}
