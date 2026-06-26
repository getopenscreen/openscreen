import { info, warning } from "@actions/core";
import { context, getOctokit } from "@actions/github";

const ROADMAP_PATTERN = /(^|\/)ROADMAP\.md$|(^|\/)docs\/roadmap\.md$/i;
const ROADMAP_EMBED_TITLE = "🗺️ OpenScreen Roadmap";

const botToken = (process.env.DISCORD_BOT_TOKEN || "").trim();
const channelId = (process.env.DISCORD_ROADMAP_CHANNEL_ID || "").trim();
const overrideMessageId = (process.env.DISCORD_ROADMAP_MESSAGE_ID || "").trim();

async function main() {
	try {
		if (!botToken || !channelId) {
			info(
				"DISCORD_BOT_TOKEN or DISCORD_ROADMAP_CHANNEL_ID not set; skipping. " +
					"Configure both as repo secret / variable to enable #🗺️・roadmap auto-sync.",
			);
			return;
		}

		const octokit = getOctokit(process.env.GITHUB_TOKEN);

		// 0. Resolve the message id to update
		let existingMessageId = overrideMessageId;
		if (!existingMessageId) {
			try {
				const pinRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/pins`, {
					headers: { Authorization: `Bot ${botToken}` },
				});
				if (pinRes.ok) {
					const pins = await pinRes.json();
					const existing = pins.find((m) => m.embeds?.[0]?.title === ROADMAP_EMBED_TITLE);
					if (existing) {
						existingMessageId = existing.id;
						info(`Found existing pinned roadmap message ${existingMessageId}.`);
					} else {
						info("No existing pinned roadmap message found; will create one.");
					}
				} else {
					const txt = await pinRes.text();
					warning(`Failed to fetch pins (${pinRes.status}): ${txt}; falling back to POST.`);
				}
			} catch (err) {
				warning(
					`Pin lookup threw: ${err && err.message ? err.message : err}; falling back to POST.`,
				);
			}
		}

		// 1. Detect which files changed in this event
		let changedFiles = [];
		try {
			if (context.eventName === "pull_request_target") {
				const pr = context.payload.pull_request;
				if (!pr) {
					info("No PR context; skipping.");
					return;
				}
				const res = await octokit.rest.pulls.listFiles({
					owner: context.repo.owner,
					repo: context.repo.repo,
					pull_number: pr.number,
					per_page: 100,
				});
				changedFiles = res.data;
			} else if (context.eventName === "push") {
				const sha = context.payload.after || context.payload.head_commit?.id || context.sha;
				const res = await octokit.rest.repos.getCommit({
					owner: context.repo.owner,
					repo: context.repo.repo,
					ref: sha,
				});
				changedFiles = res.data.files || [];
			}
		} catch (err) {
			warning(`Failed to list changed files: ${err && err.message ? err.message : err}`);
			return;
		}

		const roadmapFiles = changedFiles.filter((f) => ROADMAP_PATTERN.test(f.filename));
		if (roadmapFiles.length === 0) {
			info("No roadmap files in event; skipping.");
			return;
		}

		// 2. Fetch the current ROADMAP.md content from main
		let content;
		try {
			const res = await octokit.rest.repos.getContent({
				owner: context.repo.owner,
				repo: context.repo.repo,
				path: "ROADMAP.md",
				ref: "main",
			});
			if (Array.isArray(res.data) || res.data.type !== "file" || !res.data.content) {
				warning("ROADMAP.md is not a readable file; skipping.");
				return;
			}
			content = Buffer.from(res.data.content, "base64").toString("utf-8");
		} catch (err) {
			warning(`Failed to fetch ROADMAP.md: ${err && err.message ? err.message : err}`);
			return;
		}

		// 3. Truncate if it exceeds Discord's embed description limit
		const rawUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/blob/main/ROADMAP.md`;
		const truncationNote = `\n\n… *(truncated, see [full file on GitHub](${rawUrl}))*`;
		const maxContentLength = 4096 - truncationNote.length;
		let description = content;
		let truncated = false;
		if (content.length > maxContentLength) {
			description = content.slice(0, maxContentLength) + truncationNote;
			truncated = true;
		}

		// 4. Build the embed payload
		const syncedAt = new Date().toISOString().split("T")[0];
		const payload = {
			embeds: [
				{
					title: ROADMAP_EMBED_TITLE,
					url: rawUrl,
					description,
					color: 1998671,
					footer: {
						text: `${context.repo.owner}/${context.repo.repo} • Last synced ${syncedAt}`,
					},
					timestamp: new Date().toISOString(),
				},
			],
			allowed_mentions: { parse: [] },
		};
		if (truncated) {
			payload.content = `⚠️ Roadmap exceeds Discord embed limit; truncated. See the [full file on GitHub](${rawUrl}) for the complete version.`;
		}

		// 5. PATCH the existing message, or POST a new one
		let messageId = existingMessageId;
		try {
			if (messageId) {
				const res = await fetch(
					`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
					{
						method: "PATCH",
						headers: {
							Authorization: `Bot ${botToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(payload),
					},
				);
				if (res.status === 404) {
					warning(
						`Existing message ${messageId} not found in Discord (was it deleted?). Falling back to POST.`,
					);
					messageId = "";
				} else if (!res.ok) {
					const txt = await res.text();
					warning(`Roadmap Discord PATCH failed ${res.status}: ${txt}`);
					return;
				} else {
					info(`Roadmap Discord message ${messageId} updated.`);
				}
			}

			if (!messageId) {
				const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
					method: "POST",
					headers: {
						Authorization: `Bot ${botToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(payload),
				});
				if (!res.ok) {
					const txt = await res.text();
					warning(`Roadmap Discord POST failed ${res.status}: ${txt}`);
					return;
				}
				const data = await res.json();
				messageId = data.id;
				info(`🆕 New roadmap message created with id ${messageId}.`);
				info(
					`👉 Set DISCORD_ROADMAP_MESSAGE_ID=${messageId} as a repo variable to update this message on future changes.`,
				);
				info(
					`   gh variable set DISCORD_ROADMAP_MESSAGE_ID ${messageId} --repo ${context.repo.owner}/${context.repo.repo}`,
				);
			}
		} catch (err) {
			warning(`Roadmap Discord sync threw: ${err && err.message ? err.message : err}`);
			return;
		}

		// 6. Pin the message
		try {
			const pinRes = await fetch(
				`https://discord.com/api/v10/channels/${channelId}/pins/${messageId}`,
				{
					method: "PUT",
					headers: {
						Authorization: `Bot ${botToken}`,
					},
				},
			);
			if (pinRes.status === 204 || pinRes.ok) {
				info(`Message ${messageId} pinned.`);
			} else if (pinRes.status === 403) {
				warning(
					"Cannot pin message: bot lacks 'Manage Messages' on the channel. Add it via Discord channel permissions.",
				);
			} else {
				const txt = await pinRes.text();
				warning(`Pin failed ${pinRes.status}: ${txt}`);
			}
		} catch (err) {
			warning(`Pin threw: ${err && err.message ? err.message : err}`);
		}
	} catch (err) {
		const msg = err && err.message ? err.message : String(err);
		warning(`Roadmap Discord sync failed: ${msg}`);
	}
}

main();
