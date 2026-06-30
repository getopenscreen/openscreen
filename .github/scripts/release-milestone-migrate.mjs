import { info, warning } from "@actions/core";
import { getOctokit } from "@actions/github";

const ROLLING_NAME = "Next Release";
const MARKER_PREFIX = "<!-- openscreen-rc-migrated:";

const token = (process.env.TOKEN || "").trim();
const nextVersion = (process.env.NEXT || "").trim();

if (!token || !nextVersion) {
	warning("TOKEN or NEXT missing; skipping milestone migration.");
	process.exit(0);
}

const versionedName = `v${nextVersion}`;
const owner = process.env.GITHUB_REPOSITORY_OWNER || "";
const repoFull = process.env.GITHUB_REPOSITORY || "";
const repo = repoFull.includes("/") ? repoFull.split("/")[1] : repoFull;

if (!owner || !repo) {
	warning("GITHUB_REPOSITORY not set; skipping.");
	process.exit(0);
}

const octokit = getOctokit(token);

async function findMilestone(title) {
	const all = await octokit.paginate(octokit.rest.issues.listMilestones, {
		owner,
		repo,
		state: "all",
		per_page: 100,
	});
	return all.find((m) => m.title === title) || null;
}

async function ensureMilestone(title) {
	const existing = await findMilestone(title);
	if (existing && existing.state === "open") return existing;
	if (existing) {
		const reopened = await octokit.rest.issues.updateMilestone({
			owner,
			repo,
			milestone_number: existing.number,
			state: "open",
		});
		info(`Reopened milestone "${title}".`);
		return reopened.data;
	}
	const created = await octokit.rest.issues.createMilestone({
		owner,
		repo,
		title,
		description: `Issues and PRs included in ${title}.`,
	});
	info(`Created milestone "${title}".`);
	return created.data;
}

async function listMilestoneItems(milestoneNumber) {
	return octokit.paginate(octokit.rest.issues.listForRepo, {
		owner,
		repo,
		milestone: `${milestoneNumber}`,
		state: "all",
		per_page: 100,
	});
}

async function hasMarker(issueNumber, versionedTitle) {
	const marker = `${MARKER_PREFIX}${versionedTitle} -->`;
	const comments = await octokit.paginate(octokit.rest.issues.listComments, {
		owner,
		repo,
		issue_number: issueNumber,
		per_page: 100,
	});
	return comments.some((c) => c.body && c.body.includes(marker));
}

async function main() {
	const rolling = await findMilestone(ROLLING_NAME);
	if (!rolling) {
		info(`Rolling milestone "${ROLLING_NAME}" not found; nothing to migrate.`);
		return;
	}

	const versioned = await ensureMilestone(versionedName);
	info(`Target milestone: ${versionedName} (#${versioned.number}).`);

	const items = await listMilestoneItems(rolling.number);
	info(`Found ${items.length} item(s) in "${ROLLING_NAME}".`);

	let moved = 0;
	let skipped = 0;
	for (const item of items) {
		if (await hasMarker(item.number, versionedName)) {
			skipped++;
			continue;
		}
		await octokit.rest.issues.update({
			owner,
			repo,
			issue_number: item.number,
			milestone: versioned.number,
		});
		const tag = `${MARKER_PREFIX}${versionedName} -->`;
		await octokit.rest.issues.createComment({
			owner,
			repo,
			issue_number: item.number,
			body: `${tag}\nMoved into \`${versionedName}\` as part of the pre-release cut.`,
		});
		moved++;
	}
	info(`Migrated ${moved}, skipped ${skipped} (already tagged).`);
}

await main();
