// Local Agent chat sidecars live beside the project's .openscreen document.
// Keep this format separate from the document schema: a bad or newer chat file
// must never stop the project itself from opening.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { renameWithRetry } from "../atomic-rename";

const toolCallSchema = z.object({ name: z.string(), summary: z.string() });
const messageSchema = z.object({
	id: z.string().min(1),
	role: z.enum(["user", "assistant"]),
	content: z.string(),
	createdAt: z.string().min(1),
	toolCalls: z.array(toolCallSchema).optional(),
});
const sessionSchema = z.object({
	id: z.string().min(1),
	projectId: z.string().min(1),
	title: z.string().min(1),
	createdAt: z.string().min(1),
	messages: z.array(messageSchema),
	compaction: z
		.object({
			summary: messageSchema,
			coveredCount: z.number().int().positive(),
		})
		.optional(),
});
const fileSchema = z.object({
	version: z.literal(1),
	projectId: z.string(),
	sessions: z.array(z.unknown()),
});

export type StoredChatSession = z.infer<typeof sessionSchema>;

export class ChatPersistence {
	/** Tail of the pending write/delete chain per project id — see `enqueue`. */
	private readonly queues = new Map<string, Promise<void>>();

	constructor(private readonly projectsRoot: string) {}

	fileFor(projectId: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("Invalid project id");
		return path.join(this.projectsRoot, `${projectId}.chat.json`);
	}

	read(projectId: string): StoredChatSession[] {
		const file = this.fileFor(projectId);
		if (!existsSync(file)) return [];
		try {
			const parsed = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
			if (parsed.projectId !== projectId) return [];
			const seen = new Set<string>();
			const sessions: StoredChatSession[] = [];
			for (const rawSession of parsed.sessions) {
				const result = sessionSchema.safeParse(rawSession);
				if (!result.success) continue;
				const session = result.data;
				if (session.projectId !== projectId || seen.has(session.id)) continue;
				if (session.compaction && session.compaction.coveredCount > session.messages.length)
					continue;
				seen.add(session.id);
				sessions.push(session);
			}
			return sessions;
		} catch (error) {
			console.warn(`[ai-edition] ignoring unreadable chat history for ${projectId}:`, error);
			return [];
		}
	}

	/** Snapshots `sessions` now; the disk write waits its turn in the project's queue. */
	async write(projectId: string, sessions: StoredChatSession[]): Promise<void> {
		const destination = this.fileFor(projectId);
		// Explicitly choose fields; provider configuration and API keys never enter
		// the chat format. Checkpoints remain process-local and are never serialized.
		const sanitized = sessions.map((session) => sessionSchema.parse(session));
		const json = JSON.stringify({ version: 1, projectId, sessions: sanitized });
		await this.enqueue(projectId, async () => {
			await fs.mkdir(this.projectsRoot, { recursive: true });
			const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
			try {
				const handle = await fs.open(temporary, "w");
				try {
					await handle.writeFile(json, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				await renameWithRetry(temporary, destination);
			} finally {
				await fs.rm(temporary, { force: true });
			}
		});
	}

	/** Queued behind the project's pending writes, so none of them can recreate the file. */
	async delete(projectId: string): Promise<void> {
		const file = this.fileFor(projectId);
		await this.enqueue(projectId, () => fs.rm(file, { force: true }));
	}

	/** Settles once every write and delete queued so far has. */
	async flush(): Promise<void> {
		await Promise.all(this.queues.values());
	}

	// Same chain as DocumentService.writeProject: one queue per project, run on
	// both settlements so a failed write does not cancel the next one.
	private enqueue(projectId: string, task: () => Promise<void>): Promise<void> {
		const run = (this.queues.get(projectId) ?? Promise.resolve()).then(task, task);
		const settled = run.catch(() => undefined);
		this.queues.set(projectId, settled);
		void settled.then(() => {
			if (this.queues.get(projectId) === settled) this.queues.delete(projectId);
		});
		return run;
	}
}
