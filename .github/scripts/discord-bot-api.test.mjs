import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createForumThread, patchChannel, postChannelMessage } from "./discord-bot-api.mjs";

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("discord-bot-api", () => {
	const botToken = "test-token";

	function mockDiscordResponse({ status = 200, body } = {}) {
		const json = body === undefined ? vi.fn() : vi.fn().mockResolvedValue(body);
		vi.mocked(fetch).mockResolvedValue({
			ok: status >= 200 && status < 300,
			status,
			text: vi.fn().mockResolvedValue(JSON.stringify(body)),
			json,
		});
	}

	describe("createForumThread", () => {
		it("POSTs to /channels/{forumChannelId}/threads with bot auth and payload", async () => {
			mockDiscordResponse({ status: 201, body: { id: "999", name: "PR #1" } });

			const result = await createForumThread({
				botToken,
				forumChannelId: "forum-1",
				payload: { name: "PR #1", message: { content: "hi" }, applied_tags: ["tag-a"] },
			});

			expect(result.id).toBe("999");
			const [url, init] = vi.mocked(fetch).mock.calls[0];
			expect(url).toBe("https://discord.com/api/v10/channels/forum-1/threads");
			expect(init.method).toBe("POST");
			expect(init.headers.Authorization).toBe(`Bot ${botToken}`);
			expect(JSON.parse(init.body)).toEqual({
				name: "PR #1",
				message: { content: "hi" },
				applied_tags: ["tag-a"],
			});
		});

		it("throws with rateLimited flag on 429", async () => {
			mockDiscordResponse({ status: 429, body: { retry_after: 1 } });

			await expect(
				createForumThread({ botToken, forumChannelId: "f", payload: { name: "x" } }),
			).rejects.toMatchObject({ rateLimited: true });
		});

		it("throws on non-ok responses with status in message", async () => {
			mockDiscordResponse({ status: 403, body: { message: "Missing Permissions" } });

			await expect(
				createForumThread({ botToken, forumChannelId: "f", payload: { name: "x" } }),
			).rejects.toThrow(/failed 403/);
		});
	});

	describe("postChannelMessage", () => {
		it("POSTs to /channels/{channelId}/messages with bot auth", async () => {
			mockDiscordResponse({ status: 200, body: { id: "msg-1" } });

			const result = await postChannelMessage({
				botToken,
				channelId: "thread-1",
				payload: { content: "hello", embeds: [{ title: "t" }] },
			});

			expect(result.id).toBe("msg-1");
			const [url, init] = vi.mocked(fetch).mock.calls[0];
			expect(url).toBe("https://discord.com/api/v10/channels/thread-1/messages");
			expect(init.method).toBe("POST");
			expect(init.headers.Authorization).toBe(`Bot ${botToken}`);
			expect(JSON.parse(init.body)).toEqual({ content: "hello", embeds: [{ title: "t" }] });
		});
	});

	describe("patchChannel", () => {
		it("PATCHes /channels/{channelId} with bot auth and JSON body", async () => {
			mockDiscordResponse({ status: 200, body: { id: "thread-1", archived: true } });

			const result = await patchChannel({
				botToken,
				channelId: "thread-1",
				payload: { archived: true, applied_tags: ["merged"] },
			});

			expect(result.archived).toBe(true);
			const [url, init] = vi.mocked(fetch).mock.calls[0];
			expect(url).toBe("https://discord.com/api/v10/channels/thread-1");
			expect(init.method).toBe("PATCH");
			expect(init.headers.Authorization).toBe(`Bot ${botToken}`);
			expect(JSON.parse(init.body)).toEqual({ archived: true, applied_tags: ["merged"] });
		});
	});
});
