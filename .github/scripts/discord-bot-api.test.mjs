import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createForumThread, patchChannel, postChannelMessage } from "./discord-bot-api.mjs";

const botToken = "test-token";

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function mockResponse({ status = 200, body = { id: "x" } } = {}) {
	vi.mocked(fetch).mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		text: vi.fn().mockResolvedValue(JSON.stringify(body)),
		json: vi.fn().mockResolvedValue(body),
	});
}

const happyCases = [
	{
		name: "createForumThread",
		call: (args) => createForumThread(args),
		args: { forumChannelId: "forum-1", payload: { name: "PR #1" } },
		expectUrl: "https://discord.com/api/v10/channels/forum-1/threads",
		expectMethod: "POST",
		expectBody: { name: "PR #1" },
	},
	{
		name: "postChannelMessage",
		call: (args) => postChannelMessage(args),
		args: { channelId: "thread-1", payload: { content: "hello" } },
		expectUrl: "https://discord.com/api/v10/channels/thread-1/messages",
		expectMethod: "POST",
		expectBody: { content: "hello" },
	},
	{
		name: "patchChannel",
		call: (args) => patchChannel(args),
		args: { channelId: "thread-1", payload: { archived: true } },
		expectUrl: "https://discord.com/api/v10/channels/thread-1",
		expectMethod: "PATCH",
		expectBody: { archived: true },
	},
];

describe.each(happyCases)("$name", ({ call, args, expectUrl, expectMethod, expectBody }) => {
	it("calls Discord with the right URL, method, bot auth, and payload", async () => {
		mockResponse();

		await call({ ...args, botToken });

		const [url, init] = vi.mocked(fetch).mock.calls[0];
		expect(url).toBe(expectUrl);
		expect(init.method).toBe(expectMethod);
		expect(init.headers.Authorization).toBe(`Bot ${botToken}`);
		expect(JSON.parse(init.body)).toEqual(expectBody);
	});

	it("throws on 429 with rate-limit message", async () => {
		mockResponse({ status: 429, body: { retry_after: 1 } });
		await expect(call({ ...args, botToken })).rejects.toThrow(/rate-limited \(429\)/);
	});

	it("throws on non-ok responses with status in message", async () => {
		mockResponse({ status: 403, body: { message: "Missing Permissions" } });
		await expect(call({ ...args, botToken })).rejects.toThrow(/failed 403/);
	});
});
