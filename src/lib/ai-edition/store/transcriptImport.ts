// Keep the automatic speech queue from starting while an imported transcript is saving.
// Scoped to project + asset so an old project's disk write cannot block a new project.
const pending = new Map<string, Map<string, Promise<void>>>();
export function transcriptImportPending(projectId: string, assetId: string): boolean {
	return pending.get(projectId)?.has(assetId) ?? false;
}
export async function waitForTranscriptImport(projectId: string, assetId: string): Promise<void> {
	await pending.get(projectId)?.get(assetId);
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
	assets.set(assetId, done);
	try {
		return await save();
	} finally {
		assets.delete(assetId);
		if (!assets.size) pending.delete(projectId);
		release();
	}
}
