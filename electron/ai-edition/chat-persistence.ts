// Local Agent chat sidecars live beside the project's .openscreen document.
// Keep this format separate from the document schema: a bad or newer chat file
// must never stop the project itself from opening.

import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

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

	write(projectId: string, sessions: StoredChatSession[]): void {
		const destination = this.fileFor(projectId);
		mkdirSync(this.projectsRoot, { recursive: true });
		const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
		// Explicitly choose fields; provider configuration and API keys never enter
		// the chat format. Checkpoints remain process-local and are never serialized.
		const sanitized = sessions.map((session) => sessionSchema.parse(session));
		const json = JSON.stringify({ version: 1, projectId, sessions: sanitized });
		let fd: number | undefined;
		try {
			fd = openSync(temporary, "w");
			writeFileSync(fd, json, "utf8");
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			renameSync(temporary, destination);
		} finally {
			if (fd !== undefined) closeSync(fd);
			rmSync(temporary, { force: true });
		}
	}

	delete(projectId: string): void {
		rmSync(this.fileFor(projectId), { force: true });
	}
}
