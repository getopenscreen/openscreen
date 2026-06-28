import { warning } from "@actions/core";

const API_BASE = "https://discord.com/api/v10";

async function callDiscord(botToken, method, path, body) {
	const res = await fetch(`${API_BASE}${path}`, {
		method,
		headers: {
			Authorization: `Bot ${botToken}`,
			"Content-Type": "application/json",
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});

	if (res.status === 429) {
		const txt = await res.text();
		warning(`Discord rate-limited (429) on ${method} ${path}: ${txt}`);
		const err = new Error(`Discord rate-limited (429)`);
		err.rateLimited = true;
		throw err;
	}

	if (!res.ok) {
		const txt = await res.text();
		throw new Error(`Discord API ${method} ${path} failed ${res.status}: ${txt}`);
	}

	if (res.status === 204) return null;
	return res.json();
}

export async function createForumThread({ botToken, forumChannelId, payload }) {
	return callDiscord(botToken, "POST", `/channels/${forumChannelId}/threads`, payload);
}

export async function postChannelMessage({ botToken, channelId, payload }) {
	return callDiscord(botToken, "POST", `/channels/${channelId}/messages`, payload);
}

export async function patchChannel({ botToken, channelId, payload }) {
	return callDiscord(botToken, "PATCH", `/channels/${channelId}`, payload);
}
