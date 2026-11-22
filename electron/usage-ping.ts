// One anonymous count of the installations that ran today, and with it how many times an
// agent called each tool of the MCP server. Nothing else.
//
// No identifier leaves the machine: no install ID, no hardware hash, no cookie. PostHog
// requires a distinct_id, so each ping gets a fresh random one that matches nothing, and
// PostHog builds no person from it. Weekly and monthly actives are counted the way Brave
// counts them, without an ID: the app remembers locally when it last pinged and says
// whether this is its first ping of the week and of the month, so WAU and MAU are plain
// counts of those flags. To measure retention without an ID either, each ping also carries
// the ISO week the app was installed: a cohort shared by every install of that week, never
// finer than a week, and not an identifier. GeoIP is off on every event, and the PostHog
// project discards IP addresses. The tool counts are a tool's name and a number: never an
// argument, a path or anything a tool returned. They ride the daily ping, so counting adds no
// connection. The website FAQ ("Does OpenScreen work offline?") and the privacy policy list
// this payload; keep them in step.

import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renameSyncWithFallback } from "./atomic-rename";
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
	/** MCP tool calls no ping has carried yet, by tool name. */
	tools: Record<string, number>;
	/** The checkbox's generation the counts were made under (see `generationPath`). */
	generation: number;
	/** The counts a ping took on its way out, until PostHog answers: no other ping carries them. */
	sending: { id: string; at: number; tools: Record<string, number>; pid?: number } | null;
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
	tools: {},
	generation: 0,
	sending: null,
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

/** "2026-W44" (weeks 01 to 53) or "unknown"; anything else is re-derived. */
const INSTALL_WEEK = /^(\d{4}-W(0[1-9]|[1-4]\d|5[0-3])|unknown)$/;

/** The install week, dated by when the userData directory was created. Electron creates it
 *  on first launch, so a fresh install gets the current week, and an install older than
 *  this field, even one that never pinged, gets its real one. Where the filesystem records
 *  no birthtime (0), the week is "unknown": mtime moves whenever the folder changes, and the
 *  week is kept for good once sent. */
export function installWeekFrom(stats: { birthtimeMs: number } | null): string {
	const date = new Date(stats?.birthtimeMs ?? 0);
	// Beyond ±8.64e15 ms a Date is invalid, and toISOString would throw outside any try.
	if (!(date.getTime() > 0)) return "unknown";
	// A week the loader would reject (year 10000 and on) would be re-derived on every ping.
	const { week } = periodKeys(date);
	return INSTALL_WEEK.test(week) ? week : "unknown";
}

/** A tool's name as the server registers it: letters and digits, nothing a client wrote. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** More names than the server has tools, and more calls than a day holds: a file someone
 *  edited by hand sends nothing larger. */
const MAX_TOOLS = 200;
const MAX_TOOL_CALLS = 100_000;

function toolCounts(raw: unknown): Record<string, number> {
	const counts: Record<string, number> = {};
	if (!raw || typeof raw !== "object") return counts;
	for (const [name, count] of Object.entries(raw).slice(0, MAX_TOOLS)) {
		if (TOOL_NAME.test(name) && Number.isInteger(count) && count > 0) {
			counts[name] = Math.min(count, MAX_TOOL_CALLS);
		}
	}
	return counts;
}

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

/**
 * The checkbox's choice, "on" or "off", in a file of its own that only the checkbox writes. The
 * app and `openscreen mcp` rewrite the state file whole: a choice kept there alone could be
 * written over by a process that read it before, or not written at all while another holds the
 * state's lock. Without this file, the state file's `enabled` says, as for the builds before it.
 */
function choicePath(userData: string): string {
	return path.join(userData, "usage-ping.choice");
}

/**
 * A number the tray's checkbox alone bumps, in a file of its own like the opt-out. Counts saved
 * under another one were made before the user's last choice: a stale writer cannot bring them
 * back, and a ping in flight across that choice takes nothing off the counts made since.
 */
function generationPath(userData: string): string {
	return path.join(userData, "usage-ping.gen");
}

function generationOf(userData: string): number {
	try {
		const value = Number(readFileSync(generationPath(userData), "utf8"));
		return Number.isSafeInteger(value) && value > 0 ? value : 0;
	} catch {
		return 0;
	}
}

export function loadUsagePingState(userData: string): UsagePingState {
	const choice = readOrNull(choicePath(userData))?.trim();
	const chosen = choice === "on" ? true : choice === "off" ? false : null;
	const generation = generationOf(userData);
	try {
		const raw = JSON.parse(readFileSync(statePath(userData), "utf8")) as Partial<UsagePingState>;
		const text = (value: unknown) => (typeof value === "string" ? value : null);
		const countedUnder = Number.isSafeInteger(raw.generation) ? raw.generation : 0;
		const sending = raw.sending as Partial<NonNullable<UsagePingState["sending"]>> | null;
		return {
			enabled: chosen ?? raw.enabled !== false,
			day: text(raw.day),
			week: text(raw.week),
			month: text(raw.month),
			installWeek:
				typeof raw.installWeek === "string" && INSTALL_WEEK.test(raw.installWeek)
					? raw.installWeek
					: null,
			tools: countedUnder === generation ? toolCounts(raw.tools) : {},
			generation,
			// A claim goes with the counts of its generation.
			sending:
				countedUnder === generation &&
				typeof sending?.id === "string" &&
				typeof sending.at === "number" &&
				Number.isFinite(sending.at)
					? {
							id: sending.id,
							at: sending.at,
							tools: toolCounts(sending.tools),
							...(Number.isSafeInteger(sending.pid) ? { pid: sending.pid } : {}),
						}
					: null,
		};
	} catch {
		return { ...DEFAULT_STATE, enabled: chosen ?? true, tools: {}, generation };
	}
}

/**
 * Writes `text` to `file` through a staged copy renamed over it: a reader never meets it half
 * written, and a write cut short leaves the previous one whole. False when it did not write.
 */
function writeWhole(file: string, text: string): boolean {
	const part = `${file}.${randomUUID()}.part`;
	try {
		writeFileSync(part, text, "utf8");
		renameSyncWithFallback(part, file);
		return true;
	} catch {
		dropFile(part);
		return false;
	}
}

function saveUsagePingState(userData: string, state: UsagePingState): boolean {
	// Best-effort: a failed write only means the next launch pings again.
	return writeWhole(statePath(userData), `${JSON.stringify(state)}\n`);
}

function readOrNull(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

const LOCK_PAUSE = new Int32Array(new SharedArrayBuffer(4));
/** How long a change waits for the lock. Timed, not counted in pauses: Windows sleeps 15 ms at
 *  least, whatever is asked. */
const LOCK_WAIT_MS = 1_000;
/** A lock that names no running process, held longer, was left by one that died holding it. */
const STALE_LOCK_MS = 2_000;
/** Held longer, a lock is taken whoever holds it: that process is stuck, or its number reused. */
const STUCK_LOCK_MS = 10 * 60_000;
/** A ping's claim naming no running process, held longer, was left by one that died before
 *  PostHog answered. One whose process still runs is kept, a sleeping machine included, up to an
 *  hour: past that, that process is stuck or its number reused. */
const SENDING_CLAIM_MS = 60_000;
const STUCK_CLAIM_MS = 60 * 60_000;
/** Between two attempts to record PostHog's answer while another process holds the lock. */
const ACK_RETRY_MS = 2_000;

/** Whether the process a lock names still runs; `null` when it names none. */
function holderRuns(content: string | null): boolean | null {
	const pid = Number(content?.split(":")[0]);
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it runs, as another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Writes the state while the change still holds the lock; false when it did not write. */
type Save = (state: UsagePingState) => boolean;

/**
 * The app and every `openscreen mcp` (one per agent session) read, change and rewrite the state
 * file. A change runs holding `usage-ping.lock`, made exclusively and naming its process and a
 * token of its own, and writes only while the lock still holds them. A lock is taken as abandoned
 * only once the process it names is gone: one that stalls, even between its check and its
 * write, keeps it, so nothing newer can be written under it. A change that waited a second for
 * the lock is dropped: what is lost is a count, never a write over a newer one. The checkbox does
 * not wait on this: its choice is in files of its own (`setUsagePingEnabled`).
 */
export function withStateLock<T>(userData: string, change: (save: Save) => T): T | undefined {
	const lock = path.join(userData, "usage-ping.lock");
	const token = `${process.pid}:${randomUUID()}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			writeFileSync(lock, token, { flag: "wx" });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const held = statOrNull(lock);
			// Gone meanwhile: take it at once. Windows answers EPERM for a file it is still
			// deleting; any other refusal, or EPERM with no file, is a folder that takes no lock.
			if (!held) {
				if (code === "EEXIST") continue;
				return undefined;
			}
			if (code !== "EEXIST" && code !== "EPERM") return undefined;
			const heldMs = Date.now() - held.mtimeMs;
			const content = readOrNull(lock);
			const runs = holderRuns(content);
			const abandoned =
				runs === false || (runs === null && heldMs > STALE_LOCK_MS) || heldMs > STUCK_LOCK_MS;
			if (abandoned) breakAbandonedLock(lock, content);
			else Atomics.wait(LOCK_PAUSE, 0, 0, 5);
			continue;
		}
		const mine = () => readOrNull(lock) === token;
		try {
			return change((state) => mine() && saveUsagePingState(userData, state));
		} finally {
			if (mine()) dropFile(lock);
		}
	}
	return undefined;
}

/**
 * Takes away the lock judged abandoned, and that one only. It is renamed aside first, which one
 * process alone can do. If what was renamed is not the lock judged (another process broke it in
 * between and holds a new one), it is put back, unless yet another lock has taken its place: its
 * holder's writes then fail their check and are dropped, as `withStateLock` says.
 */
export function breakAbandonedLock(lock: string, judged: string | null): void {
	const aside = `${lock}.${randomUUID()}.stale`;
	try {
		renameSync(lock, aside);
	} catch {
		return;
	}
	if (readOrNull(aside) !== judged) {
		try {
			linkSync(aside, lock);
		} catch {
			// Another lock is there now.
		}
	}
	dropFile(aside);
}

function dropFile(file: string): void {
	try {
		rmSync(file, { force: true });
	} catch {
		// Already gone.
	}
}

function added(counts: Record<string, number>, more: Record<string, number>) {
	const sum = { ...counts };
	for (const [name, count] of Object.entries(more)) {
		sum[name] = Math.min((sum[name] ?? 0) + count, MAX_TOOL_CALLS);
	}
	return sum;
}

export function setUsagePingEnabled(userData: string, enabled: boolean): void {
	// The choice is in two files only this checkbox writes, outside the state lock, so it holds
	// at once whatever another process is doing: the choice file says whether to count, and the
	// new generation drops every count, and every ping's claim, made before it.
	writeWhole(generationPath(userData), String(generationOf(userData) + 1));
	writeWhole(choicePath(userData), enabled ? "on" : "off");
	// The state file's own `enabled`, for the builds that predate the choice file.
	withStateLock(userData, (save) =>
		save({ ...loadUsagePingState(userData), enabled, tools: {}, sending: null }),
	);
}

/**
 * Counts one call of an MCP tool, for the next ping to carry. The same opt-outs as the ping:
 * turned off, in a dev build, under DO_NOT_TRACK or CI, nothing is counted at all.
 */
export function countToolCall(
	userData: string,
	channel: InstallChannel,
	name: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): void {
	if (channel === "dev" || doNotTrack(env) || isSet(env.CI) || !TOOL_NAME.test(name)) return;
	withStateLock(userData, (save) => {
		const state = loadUsagePingState(userData);
		if (state.enabled) save({ ...state, tools: added(state.tools, { [name]: 1 }) });
	});
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
	// The counts it carries are claimed before the ping leaves: a ping from another process
	// meanwhile finds the claim and leaves this day to it, so no count rides two pings.
	const claim = withStateLock(userData, (save) => {
		const state = loadUsagePingState(userData);
		const plan = planUsagePing(state, facts.channel, env, now);
		if (!plan) return null;
		if (state.sending) {
			const age = Date.now() - state.sending.at;
			const sender = holderRuns(String(state.sending.pid));
			if (sender === true ? age < STUCK_CLAIM_MS : sender === null && age < SENDING_CLAIM_MS) {
				return null;
			}
		}
		// A claim nobody finished, its process gone: its counts go out with this ping.
		const tools = added(state.tools, state.sending?.tools ?? {});
		const id = randomUUID();
		const sending = { id, at: Date.now(), tools, pid: process.pid };
		if (!save({ ...state, tools: {}, sending })) return null;
		// Kept once known, "unknown" included, so an install never changes cohort.
		const installWeek = state.installWeek ?? installWeekFrom(statOrNull(userData));
		return { id, tools, plan, installWeek };
	});
	if (!claim) return;
	const { plan, installWeek, tools: sentTools } = claim;
	// The checkbox may have been unticked, or the claim cleared, since it was made: then nothing
	// goes out. Nothing is awaited between this check and the request.
	const still = loadUsagePingState(userData);
	if (!still.enabled || still.sending?.id !== claim.id) return;
	let delivered = false;
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
					...(Object.keys(sentTools).length > 0 ? { mcp_tools: sentTools } : {}),
				},
			}),
			signal: AbortSignal.timeout(15_000),
		});
		delivered = response.ok;
	} catch {
		// Offline, blocked or timed out: the next attempt tries again.
	}
	// Delivered, the claim's counts are gone and the day is counted, unless a later ping already
	// recorded a later day. Refused, they go back with the counts made meanwhile. A claim the
	// checkbox cleared meanwhile took its counts with it.
	const record = (save: Save): boolean => {
		const latest = loadUsagePingState(userData);
		const ours = latest.sending?.id === claim.id;
		if (delivered) {
			const later = latest.day !== null && latest.day > plan.keys.day;
			return save({
				...latest,
				...(later ? {} : plan.keys),
				installWeek: latest.installWeek ?? installWeek,
				sending: ours ? null : latest.sending,
			});
		}
		return !ours || save({ ...latest, tools: added(latest.tools, sentTools), sending: null });
	};
	// Recorded under the lock: one held elsewhere past the wait is waited for again, a few times,
	// and nothing is sent again meanwhile.
	for (let attempt = 0; attempt < 5; attempt++) {
		if (withStateLock(userData, record) === true) return;
		await new Promise((resolve) => setTimeout(resolve, ACK_RETRY_MS));
	}
}
