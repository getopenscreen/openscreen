import type { AiEditionChatResult } from "@/native/contracts";

/**
 * The panel shows a sent message before the main process has stored it, under a `local_…` id
 * the session does not know. Once the turn answers with the stored id, the message takes it,
 * with its real checkpoint: a rewind names the message by that id, and with the local one it
 * failed with "Message not found in this session" until the conversation was reloaded.
 */
export function adoptStoredUserMessage<M extends { id?: string; checkpointId?: string | null }>(
	messages: M[],
	localId: string,
	result: Pick<AiEditionChatResult, "userMessageId" | "userMessageCheckpointId">,
): M[] {
	const storedId = result.userMessageId;
	if (!storedId) return messages;
	return messages.map((message) =>
		message.id === localId
			? { ...message, id: storedId, checkpointId: result.userMessageCheckpointId ?? null }
			: message,
	);
}
