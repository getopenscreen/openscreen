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

import { randomBytes, randomUUID } from "node:crypto";
import {
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
	/** MCP tool calls no ping has carried yet, by tool name. */
	tools: Record<string, number>;
	/** The counts a ping took on its way out, until PostHog answers: no other ping carries them.
	 *  `dispatched` once the request was handed over: an opt-out after that finds it gone. */
	sending: {
		id: string;
		at: number;
		tools: Record<string, number>;
		pid?: number;
		dispatched?: true;
	} | null;
}

export interface UsagePingFacts {
	version: string;
	os: NodeJS.Platform;
	arch: string;
	channel: InstallChannel;
	/** What the install was used through: the app's window, or `openscreen mcp` for an agent.
	 *  Both share one state, so a day counts once, under whichever pinged first. */
	surface: "app" | "mcp";
}

const DEFAULT_STATE: UsagePingState = {
	enabled: true,
	day: null,
	week: null,
	month: null,
	installWeek: null,
	tools: {},
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

function added(counts: Record<string, number>, more: Record<string, number>) {
	const sum = { ...counts };
	for (const [name, count] of Object.entries(more)) {
		sum[name] = Math.min((sum[name] ?? 0) + count, MAX_TOOL_CALLS);
	}
	return sum;
}

function statOrNull(file: string) {
	try {
		return statSync(file);
	} catch {
		return null;
	}
}

function dropFile(file: string): void {
	try {
		rmSync(file, { force: true });
	} catch {
		// Already gone.
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

// The state is a sequence of versions, `usage-ping/<n>.json`, each written once and never
// replaced. The app and every `openscreen mcp` (one per agent session) change it, and a plain
// file cannot be replaced "only if nobody replaced it first"; a name can be given to a file
// "only if it is not taken yet". So a change reads the newest version n, writes its own version
// whole under a name of its own, then links it as n + 1, which fails when n + 1 is taken. A
// version is therefore whole from the moment it has a number. When another change took n + 1
// first, this one reads again and starts over: no change ever lands on an older state than the
// one it replaces, however long its process stalled, and no lock is held, so none is ever taken
// from anyone. The checkbox's choice and each ping's claim and hand-over are such changes too,
// so they fall in one order. A change built on a version first tells that version's writer,
// which may not have checked yet, that it landed: what a change is built on is the newest
// version, and a version given a number the collection freed while its writer stalled never is.

/** The released builds kept one file; a version-less install starts from it. */
function legacyPath(userData: string): string {
	return path.join(userData, "usage-ping.json");
}

function versionsDir(userData: string): string {
	return path.join(userData, "usage-ping");
}

function versionPath(userData: string, n: number): string {
	return path.join(versionsDir(userData), `${n}.json`);
}

/** A version written whole, until its writer has checked that it landed. */
function partPath(userData: string, commit: string): string {
	return path.join(versionsDir(userData), `.${commit}.part`);
}

/** The same file, renamed by a change built on it: it landed. */
function markPath(userData: string, commit: string): string {
	return path.join(versionsDir(userData), `.${commit}.landed`);
}

/** The version numbers there are, newest first. */
function versionNumbers(userData: string): number[] {
	try {
		return readdirSync(versionsDir(userData))
			.map((name) => Number(/^(\d+)\.json$/.exec(name)?.[1]))
			.filter((n) => Number.isSafeInteger(n) && n > 0)
			.sort((a, b) => b - a);
	} catch {
		return [];
	}
}

/** How long a change keeps trying when other changes land first. */
const COMMIT_WAIT_MS = 1_000;
/** The checkbox's change tries longer: it must land. */
const CHOICE_WAIT_MS = 5_000;
/** The newest versions kept: a reader always finds one. */
const KEEP_VERSIONS = 20;
/** A writer's file left beside the versions, older than this and its process gone, was left by
 *  a writer that died before checking. One whose process runs is kept: it checks once resumed. */
const STRAY_MS = 60_000;
/** A ping's claim naming no running process, held longer, was left by one that died before
 *  PostHog answered. One whose process still runs is kept, a sleeping machine included, up to an
 *  hour: past that, that process is stuck or its number reused. */
const SENDING_CLAIM_MS = 60_000;
const STUCK_CLAIM_MS = 60 * 60_000;

interface Version {
	state: UsagePingState;
	/** The id this version was written under; `null` for the released builds' file. */
	commit: string | null;
	/** The process that wrote it. */
	pid?: number;
	/** When the released builds' file had last been written as this version was made, `null`
	 *  without one: a later write there is a downgraded build's. */
	legacySeen?: number | null;
}

interface Newest {
	/** The highest number taken. */
	top: number;
	newest: Version;
	/** The version at `top` is there but does not read; `newest` is the newest that does. */
	unreadable: boolean;
	legacySeen: number | null;
}

function parseState(raw: Partial<UsagePingState>): UsagePingState {
	const text = (value: unknown) => (typeof value === "string" ? value : null);
	const sending = raw.sending as Partial<NonNullable<UsagePingState["sending"]>> | null;
	return {
		enabled: raw.enabled !== false,
		day: text(raw.day),
		week: text(raw.week),
		month: text(raw.month),
		installWeek:
			typeof raw.installWeek === "string" && INSTALL_WEEK.test(raw.installWeek)
				? raw.installWeek
				: null,
		tools: toolCounts(raw.tools),
		sending:
			typeof sending?.id === "string" &&
			typeof sending.at === "number" &&
			Number.isFinite(sending.at)
				? {
						id: sending.id,
						at: sending.at,
						tools: toolCounts(sending.tools),
						...(Number.isSafeInteger(sending.pid) ? { pid: sending.pid } : {}),
						...(sending.dispatched === true ? { dispatched: true as const } : {}),
					}
				: null,
	};
}

/** A version as written, or `null` when there is no such file or it does not read. */
function readVersion(file: string): Version | null {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<UsagePingState> & {
			commit?: unknown;
			pid?: unknown;
			legacySeen?: unknown;
		};
		return {
			state: parseState(raw),
			commit: typeof raw.commit === "string" ? raw.commit : null,
			...(Number.isSafeInteger(raw.pid) ? { pid: raw.pid as number } : {}),
			...(typeof raw.legacySeen === "number" || raw.legacySeen === null
				? { legacySeen: raw.legacySeen }
				: {}),
		};
	} catch {
		return null;
	}
}

function legacyVersion(userData: string): Version {
	const legacy = readVersion(legacyPath(userData));
	return { state: legacy?.state ?? { ...DEFAULT_STATE, tools: {} }, commit: null };
}

/**
 * The newest version. A released build, downgraded to, may have unticked the box in its own file
 * since: that holds. `afterList` runs between the listing and the read: tests stand there for
 * another process.
 */
function readNewest(userData: string, afterList?: () => void): Newest {
	for (;;) {
		const numbers = versionNumbers(userData);
		afterList?.();
		const top = numbers[0] ?? 0;
		const legacy = statOrNull(legacyPath(userData));
		const legacySeen = legacy?.mtimeMs ?? null;
		const head = top ? readVersion(versionPath(userData, top)) : null;
		const gone = top > 0 && !head && !statOrNull(versionPath(userData, top));
		const now = versionNumbers(userData)[0] ?? 0;
		// A number the collection freed after the listing may have been given since to a writer
		// that stalled, and such a version is never among the newest kept; a version gone since
		// was collected or dropped. Either way, list again.
		if (top <= now - KEEP_VERSIONS || (gone && now !== top)) continue;
		// The released builds' file, when it may say what the versions do not. There but
		// unreadable, it may hold an opt-out: as a version that does not read.
		const released =
			legacy && head?.legacySeen !== legacySeen ? readVersion(legacyPath(userData)) : null;
		const releasedUnread = legacy !== null && head?.legacySeen !== legacySeen && !released;
		if (!top) {
			const newest = { state: released?.state ?? { ...DEFAULT_STATE, tools: {} }, commit: null };
			return { top, newest, unreadable: releasedUnread, legacySeen };
		}
		if (head) {
			if (released && !released.state.enabled) head.state.enabled = false;
			return { top, newest: head, unreadable: releasedUnread, legacySeen };
		}
		// There, but it does not read, and it may hold an opt-out: nothing but the box's choice is
		// made over it, on the newest version that reads.
		for (const n of numbers.slice(1)) {
			const below = readVersion(versionPath(userData, n));
			if (below) return { top, newest: below, unreadable: true, legacySeen };
		}
		return { top, newest: legacyVersion(userData), unreadable: true, legacySeen };
	}
}

/**
 * Tells the writer of `commit`, which may not have checked yet, that its change landed. False
 * when it could not be told: nothing may be built on it then.
 */
function markLanded(userData: string, commit: string): boolean {
	try {
		renameSync(partPath(userData, commit), markPath(userData, commit));
		return true;
	} catch (error) {
		// Its writer checked and left already.
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/**
 * Whether the change written as `commit` landed: it is the newest version, or a change was built
 * on it, which marked it first, however many landed since. A version given a number the
 * collection freed while its writer stalled is never the newest, so never marked. The newest is
 * read before the mark: a change built on it between the two has marked it already.
 */
function landed(userData: string, commit: string): boolean {
	return (
		readNewest(userData).newest.commit === commit || statOrNull(markPath(userData, commit)) !== null
	);
}

/**
 * Applies `change` to the newest state and writes the result as the next version, starting over
 * on the newer state whenever another change got there first. `change` returns `null` to write
 * nothing, and may run more than once. The state written, or `null` when nothing was.
 * `overUnreadable` lets the box's choice be made over a newest version that does not read.
 * `afterList` runs between listing the versions and reading them, `afterWrite` between the write
 * and the check that it landed: tests stand there for another process.
 */
export function updateUsagePingState(
	userData: string,
	change: (state: UsagePingState) => UsagePingState | null,
	waitMs = COMMIT_WAIT_MS,
	{
		overUnreadable = false,
		afterList,
		afterWrite,
	}: { overUnreadable?: boolean; afterList?: () => void; afterWrite?: () => void } = {},
): UsagePingState | null {
	const dir = versionsDir(userData);
	try {
		mkdirSync(dir);
	} catch (error) {
		// A folder that cannot keep the state counts nothing and sends nothing.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
	}
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const { top, newest, unreadable, legacySeen } = readNewest(userData, afterList);
		if (unreadable && !overUnreadable) return null;
		const next = change(newest.state);
		if (!next) return null;
		// Not told, it may still check and make its change again: read again, and tell it then.
		// Over a version that does not read, nobody is told: that change is lost, and made again.
		if (!unreadable && newest.commit && !markLanded(userData, newest.commit)) continue;
		const n = top + 1;
		const commit = randomBytes(8).toString("hex");
		// Whole under a name of its own first, then given its number in one step. That name stays
		// until this writer has checked, for a change built on it to mark.
		const whole = partPath(userData, commit);
		try {
			const written = { ...next, commit, pid: process.pid, legacySeen };
			writeFileSync(whole, `${JSON.stringify(written)}\n`, { flag: "wx" });
			linkSync(whole, versionPath(userData, n));
		} catch (error) {
			dropFile(whole);
			// Another change took `n` first: read its state, and start over.
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			return null;
		}
		afterWrite?.();
		const stood = landed(userData, commit);
		// The name first: a change that marks it after this finds it gone.
		dropFile(whole);
		dropFile(markPath(userData, commit));
		if (stood) {
			collect(userData, n);
			return next;
		}
		// It took a number freed while this process stalled: it is not the newest state.
		if (readVersion(versionPath(userData, n))?.commit === commit) {
			dropFile(versionPath(userData, n));
		}
	}
	return null;
}

/** The newest versions stay, and the files writers left beside them go once surely stray. */
function collect(userData: string, newest: number): void {
	for (const old of versionNumbers(userData)) {
		if (old <= newest - KEEP_VERSIONS) dropFile(versionPath(userData, old));
	}
	try {
		for (const name of readdirSync(versionsDir(userData))) {
			if (!/\.(part|landed)$/.test(name)) continue;
			const file = path.join(versionsDir(userData), name);
			const old = Date.now() - (statOrNull(file)?.mtimeMs ?? 0) > STRAY_MS;
			if (old && senderRuns(readVersion(file)?.pid) !== true) dropFile(file);
		}
	} catch {
		// Listed again after the next change.
	}
}

/** A newest version that does not read counts and sends nothing, so the box shows unticked. */
export function loadUsagePingState(userData: string): UsagePingState {
	const { newest, unreadable } = readNewest(userData);
	return unreadable ? { ...newest.state, enabled: false } : newest.state;
}

/** Whether the choice was stored: the tray shows it only then. */
export function setUsagePingEnabled(userData: string, enabled: boolean): boolean {
	// The calls counted so far, and any ping's claim, are dropped either way: none waits for a
	// ping that may never go. Made over a newest version that does not read, it recovers from it.
	const stored = updateUsagePingState(
		userData,
		(state) => ({ ...state, enabled, tools: {}, sending: null }),
		CHOICE_WAIT_MS,
		{ overUnreadable: true },
	);
	return stored !== null;
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
	updateUsagePingState(userData, (state) =>
		state.enabled ? { ...state, tools: added(state.tools, { [name]: 1 }) } : null,
	);
}

/** Whether the process a claim names still runs; `null` when it names none. */
function senderRuns(pid: number | undefined): boolean | null {
	if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it runs, as another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function claimHeld(sending: NonNullable<UsagePingState["sending"]>): boolean {
	const age = Date.now() - sending.at;
	const runs = senderRuns(sending.pid);
	return runs === true ? age < STUCK_CLAIM_MS : runs === null && age < SENDING_CLAIM_MS;
}

type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean }>;

interface Claim {
	id: string;
	tools: Record<string, number>;
	plan: NonNullable<ReturnType<typeof planUsagePing>>;
	installWeek: string;
}

/** Sends today's ping if none went through yet. Never throws: a failure only means the
 *  next attempt tries again, and the dates are saved only once PostHog accepted it.
 *  `afterClaim` runs between the claim and the request: tests stand there for another process. */
export async function sendUsagePing(
	userData: string,
	facts: UsagePingFacts,
	env: Readonly<Record<string, string | undefined>> = process.env,
	now: Date = new Date(),
	fetchImpl: Fetch = fetch,
	afterClaim?: () => void,
): Promise<void> {
	// The counts it carries are claimed before the ping leaves: a ping from another process
	// meanwhile finds the claim and leaves this day to it, so no count rides two pings. The
	// claim is a version like any change, so the checkbox's choice comes before it or after.
	const made: { claim?: Claim } = {};
	const claimed = updateUsagePingState(userData, (state) => {
		made.claim = undefined;
		const plan = planUsagePing(state, facts.channel, env, now);
		if (!plan || (state.sending && claimHeld(state.sending))) return null;
		// A claim nobody finished, its process gone: its counts go out with this ping.
		const tools = added(state.tools, state.sending?.tools ?? {});
		const id = randomUUID();
		// Kept once known, "unknown" included, so an install never changes cohort.
		const installWeek = state.installWeek ?? installWeekFrom(statOrNull(userData));
		made.claim = { id, tools, plan, installWeek };
		return { ...state, tools: {}, sending: { id, at: Date.now(), tools, pid: process.pid } };
	});
	const claim = made.claim;
	if (!claimed || !claim) return;
	afterClaim?.();
	// Handed over by a version of its own, in the same sequence as the checkbox's choice: the
	// box unticked before it stops the ping, unticked after it finds the request gone. Not
	// handed over, a claim still standing gives its counts back.
	const dispatched = updateUsagePingState(userData, (state) =>
		state.enabled && state.sending?.id === claim.id
			? { ...state, sending: { ...state.sending, dispatched: true } }
			: null,
	);
	if (!dispatched) {
		updateUsagePingState(userData, (state) =>
			state.sending?.id === claim.id
				? { ...state, tools: added(state.tools, claim.tools), sending: null }
				: null,
		);
		return;
	}
	const { plan, installWeek, tools: sentTools } = claim;
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
	updateUsagePingState(userData, (latest) => {
		const ours = latest.sending?.id === claim.id;
		if (delivered) {
			const later = latest.day !== null && latest.day > plan.keys.day;
			return {
				...latest,
				...(later ? {} : plan.keys),
				installWeek: latest.installWeek ?? installWeek,
				sending: ours ? null : latest.sending,
			};
		}
		return ours ? { ...latest, tools: added(latest.tools, sentTools), sending: null } : null;
	});
}
