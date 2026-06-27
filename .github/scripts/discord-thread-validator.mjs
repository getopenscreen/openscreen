import { warning } from "@actions/core";

export async function validateThreadChannel(threadId, prNumber, { botToken, forumChannelId } = {}) {
	if (!botToken) {
		warning(
			"DISCORD_BOT_TOKEN not set; cannot validate thread channel ownership. Rejecting marker.",
		);
		return false;
	}
	const VALIDATION_TIMEOUT_MS = 5_000;
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
		const res = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
			headers: { Authorization: `Bot ${botToken}` },
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!res.ok) {
			warning(`Thread validation failed: channel ${threadId} returned ${res.status}`);
			return false;
		}
		const channel = await res.json();
		if (forumChannelId && channel.parent_id !== forumChannelId) {
			warning(
				`Thread ${threadId} parent_id=${channel.parent_id} does not match expected forum ${forumChannelId}; treating marker as untrusted.`,
			);
			return false;
		}
		const expectedPrefix = `PR #${prNumber} -`;
		if (!channel.name || !channel.name.startsWith(expectedPrefix)) {
			warning(
				`Thread ${threadId} name "${channel.name}" does not match expected prefix "${expectedPrefix}"; treating marker as untrusted.`,
			);
			return false;
		}
		return true;
	} catch (err) {
		warning(`Thread validation threw: ${err && err.message ? err.message : err}`);
		return false;
	}
}
