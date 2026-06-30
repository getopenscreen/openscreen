import { info, warning } from "@actions/core";
import { context, getOctokit } from "@actions/github";

const botToken = (process.env.DISCORD_BOT_TOKEN || "").trim();
const kind = (process.env.KIND || "stable").trim();
const stableTag = (process.env.STABLE_TAG || "").trim();
const rcTag = (process.env.RC_TAG || "").trim();
const extra = (process.env.EXTRA || "").trim();

const channelId =
	kind === "rc"
		? (process.env.DISCORD_RC_TESTING_CHANNEL_ID || "").trim()
		: (process.env.DISCORD_RELEASE_CHANNEL_ID || "").trim();

if (!botToken || !channelId) {
	info(
		`Discord ${kind} announcement skipped: missing DISCORD_BOT_TOKEN or channel id. ` +
			`Set DISCORD_${kind === "rc" ? "RC_TESTING_" : ""}CHANNEL_ID as a repo variable.`,
	);
	process.exit(0);
}
if (!stableTag) {
	warning("STABLE_TAG missing; skipping.");
	process.exit(0);
}

const owner = context.repo.owner;
const repo = context.repo.repo;
const releaseUrl = `${context.serverUrl}/${owner}/${repo}/releases/tag/${stableTag}`;

const octokit = getOctokit(process.env.GITHUB_TOKEN);

let releaseBody = "";
try {
	const r = await octokit.rest.repos.getReleaseByTag({
		owner,
		repo,
		tag: stableTag,
	});
	releaseBody = (r.data.body || "").slice(0, 1500);
} catch (err) {
	warning(`Failed to fetch release body: ${err?.message ?? err}`);
}

let closedIssues = [];
try {
	const versionTitle = `v${stableTag.replace(/^v/, "").replace(/-.*$/, "")}`;
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

const isRc = kind === "rc";
const title = isRc
	? `🧪 ${stableTag} release candidate ready for testing`
	: `🚀 ${stableTag} released`;
const color = isRc ? 15844367 : 5814783;

const description = [
	extra ? `> ${extra}\n` : "",
	`📦 **Download:** [${stableTag}](${releaseUrl})`,
	isRc && rcTag ? `_Promoted from \`${rcTag}\`_` : "",
	closedIssues.length > 0 ? `\n**Closed issues in this release:**\n${closedIssues.join("\n")}` : "",
	releaseBody ? `\n---\n${releaseBody}` : "",
]
	.filter(Boolean)
	.join("\n");

const payload = {
	embeds: [
		{
			title,
			url: releaseUrl,
			description,
			color,
			timestamp: new Date().toISOString(),
		},
	],
	allowed_mentions: { parse: [] },
};

try {
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
		warning(`Discord POST failed ${res.status}: ${txt}`);
		process.exit(0);
	}
	info(`📣 ${kind} announcement posted for ${stableTag} in channel ${channelId}.`);
} catch (err) {
	warning(`Discord throw: ${err?.message ?? err}`);
}
