import { warning } from "@actions/core";

const API_BASE = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MS = 5_000;

async function callDiscord(botToken, method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	let res;
	try {
		res = await fetch(`${API_BASE}${path}`, {
			method,
			headers: {
				Authorization: `Bot ${botToken}`,
				"Content-Type": "application/json",
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}

	if (res.status === 429) {
		const txt = await res.text();
		warning(`Discord rate-limited (429) on ${method} ${path}: ${txt}`);
		throw new Error(`Discord rate-limited (429) on ${method} ${path}`);
	}

	if (!res.ok) {
		const txt = await res.text();
		throw new Error(`Discord API ${method} ${path} failed ${res.status}: ${txt}`);
	}

	if (res.status === 204) return null;
	return res.json();
}

export async function createForumThread({ botToken, forumChannelId, payload, timeoutMs }) {
	return callDiscord(botToken, "POST", `/channels/${forumChannelId}/threads`, payload, {
		timeoutMs,
	});
}

export async function postChannelMessage({ botToken, channelId, payload, timeoutMs }) {
	return callDiscord(botToken, "POST", `/channels/${channelId}/messages`, payload, { timeoutMs });
}

export async function patchChannel({ botToken, channelId, payload, timeoutMs }) {
	return callDiscord(botToken, "PATCH", `/channels/${channelId}`, payload, { timeoutMs });
}
