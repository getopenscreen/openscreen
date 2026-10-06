import type { WebContents } from "electron";

type ExportOwner = Pick<WebContents, "id" | "isDestroyed" | "once" | "removeListener">;

export interface ExportJob<T> {
	result: Promise<T>;
	cancel: () => boolean;
}

export function isExportId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Controls never leave main. Unknown and foreign IDs have the same result. */
export class ExportJobs {
	private readonly jobs = new Map<number, { exportId: string; cancel: () => boolean }>();

	cancel(owner: ExportOwner, exportId: string): boolean {
		const job = this.jobs.get(owner.id);
		return job?.exportId === exportId && job.cancel();
	}

	async run<T>(
		owner: ExportOwner,
		exportId: string,
		start: (progress: (frames: number) => void) => ExportJob<T>,
		onProgress: (frames: number) => void,
	): Promise<T> {
		if (!isExportId(exportId)) throw new Error("Invalid export ID.");
		if (owner.isDestroyed()) throw new Error("Export window is closed.");
		if (this.jobs.has(owner.id)) throw new Error("An export is already running in this window.");
		let active = true;
		const job = start((frames) => {
			if (active && !owner.isDestroyed()) onProgress(frames);
		});
		const entry = { exportId, cancel: job.cancel };
		this.jobs.set(owner.id, entry);
		const onDestroyed = () => {
			job.cancel();
		};
		owner.once("destroyed", onDestroyed);
		try {
			return await job.result;
		} finally {
			active = false;
			owner.removeListener("destroyed", onDestroyed);
			if (this.jobs.get(owner.id) === entry) this.jobs.delete(owner.id);
		}
	}
}
