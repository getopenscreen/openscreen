import { info, warning } from "@actions/core";
import { context, getOctokit } from "@actions/github";

const WEBHOOK_USERNAME = (process.env.DISCORD_WEBHOOK_USERNAME || "OpenScreen").trim();
const WEBHOOK_AVATAR = (process.env.DISCORD_WEBHOOK_AVATAR_URL || "").trim();

const THREAD_MARKER_REGEX = /<!--\s*discord-thread-id:(\d+)\s*-->/i;
const webhookUrl = (
	process.env.DISCORD_WEBHOOK_URL ||
	process.env.DISCORD_PR_FORUM_WEBHOOK ||
	""
).trim();
const botToken = (process.env.DISCORD_BOT_TOKEN || "").trim();
const reviewerRoleId = (process.env.DISCORD_REVIEWER_ROLE_ID || "").trim();
const alertWebhookUrl = (process.env.DISCORD_ALERT_WEBHOOK_URL || "").trim();
const forumChannelId = (process.env.DISCORD_PR_FORUM_CHANNEL_ID || "").trim();

const TAGS = {
	open: "1493976692967080096",
	draft: "1493976782028935279",
	ready: "1493976833626996756",
	changes: "1493976909875515564",
	approved: "1493976951038152764",
	merged: "1493977049709281320",
	closed: "1493977108102516786",
};

const labelTagMap = {
	bug: "1493977562773458975",
	enhancement: "1493977619216207993",
	documentation: "1493978565153394830",
};

function cleanDescription(text, maxLen = 3500) {
	if (!text) return "No description provided.";
	const normalized = text
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (normalized.length <= maxLen) return normalized;
	return `${normalized.slice(0, maxLen - 1)}…`;
}

function trimThreadName(name) {
	return name.length > 95 ? name.slice(0, 95) : name;
}

function extractThreadId(body) {
	if (!body) return null;
	const match = body.match(THREAD_MARKER_REGEX);
	return match ? match[1] : null;
}

async function validateThreadChannel(threadId) {
	if (!botToken || !forumChannelId) return true;
	try {
		const res = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
			headers: { Authorization: `Bot ${botToken}` },
		});
		if (!res.ok) {
			warning(`Thread validation failed: channel ${threadId} returned ${res.status}`);
			return false;
		}
		const channel = await res.json();
		if (channel.parent_id !== forumChannelId) {
			warning(
				`Thread ${threadId} parent_id=${channel.parent_id} does not match expected forum ${forumChannelId}; treating marker as untrusted.`,
			);
			return false;
		}
		return true;
	} catch (err) {
		warning(`Thread validation threw: ${err && err.message ? err.message : err}`);
		return false;
	}
}

function upsertThreadMarker(body, threadId) {
	const cleaned = (body || "").replace(THREAD_MARKER_REGEX, "").trim();
	return `${cleaned}\n\n<!-- discord-thread-id:${threadId} -->`.trim();
}

async function discordPost(payload, options = {}) {
	const endpoint = new URL(webhookUrl);
	endpoint.searchParams.set("wait", "true");
	if (options.threadId) endpoint.searchParams.set("thread_id", String(options.threadId));

	const response = await fetch(endpoint.toString(), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			username: WEBHOOK_USERNAME,
			avatar_url: WEBHOOK_AVATAR,
			allowed_mentions: { parse: [] },
			...payload,
		}),
	});

	const contentType = (response.headers.get("content-type") || "").toLowerCase();
	const text = await response.text();

	if (!response.ok) {
		throw new Error(`Discord API error ${response.status}: ${text}`);
	}

	if (!text) return {};
	if (contentType.includes("application/json")) return JSON.parse(text);

	warning(
		`Discord webhook returned non-JSON response (content-type: ${contentType || "unknown"}).`,
	);
	return {};
}

async function patchDiscordThread(threadId, patchBody) {
	if (!botToken || !threadId) return;
	const response = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
		method: "PATCH",
		headers: {
			Authorization: `Bot ${botToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(patchBody),
	});
	if (!response.ok) {
		const text = await response.text();
		warning(`Discord thread patch failed (${response.status}): ${text}`);
	}
}

function desiredStatusTag(prState) {
	if (prState.merged && TAGS.merged) return TAGS.merged;
	if (prState.closed && !prState.merged && TAGS.closed) return TAGS.closed;
	if (prState.reviewState === "CHANGES_REQUESTED" && TAGS.changes) return TAGS.changes;
	if (prState.reviewState === "APPROVED" && TAGS.approved) return TAGS.approved;
	if (prState.draft && TAGS.draft) return TAGS.draft;
	if (!prState.draft && TAGS.ready) return TAGS.ready;
	return TAGS.open || null;
}

function tagIdsFromLabels(labels) {
	const out = [];
	for (const label of labels) {
		const mapped = labelTagMap[label.toLowerCase()] || labelTagMap[label];
		if (mapped) out.push(String(mapped));
	}
	return out;
}

async function getPullRequest(octokit) {
	if (context.eventName === "pull_request_target" || context.eventName === "pull_request_review") {
		return context.payload.pull_request || null;
	}
	if (context.eventName === "issue_comment") {
		const issue = context.payload.issue;
		if (!issue?.pull_request) return null;
		const { data } = await octokit.rest.pulls.get({
			owner: context.repo.owner,
			repo: context.repo.repo,
			pull_number: issue.number,
		});
		return data;
	}
	return null;
}

async function getReviewState(octokit, owner, repo, pullNumber) {
	const { data } = await octokit.rest.pulls.listReviews({
		owner,
		repo,
		pull_number: pullNumber,
		per_page: 100,
	});
	let hasChanges = false;
	let hasApproved = false;
	for (const r of data) {
		const s = (r.state || "").toUpperCase();
		if (s === "CHANGES_REQUESTED") hasChanges = true;
		if (s === "APPROVED") hasApproved = true;
	}
	if (hasChanges) return "CHANGES_REQUESTED";
	if (hasApproved) return "APPROVED";
	return "NONE";
}

async function main() {
	try {
		const octokit = getOctokit(process.env.GITHUB_TOKEN);

		const pr = await getPullRequest(octokit);
		if (!pr) {
			info("No PR context found. Skipping.");
			return;
		}

		if (!webhookUrl) {
			warning(
				`Discord sync skipped: webhook secret unavailable for event '${context.eventName}'. ` +
					"Set either DISCORD_WEBHOOK_URL or DISCORD_PR_FORUM_WEBHOOK in repository secrets.",
			);
			return;
		}

		const action = context.payload.action || "";
		const owner = context.repo.owner;
		const repo = context.repo.repo;
		const number = pr.number;
		const title = pr.title;
		const author = pr.user?.login || "unknown";
		const url = pr.html_url;
		const authorUrl = pr.user?.html_url || "";
		const authorAvatar = pr.user?.avatar_url || "";
		const base = pr.base?.ref || "";
		const head = pr.head?.ref || "";
		const repoFullName = pr.base?.repo?.full_name || `${owner}/${repo}`;
		const labels = (pr.labels || []).map((l) => l.name);
		const body = (pr.body || "").trim();
		const reviewState = await getReviewState(octokit, owner, repo, number);

		let threadId = extractThreadId(body);
		const shouldCreateThread =
			context.eventName === "pull_request_target" &&
			["opened", "reopened", "ready_for_review"].includes(action) &&
			!threadId;

		if (shouldCreateThread) {
			const fields = [
				{ name: "PR", value: `[#${number}](${url})`, inline: true },
				{ name: "Author", value: `[${author}](${authorUrl || url})`, inline: true },
				{ name: "Status", value: pr.draft ? "Draft" : "Open", inline: true },
				{ name: "Branches", value: `\`${head}\` -> \`${base}\``, inline: true },
				{ name: "Changes", value: `+${pr.additions} / -${pr.deletions}`, inline: true },
				{ name: "Files Changed", value: String(pr.changed_files), inline: true },
			];

			if (labels.length) {
				fields.push({
					name: "Labels",
					value: labels.map((l) => `\`${l}\``).join(" "),
					inline: false,
				});
			}

			const statusTag = desiredStatusTag({
				draft: pr.draft,
				reviewState,
				merged: false,
				closed: false,
			});
			const mappedLabelTags = tagIdsFromLabels(labels);
			const appliedTags = [...new Set([statusTag, ...mappedLabelTags].filter(Boolean))].slice(0, 5);

			const createPayload = {
				content:
					action === "ready_for_review"
						? "🔔 PR is now ready for review"
						: "🔔 New pull request opened",
				thread_name: trimThreadName(`PR #${number} - ${title}`),
				applied_tags: appliedTags,
				embeds: [
					{
						title: `PR #${number}: ${title}`,
						url,
						description: cleanDescription(body),
						color: pr.draft ? 15105570 : 1998671,
						author: {
							name: author,
							url: authorUrl || undefined,
							icon_url: authorAvatar || undefined,
						},
						fields,
						footer: { text: repoFullName },
						timestamp: new Date().toISOString(),
					},
				],
			};

			const result = await discordPost(createPayload);
			const createdThreadId = result.channel_id || null;
			if (createdThreadId) {
				const updatedBody = upsertThreadMarker(body, createdThreadId);
				await octokit.rest.pulls.update({ owner, repo, pull_number: number, body: updatedBody });
				info(`Created Discord thread ${createdThreadId} and stored mapping.`);
			} else {
				warning("Discord thread created but channel_id missing in response.");
			}
			return;
		}

		if (!threadId) {
			info("No mapped Discord thread ID found; skipping update event.");
			return;
		}

		if (!(await validateThreadChannel(threadId))) {
			info("Thread ID in PR body failed channel validation; ignoring marker.");
			return;
		}

		if (
			context.eventName === "pull_request_target" &&
			["edited", "labeled", "unlabeled", "ready_for_review", "converted_to_draft"].includes(action)
		) {
			const statusTag = desiredStatusTag({
				draft: action === "converted_to_draft" ? true : pr.draft,
				reviewState,
				merged: false,
				closed: false,
			});
			const mappedLabelTags = tagIdsFromLabels(labels);
			const appliedTags = [...new Set([statusTag, ...mappedLabelTags].filter(Boolean))].slice(0, 5);
			await patchDiscordThread(threadId, {
				name: trimThreadName(`PR #${number} - ${title}`),
				...(appliedTags.length ? { applied_tags: appliedTags } : {}),
			});
		}

		let updateMessage = null;
		let updateEmbed = null;

		if (context.eventName === "pull_request_target") {
			if (action === "synchronize") {
				const { data: commits } = await octokit.rest.pulls.listCommits({
					owner,
					repo,
					pull_number: number,
					per_page: 5,
				});
				const list =
					commits
						.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.commit.message.split("\n")[0]}`)
						.join("\n") || "- No commit details";
				updateMessage = `🧩 New commits pushed to PR #${number}`;
				updateEmbed = {
					title: `Commit Update • PR #${number}`,
					url: `${url}/files`,
					description: `${list}`,
					color: 1998671,
					footer: { text: repoFullName },
					timestamp: new Date().toISOString(),
				};
			} else if (action === "edited") {
				updateMessage = `✏️ PR #${number} details were edited`;
				updateEmbed = {
					title: `PR Updated • #${number}`,
					url,
					description: cleanDescription(body, 1200),
					color: 1998671,
					timestamp: new Date().toISOString(),
				};
			} else if (action === "closed") {
				const isMerged = !!pr.merged;
				const statusTag = desiredStatusTag({
					draft: false,
					reviewState,
					merged: isMerged,
					closed: true,
				});
				const mappedLabelTags = tagIdsFromLabels(labels);
				const appliedTags = [...new Set([statusTag, ...mappedLabelTags].filter(Boolean))].slice(
					0,
					5,
				);
				await patchDiscordThread(threadId, {
					...(appliedTags.length ? { applied_tags: appliedTags } : {}),
					...(isMerged ? { archived: true, locked: true } : {}),
				});

				updateMessage = isMerged
					? `✅ PR #${number} was merged`
					: `🛑 PR #${number} was closed without merge`;
				updateEmbed = {
					title: isMerged ? `Merged • PR #${number}` : `Closed • PR #${number}`,
					url,
					description: isMerged
						? "This PR has been merged into the base branch."
						: "This PR was closed before merge.",
					color: isMerged ? 5763719 : 15158332,
					timestamp: new Date().toISOString(),
				};
			} else if (action === "ready_for_review") {
				updateMessage = `🚀 PR #${number} moved from draft to ready for review`;
				if (reviewerRoleId) updateMessage += ` <@&${reviewerRoleId}>`;
			} else if (action === "converted_to_draft") {
				updateMessage = `📝 PR #${number} converted to draft`;
			}
		} else if (context.eventName === "pull_request_review") {
			const review = context.payload.review;
			if (review) {
				const state = (review.state || "commented").toUpperCase();
				const reviewer = review.user?.login || "reviewer";
				updateMessage = `🧪 Review ${state} by **${reviewer}** on PR #${number}`;
				if (state === "CHANGES_REQUESTED" && reviewerRoleId)
					updateMessage += ` <@&${reviewerRoleId}>`;
				updateEmbed = {
					title: `Review ${state} • PR #${number}`,
					url: review.html_url || url,
					description: cleanDescription(review.body || "No review note.", 1000),
					color:
						state === "APPROVED" ? 5763719 : state === "CHANGES_REQUESTED" ? 15158332 : 1998671,
					timestamp: new Date().toISOString(),
				};

				if (state === "CHANGES_REQUESTED" || state === "APPROVED") {
					const statusTag = desiredStatusTag({
						draft: pr.draft,
						reviewState: state,
						merged: false,
						closed: false,
					});
					const mappedLabelTags = tagIdsFromLabels(labels);
					const appliedTags = [...new Set([statusTag, ...mappedLabelTags].filter(Boolean))].slice(
						0,
						5,
					);
					await patchDiscordThread(threadId, {
						...(appliedTags.length ? { applied_tags: appliedTags } : {}),
					});
				}
			}
		} else if (context.eventName === "issue_comment") {
			const comment = context.payload.comment;
			if (comment) {
				const commenter = comment.user?.login || "user";
				updateMessage = `💬 New comment by **${commenter}** on PR #${number}`;
				updateEmbed = {
					title: `New PR Comment • #${number}`,
					url: comment.html_url || url,
					description: cleanDescription(comment.body || "No comment body.", 1000),
					color: 1998671,
					timestamp: new Date().toISOString(),
				};
			}
		}

		if (!updateMessage && !updateEmbed) {
			info("No Discord update message for this event/action. Skipping.");
			return;
		}

		const payload = { content: updateMessage || "" };
		if (updateEmbed) payload.embeds = [updateEmbed];
		await discordPost(payload, { threadId });
		info(`Posted update to Discord thread ${threadId}.`);
	} catch (err) {
		const msg = err && err.message ? err.message : String(err);
		warning(
			`Discord sync failed, but this optional automation will not block PR validation: ${msg}`,
		);

		if (alertWebhookUrl) {
			try {
				await fetch(alertWebhookUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						username: "OpenScreen",
						avatar_url: WEBHOOK_AVATAR,
						content: `⚠️ PR->Discord sync failed\n${msg}\nRun: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
						allowed_mentions: { parse: [] },
					}),
				});
			} catch {
				warning("Failed to send alert webhook.");
			}
		}
	}
}

main();
