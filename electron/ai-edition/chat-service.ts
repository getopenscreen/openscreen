// In-memory chat service. ponytail: no SQLite, no LangGraph, no checkpoints
// for Phase 6 scaffolding. Stores messages per project in a Map. The actual
// LLM call needs @langchain/* deps + API keys — the runChat function is a
// stub that returns "AI features require LLM dependencies" until the deps
// are installed and a provider is configured.
//
// Phase 8 upgrades this to SQLite-backed sessions with checkpoint restore.

import { v4 as uuidv4 } from "uuid";
import type { AiEditionChatMessage, AiEditionChatResult } from "../../src/native/contracts";
import type { LlmConfigStore } from "./llm-config-store";
import { PROVIDER_DEFINITIONS } from "./provider-registry";

const messagesByProject = new Map<string, AiEditionChatMessage[]>();

export async function runChat(
	projectId: string,
	message: string,
	llmConfig: LlmConfigStore,
): Promise<AiEditionChatResult> {
	const config = llmConfig.getConfig();
	if (!config) {
		return {
			success: false,
			error: "No LLM provider configured. Open Settings → AI to configure.",
		};
	}

	const def = PROVIDER_DEFINITIONS.find((d) => d.id === config.provider);
	if (!def) {
		return { success: false, error: `Unknown provider: ${config.provider}` };
	}

	const apiKey = llmConfig.getApiKey(def.id, def.envKeys);
	if (!apiKey && def.authKind === "api-key") {
		return {
			success: false,
			error: `No API key for ${def.label}. Add one in Settings → AI.`,
		};
	}

	const messages = messagesByProject.get(projectId) ?? [];
	const userMessage: AiEditionChatMessage = {
		id: uuidv4(),
		role: "user",
		content: message,
		createdAt: new Date().toISOString(),
	};
	messages.push(userMessage);

	// ponytail: stub response. The actual LLM call needs @langchain/openai,
	// @langchain/anthropic, etc. installed + imported. This scaffolding lets
	// the UI work end-to-end (message appears, history persists) without the
	// heavy deps. Replace with create-chat-model.ts port when deps land.
	const assistantMessage: AiEditionChatMessage = {
		id: uuidv4(),
		role: "assistant",
		content: `AI features are scaffolding-ready but need @langchain/* dependencies to make real LLM calls. Configure your provider in Settings, then install the deps to enable chat. Your message was: "${message}"`,
		createdAt: new Date().toISOString(),
	};
	messages.push(assistantMessage);
	messagesByProject.set(projectId, messages);

	return {
		success: true,
		assistantMessage,
	};
}

export async function getChatHistory(projectId: string): Promise<AiEditionChatMessage[]> {
	return messagesByProject.get(projectId) ?? [];
}
