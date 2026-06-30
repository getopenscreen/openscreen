import { info, warning } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { createForumThread, postChannelMessage } from "./discord-bot-api.mjs";

const botToken = (process.env.DISCORD_BOT_TOKEN || "").trim();
const channelId = (
	process.env.DISCORD_RC_TESTING_CHANNEL_ID ||
	process.env.DISCORD_RELEASE_CHANNEL_ID ||
	""
).trim();

const kind = (process.env.KIND || "stable").trim();
const stableTag = (process.env.STABLE_TAG || "").trim();
const rcTag = (process.env.RC_TAG || "").trim();
const extra = (process.env.EXTRA || "").trim();

if (!stableTag) {
	warning("STABLE_TAG missing; skipping.");
	process.exit(0);
}
if (!botToken || !channelId) {
	info("Discord announce skipped: set DISCORD_BOT_TOKEN and a channel id variable.");
	process.exit(0);
}

const owner = context.repo.owner;
const repo = context.repo.repo;
const releaseUrl = `${context.serverUrl}/${owner}/${repo}/releases/tag/${stableTag}`;
const stableVersion = stableTag.replace(/^v/, "").replace(/-.*$/, "");

let closedIssues = [];
if (process.env.GITHUB_TOKEN) {
	try {
		const octokit = getOctokit(process.env.GITHUB_TOKEN);
		const versionTitle = `v${stableVersion}`;
		const milestones = await octokit.paginate(octokit.rest.issues.listMilestones, {
			owner,
			repo,
			state: "closed",
			per_page: 100,
		});
		const m = milestones.find((x) => x.title === versionTitle);
		if (m) {
			const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
				owner,
				repo,
				milestone: `${m.number}`,
				state: "closed",
				per_page: 100,
			});
			closedIssues = issues
				.filter((i) => !i.pull_request)
				.slice(0, 20)
				.map((i) => `• [#${i.number}](${i.html_url}) ${i.title}`);
		}
	} catch (err) {
		warning(`Failed to fetch closed issues: ${err?.message ?? err}`);
	}
}

const isRc = kind === "rc";
const embedTitle = isRc
	? `🧪 ${stableTag} release candidate ready for testing`
	: `🚀 ${stableTag} released`;
const threadName = (isRc ? `${stableTag} RC — testing` : `${stableTag} released`).slice(0, 100);
const color = isRc ? 15844367 : 5814783;

const description = [
	extra ? `> ${extra}\n` : "",
	`📦 **Download:** [${stableTag}](${releaseUrl})`,
	isRc && rcTag ? `_Promoted from \`${rcTag}\`_` : "",
	closedIssues.length > 0 ? `\n**Closed issues in this release:**\n${closedIssues.join("\n")}` : "",
]
	.filter(Boolean)
	.join("\n");

const embed = {
	title: embedTitle,
	url: releaseUrl,
	description,
	color,
	timestamp: new Date().toISOString(),
};

// Discord channel types that require a thread wrapper (no top-level messages).
const FORUM_LIKE_TYPES = new Set([15, 16]); // 15 = GUILD_FORUM, 16 = GUILD_MEDIA

async function fetchChannelType() {
	const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
		headers: { Authorization: `Bot ${botToken}` },
	});
	if (!res.ok) {
		const txt = await res.text();
		warning(`Discord channel fetch failed ${res.status}: ${txt}`);
		return null;
	}
	return res.json();
}

async function announceToForum() {
	const thread = await createForumThread({
		botToken,
		forumChannelId: channelId,
		payload: {
			name: threadName,
			auto_archive_duration: 4320,
			message: {
				embeds: [embed],
				allowed_mentions: { parse: [] },
			},
		},
	});
	info(`📣 ${kind} announcement posted to forum thread ${thread.id}.`);
}

async function announceToText() {
	const result = await postChannelMessage({
		botToken,
		channelId,
		payload: {
			embeds: [embed],
			allowed_mentions: { parse: [] },
		},
	});
	info(`📣 ${kind} announcement posted to text channel (id=${result.id}).`);
}

const channel = await fetchChannelType();
if (!channel) {
	process.exit(0);
}

try {
	if (FORUM_LIKE_TYPES.has(channel.type)) {
		await announceToForum();
	} else {
		await announceToText();
	}
} catch (err) {
	warning(`Discord announce failed: ${err?.message ?? err}`);
}
