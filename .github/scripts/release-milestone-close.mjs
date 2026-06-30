import { info, warning } from "@actions/core";
import { getOctokit } from "@actions/github";

const token = (process.env.TOKEN || "").trim();
const stable = (process.env.STABLE_VERSION || "").trim();

if (!token || !stable) {
	warning("TOKEN or STABLE_VERSION missing; skipping milestone close.");
	process.exit(0);
}

const title = `v${stable}`;
const owner = process.env.GITHUB_REPOSITORY_OWNER || "";
const repoFull = process.env.GITHUB_REPOSITORY || "";
const repo = repoFull.includes("/") ? repoFull.split("/")[1] : repoFull;

if (!owner || !repo) {
	warning("GITHUB_REPOSITORY not set; skipping.");
	process.exit(0);
}

const octokit = getOctokit(token);

const open = await octokit.paginate(octokit.rest.issues.listMilestones, {
	owner,
	repo,
	state: "open",
	per_page: 100,
});
const m = open.find((x) => x.title === title);
if (!m) {
	info(`Open milestone "${title}" not found; nothing to close.`);
	process.exit(0);
}

await octokit.rest.issues.updateMilestone({
	owner,
	repo,
	milestone_number: m.number,
	state: "closed",
});
info(`Closed milestone "${title}" (#${m.number}).`);
