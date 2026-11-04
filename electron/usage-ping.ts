// One anonymous count of the installations that ran today, and nothing else.
//
// No identifier leaves the machine: no install ID, no hardware hash, no cookie. PostHog
// requires a distinct_id, so each ping gets a fresh random one that matches nothing, and
// PostHog builds no person from it. Weekly and monthly actives are counted the way Brave
// counts them, without an ID: the app remembers locally when it last pinged and says
// whether this is its first ping of the week and of the month, so WAU and MAU are plain
// counts of those flags. To measure retention without an ID either, each ping also carries
// the ISO week the app was installed: a cohort shared by every install of that week, never
// finer than a week, and not an identifier. GeoIP is off on every event, and the PostHog
// project discards IP addresses. The website FAQ ("Does OpenScreen work offline?") and the
// privacy policy list this payload; keep them in step.

import { randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InstallChannel } from "./install-channel";

// A project token is public by design: it can only send events, not read them.
const POSTHOG_TOKEN = "phc_zhJDJHBBRDAJBwSb7zf2JuQ59v6RwBN96ZksM2y4oq8C";
const CAPTURE_URL = "https://eu.i.posthog.com/i/v0/e/";

/** Often enough that an app left running in the tray for days still counts every day. */
export const USAGE_PING_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UsagePingState {
	enabled: boolean;
	/** UTC day, ISO week and month of the last ping that went through. */
	day: string | null;
	week: string | null;
	month: string | null;
	/** ISO week of the installation, or "unknown" when it could not be dated. */
	installWeek: string | null;
}

export interface UsagePingFacts {
	version: string;
	os: NodeJS.Platform;
	arch: string;
	channel: InstallChannel;
	/** What the install was used through: the app's window, or `openscreen mcp` for an agent.
	 *  Both share one state file, so a day counts once, under whichever pinged first. */
	surface: "app" | "mcp";
}

const DEFAULT_STATE: UsagePingState = {
	enabled: true,
	day: null,
	week: null,
	month: null,
	installWeek: null,
};

/** An environment flag counts as set unless it is empty, "0" or "false": `CI=false` is off. */
const isSet = (value: string | undefined) =>
	value !== undefined && !["", "0", "false"].includes(value.toLowerCase());

/** The usual opt-out convention (consoledonottrack.com). */
export function doNotTrack(env: Readonly<Record<string, string | undefined>>): boolean {
	return isSet(env.DO_NOT_TRACK);
}

/** UTC, so the flags fall in the same buckets as PostHog's UTC days. */
export function periodKeys(now: Date): { day: string; week: string; month: string } {
	const iso = now.toISOString();
	// ISO 8601 week: the week belongs to the year of its Thursday.
	const thursday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
	const year = thursday.getUTCFullYear();
	const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
	return {
		day: iso.slice(0, 10),
		week: `${year}-W${String(week).padStart(2, "0")}`,
		month: iso.slice(0, 7),
	};
}

/** The install week, dated by when the userData directory was created. Electron creates it
 *  on first launch, so a fresh install gets the current week, and an install older than
 *  this field, even one that never pinged, gets its real one. Where the filesystem records
 *  no birthtime (0), the week is "unknown": mtime moves whenever the folder changes, and the
 *  week is kept for good once sent. */
export function installWeekFrom(stats: { birthtimeMs: number } | null): string {
	const date = new Date(stats?.birthtimeMs ?? 0);
	// Beyond ±8.64e15 ms a Date is invalid, and toISOString would throw outside any try.
	return date.getTime() > 0 ? periodKeys(date).week : "unknown";
}

/** "2026-W44" (weeks 01 to 53) or "unknown"; anything else is re-derived. */
const INSTALL_WEEK = /^(\d{4}-W(0[1-9]|[1-4]\d|5[0-3])|unknown)$/;

function statOrNull(dir: string) {
	try {
		return statSync(dir);
	} catch {
		return null;
	}
}

/** The ping to send now, or null. Pure, so the whole matrix pins from any platform. */
export function planUsagePing(
	state: UsagePingState,
	channel: InstallChannel,
	env: Readonly<Record<string, string | undefined>>,
	now: Date,
): { firstThisWeek: boolean; firstThisMonth: boolean; keys: ReturnType<typeof periodKeys> } | null {
	if (!state.enabled || channel === "dev" || doNotTrack(env) || isSet(env.CI)) return null;
	const keys = periodKeys(now);
	if (state.day === keys.day) return null;
	return {
		firstThisWeek: state.week !== keys.week,
		firstThisMonth: state.month !== keys.month,
		keys,
	};
}

function statePath(userData: string): string {
	return path.join(userData, "usage-ping.json");
}

export function loadUsagePingState(userData: string): UsagePingState {
	try {
		const raw = JSON.parse(readFileSync(statePath(userData), "utf8")) as Partial<UsagePingState>;
		const text = (value: unknown) => (typeof value === "string" ? value : null);
		return {
			enabled: raw.enabled !== false,
			day: text(raw.day),
			week: text(raw.week),
			month: text(raw.month),
			installWeek:
				typeof raw.installWeek === "string" && INSTALL_WEEK.test(raw.installWeek)
					? raw.installWeek
					: null,
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
}

function saveUsagePingState(userData: string, state: UsagePingState): void {
	try {
		writeFileSync(statePath(userData), `${JSON.stringify(state)}\n`, "utf8");
	} catch {
		// Best-effort: a failed write only means the next launch pings again.
	}
}

export function setUsagePingEnabled(userData: string, enabled: boolean): void {
	saveUsagePingState(userData, { ...loadUsagePingState(userData), enabled });
}

type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean }>;

/** Sends today's ping if none went through yet. Never throws: a failure only means the
 *  next attempt tries again, and the dates are saved only once PostHog accepted it. */
export async function sendUsagePing(
	userData: string,
	facts: UsagePingFacts,
	env: Readonly<Record<string, string | undefined>> = process.env,
	now: Date = new Date(),
	fetchImpl: Fetch = fetch,
): Promise<void> {
	const state = loadUsagePingState(userData);
	const plan = planUsagePing(state, facts.channel, env, now);
	if (!plan) return;
	// Kept once known, "unknown" included, so an install never changes cohort.
	const installWeek = state.installWeek ?? installWeekFrom(statOrNull(userData));
	try {
		const response = await fetchImpl(CAPTURE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				api_key: POSTHOG_TOKEN,
				event: "app_active",
				distinct_id: randomUUID(),
				properties: {
					$process_person_profile: false,
					$geoip_disable: true,
					version: facts.version,
					os: facts.os,
					arch: facts.arch,
					channel: facts.channel,
					surface: facts.surface,
					first_this_week: plan.firstThisWeek,
					first_this_month: plan.firstThisMonth,
					install_week: installWeek,
				},
			}),
			signal: AbortSignal.timeout(15_000),
		});
		// Re-read rather than reuse `state`: the tray checkbox may have changed while this ran.
		if (response.ok)
			saveUsagePingState(userData, {
				...loadUsagePingState(userData),
				...plan.keys,
				installWeek,
			});
	} catch {
		// Offline, blocked or timed out: the next attempt tries again.
	}
}
