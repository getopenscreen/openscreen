// Keep the automatic speech queue from starting while an imported transcript is saving.
// Scoped to project + asset so an old project's disk write cannot block a new project.
const pending = new Map<string, Map<string, Promise<void>>>();
export function transcriptImportPending(projectId: string, assetId: string): boolean {
	return pending.get(projectId)?.has(assetId) ?? false;
}
export async function waitForTranscriptImport(projectId: string, assetId: string): Promise<void> {
	await pending.get(projectId)?.get(assetId);
}
export function projectTranscriptImportPending(projectId: string): boolean {
	return (pending.get(projectId)?.size ?? 0) > 0;
}

/**
 * Wait before reading a whole-document snapshot, including imports on other assets.
 * Aborting releases this waiter only; the import retains its reservation until its save settles.
 */
export async function waitForProjectTranscriptImports(
	projectId: string,
	signal?: AbortSignal,
): Promise<void> {
	while (!signal?.aborted && pending.get(projectId)?.size) {
		const imports = Promise.all(pending.get(projectId)?.values() ?? []);
		if (!signal) {
			await imports;
			continue;
		}
		await new Promise<void>((resolve) => {
			const settle = () => {
				signal.removeEventListener("abort", settle);
				resolve();
			};
			signal.addEventListener("abort", settle, { once: true });
			void imports.then(settle);
		});
	}
}
export async function runTranscriptImport<T>(
	projectId: string,
	assetId: string,
	save: () => Promise<T>,
): Promise<T> {
	let release!: () => void;
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	let assets = pending.get(projectId);
	if (!assets) {
		assets = new Map();
		pending.set(projectId, assets);
	}
	if (assets.has(assetId)) throw new Error("Transcript import already saving");
	const predecessors = [...assets.values()];
	assets.set(assetId, done);
	try {
		if (predecessors.length) await Promise.all(predecessors);
		return await save();
	} finally {
		assets.delete(assetId);
		if (!assets.size) pending.delete(projectId);
		release();
	}
}
