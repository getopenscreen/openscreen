import fs from "node:fs";
import path from "node:path";

/**
 * Main-process console output, appended to `main.log` in the OS log folder
 * (`app.getPath("logs")`), which "Save Diagnostics" reads back as `mainProcessLogs`.
 * On disk rather than in memory so a bundle saved after a crash still holds the
 * run that crashed. The folder stays small by itself: past `maxFileBytes`,
 * `main.log` becomes `main.old.log` (replacing the previous one) and starts over,
 * so there are never more than two files.
 *
 * Writes are synchronous so the last lines before a native crash reach the disk.
 * Logging never breaks the app: a failed open or write turns the file off, keeps
 * the error as `lastError`, and the console carries on.
 *
 * A flood cannot push the useful lines out of the folder: an identical line in a row
 * is counted instead of written, any line is capped at `MAX_LINE_CHARS`, and the
 * rest is rate-limited (`BURST_LINES`, then `LINES_PER_SECOND`). Both counts are
 * written as one summary line, at least every `SUMMARY_INTERVAL_MS` while a flood
 * lasts. Only the file is affected: the console still gets every line.
 */

const LOG_FILE = "main.log";
const OLD_LOG_FILE = "main.old.log";
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LINE_CHARS = 64 * 1024;
const BURST_LINES = 200;
const LINES_PER_SECOND = 10;
const SUMMARY_INTERVAL_MS = 30_000;
const MAX_REPEATS_PER_SUMMARY = 10_000;

type Level = "log" | "info" | "warn" | "error";
const LEVELS = ["log", "info", "warn", "error"] as const;

export class MainLogFile {
	private dir: string | null = null;
	private fd: number | null = null;
	private bytes = 0;
	private error: string | null = null;
	private readonly originals: Partial<Record<Level, (...args: unknown[]) => void>> = {};

	private lastKey: string | null = null;
	private lastLevel: Level = "log";
	private repeats = 0;
	private repeatsSince = 0;
	private tokens = BURST_LINES;
	private tokensAt = 0;
	private suppressed = 0;
	private suppressedSince = 0;

	constructor(private readonly maxFileBytes = DEFAULT_MAX_FILE_BYTES) {}

	get filePath(): string | null {
		return this.dir ? path.join(this.dir, LOG_FILE) : null;
	}

	get lastError(): string | null {
		return this.error;
	}

	install(dir: string, header: string): void {
		if (this.dir) return;
		this.dir = dir;
		try {
			fs.mkdirSync(dir, { recursive: true });
			this.open();
		} catch (error) {
			this.fail(error);
		}
		this.tokensAt = Date.now();
		this.write(`${new Date().toISOString()} --- ${header} ---\n`);

		const console_ = console as unknown as Record<Level, (...args: unknown[]) => void>;
		for (const level of LEVELS) {
			const original = console_[level];
			this.originals[level] = original;
			console_[level] = (...args: unknown[]) => {
				this.record(level, formatArgs(args));
				original.apply(console, args);
			};
		}
	}

	/** Writes the pending repeat and suppression counts. */
	flush(): void {
		const now = Date.now();
		this.flushRepeats(now);
		this.flushSuppressed(now);
	}

	uninstall(): void {
		if (!this.dir) return;
		this.flush();
		const console_ = console as unknown as Record<Level, (...args: unknown[]) => void>;
		for (const level of LEVELS) {
			const original = this.originals[level];
			if (original) console_[level] = original;
			this.originals[level] = undefined;
		}
		this.close();
		this.dir = null;
		this.error = null;
		this.lastKey = null;
		this.repeats = 0;
		this.suppressed = 0;
		this.tokens = BURST_LINES;
	}

	/** The last `maxBytes` of `main.old.log` + `main.log`, starting on a whole line. */
	readTail(maxBytes: number): string {
		if (!this.dir) return "";
		this.flush();
		let data: Buffer;
		let whole: boolean;
		try {
			const current = readLastBytes(path.join(this.dir, LOG_FILE), maxBytes);
			data = current.data;
			whole = current.whole;
			if (current.whole && data.length < maxBytes) {
				const old = readLastBytes(path.join(this.dir, OLD_LOG_FILE), maxBytes - data.length);
				data = Buffer.concat([old.data, data]);
				whole = old.whole;
			}
		} catch (error) {
			// Reported in the bundle as `logFileError`; writing carries on.
			this.error = describeError(error);
			return "";
		}
		const text = data.toString("utf-8");
		return whole ? text : text.slice(text.indexOf("\n") + 1);
	}

	private record(level: Level, rawText: string): void {
		if (this.fd === null) return;
		const now = Date.now();
		const text =
			rawText.length > MAX_LINE_CHARS
				? `${rawText.slice(0, MAX_LINE_CHARS)}…[truncated ${rawText.length - MAX_LINE_CHARS} chars]`
				: rawText;
		const key = `${level} ${text}`;

		if (key === this.lastKey) {
			if (this.repeats === 0) this.repeatsSince = now;
			this.repeats += 1;
			if (
				this.repeats >= MAX_REPEATS_PER_SUMMARY ||
				now - this.repeatsSince >= SUMMARY_INTERVAL_MS
			) {
				this.flushRepeats(now);
			}
			return;
		}
		this.flushRepeats(now);
		this.lastKey = key;
		this.lastLevel = level;

		this.tokens = Math.min(
			BURST_LINES,
			this.tokens + ((now - this.tokensAt) / 1000) * LINES_PER_SECOND,
		);
		this.tokensAt = now;
		if (this.tokens < 1) {
			// A line that was not written cannot be "repeated": its copies are suppressed too.
			this.lastKey = null;
			if (this.suppressed === 0) this.suppressedSince = now;
			this.suppressed += 1;
			if (now - this.suppressedSince >= SUMMARY_INTERVAL_MS) this.flushSuppressed(now);
			return;
		}
		this.tokens -= 1;
		this.flushSuppressed(now);
		this.write(`${new Date(now).toISOString()} ${level} ${text}\n`);
	}

	private flushRepeats(now: number): void {
		if (this.repeats === 0) return;
		const count = this.repeats;
		this.repeats = 0;
		this.repeatsSince = now;
		this.write(
			`${new Date(now).toISOString()} ${this.lastLevel} last message repeated ${count} time${count === 1 ? "" : "s"}\n`,
		);
	}

	private flushSuppressed(now: number): void {
		if (this.suppressed === 0) return;
		const count = this.suppressed;
		this.suppressed = 0;
		this.suppressedSince = now;
		this.write(
			`${new Date(now).toISOString()} warn ${count} lines suppressed (more than ${LINES_PER_SECOND} lines/s)\n`,
		);
	}

	private open(): void {
		if (!this.dir) return;
		const file = path.join(this.dir, LOG_FILE);
		if (fs.existsSync(file) && fs.statSync(file).size >= this.maxFileBytes) {
			fs.renameSync(file, path.join(this.dir, OLD_LOG_FILE));
		}
		this.fd = fs.openSync(file, "a");
		this.bytes = fs.fstatSync(this.fd).size;
	}

	private rotate(): void {
		if (!this.dir) return;
		this.close();
		fs.renameSync(path.join(this.dir, LOG_FILE), path.join(this.dir, OLD_LOG_FILE));
		this.open();
	}

	private write(line: string): void {
		if (this.fd === null) return;
		try {
			const data = Buffer.from(line, "utf-8");
			if (this.bytes > 0 && this.bytes + data.length > this.maxFileBytes) this.rotate();
			if (this.fd === null) return;
			fs.writeSync(this.fd, data);
			this.bytes += data.length;
		} catch (error) {
			this.fail(error);
		}
	}

	private fail(error: unknown): void {
		this.close();
		this.error = describeError(error);
	}

	private close(): void {
		if (this.fd === null) return;
		try {
			fs.closeSync(this.fd);
		} catch {
			// Already gone; nothing left to flush.
		}
		this.fd = null;
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatArgs(args: unknown[]): string {
	return args
		.map((arg) => {
			if (typeof arg === "string") return arg;
			// An Error's message and stack are not enumerable, so JSON.stringify writes `{}`.
			if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
			try {
				return JSON.stringify(arg);
			} catch {
				return String(arg);
			}
		})
		.join(" ");
}

/** `whole` is true when the read reached the start of the file (or it does not exist). */
function readLastBytes(file: string, maxBytes: number): { data: Buffer; whole: boolean } {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { data: Buffer.alloc(0), whole: true };
		}
		throw error;
	}
	try {
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, maxBytes);
		const data = Buffer.alloc(length);
		fs.readSync(fd, data, 0, length, size - length);
		return { data, whole: length === size };
	} finally {
		fs.closeSync(fd);
	}
}

export const mainLogFile = new MainLogFile();

export function isDiagnosticModeEnabled(): boolean {
	const raw = process.env.OPENSCREEN_DIAGNOSTIC;
	if (!raw) return false;
	const lowered = raw.trim().toLowerCase();
	return lowered === "1" || lowered === "true" || lowered === "yes";
}
