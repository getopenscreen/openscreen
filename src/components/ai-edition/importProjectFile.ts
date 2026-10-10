// What the open-file dialog (or a drop) read, turned into a project the editor can load.

import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import {
	migrateProjectDataToAxcutDocument,
	migrateRawDocumentToCurrent,
} from "@/lib/ai-edition/document/migrate";
import { documentSchema } from "@/lib/ai-edition/schema";
import { nativeBridgeClient } from "@/native";

/**
 * Saves `raw` as a project and returns its id, for the caller to load.
 *
 * A current project file carries its own `schemaVersion` (an AxcutDocument) and is upgraded;
 * anything else is a legacy EditorProjectData and is migrated. Discriminate on the version
 * field so a current document is never fed to the legacy migrator (which reads
 * `.media`/`.editor` and would yield an empty doc).
 *
 * A project's own file (`storedProjectId`) is not saved: saving it back would write the file
 * as read over any change made since, an MCP edit included. Loading it by id reads it again,
 * as opening it from the project list does.
 */
export async function importProjectFile(
	raw: unknown,
	storedProjectId?: string,
): Promise<{ projectId: string; legacy: boolean }> {
	const legacy = !(
		typeof raw === "object" &&
		raw !== null &&
		"schemaVersion" in raw &&
		"timeline" in raw
	);
	const doc = legacy
		? migrateProjectDataToAxcutDocument(raw as EditorProjectData)
		: documentSchema.parse(migrateRawDocumentToCurrent(raw)); // disk-load: upgrade, then validate
	if (doc.project.id !== storedProjectId) {
		const saved = await nativeBridgeClient.aiEdition.save(doc);
		if (!saved.success || !saved.document) {
			throw new Error(saved.error ?? "Failed to open project");
		}
	}
	return { projectId: doc.project.id, legacy };
}
