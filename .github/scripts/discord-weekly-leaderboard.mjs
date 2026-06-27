import { info, warning } from "@actions/core";
import { context, getOctokit } from "@actions/github";

const spotlightWebhook = (process.env.DISCORD_SPOTLIGHT_WEBHOOK_URL || "").trim();
const webhookUsername = (process.env.DISCORD_WEBHOOK_USERNAME || "OpenScreen").trim();
const webhookAvatar = (process.env.DISCORD_WEBHOOK_AVATAR_URL || "").trim();

async function main() {
	if (!spotlightWebhook) {
		info("DISCORD_SPOTLIGHT_WEBHOOK_URL missing. Skipping leaderboard post.");
		return;
	}

	const octokit = getOctokit(process.env.GITHUB_TOKEN);
	const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
	const owner = context.repo.owner;
	const repo = context.repo.repo;

	const q = `repo:${owner}/${repo} is:pr is:merged merged:>=${since.substring(0, 10)}`;

	let allItems = [];
	try {
		allItems = await octokit.paginate(octokit.rest.search.issuesAndPullRequests, {
			q,
			per_page: 100,
		});
	} catch (err) {
		warning(`Search API failed: ${err && err.message ? err.message : err}`);
		return;
	}
	const counter = new Map();
	for (const item of allItems) {
		const login = item.user?.login;
		if (!login) continue;
		counter.set(login, (counter.get(login) || 0) + 1);
	}

	const ranked = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

	const totalMerged = allItems.length;
	const lines = ranked.length
		? ranked
				.map(([user, count], idx) => `${idx + 1}. **${user}** - ${count} merged PR(s)`)
				.join("\n")
		: "No merged PRs this week.";

	const payload = {
		username: webhookUsername,
		...(webhookAvatar ? { avatar_url: webhookAvatar } : {}),
		embeds: [
			{
				title: "🌟 Weekly Contributor Leaderboard",
				description: lines,
				color: 1998671,
				fields: [
					{ name: "Merged PRs (7d)", value: String(totalMerged), inline: true },
					{ name: "Repository", value: `${owner}/${repo}`, inline: true },
					{ name: "Period", value: "Last 7 days", inline: true },
				],
				timestamp: new Date().toISOString(),
			},
		],
		allowed_mentions: { parse: [] },
	};

	const res = await fetch(`${spotlightWebhook}?wait=true`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!res.ok) {
		const txt = await res.text();
		warning(`Leaderboard post failed ${res.status}: ${txt}`);
	}
}

main();
