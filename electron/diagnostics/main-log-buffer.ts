/**
 * Ring buffer for main-process console output.
 *
 * Captures the last `capacity` lines written via console.info / console.warn /
 * console.error / console.log into a single in-memory buffer, which "Save
 * Diagnostics" writes as `mainProcessLogs`. main.ts installs it on every app
 * launch: the users who save a bundle start the app from a desktop entry, the
 * Dock or the Start menu, where no OPENSCREEN_DIAGNOSTIC can be set, and gating
 * it on that flag left every one of their bundles with no log at all.
 *
 * Cost when installed: one array.push + occasional shift per console call,
 * negligible against the rest of the app. Cost when not installed (the CLI):
 * zero, the original console methods are kept untouched.
 */

const DEFAULT_CAPACITY = 500;

export interface MainLogEntry {
	timestampMs: number;
	level: "info" | "warn" | "error" | "log";
	text: string;
}

export class MainLogBuffer {
	private readonly capacity: number;
	private readonly entries: MainLogEntry[] = [];
	private installed = false;
	private readonly originals: Partial<
		Record<"log" | "info" | "warn" | "error", (...args: unknown[]) => void>
	> = {};

	constructor(capacity = DEFAULT_CAPACITY) {
		this.capacity = Math.max(1, capacity);
	}

	install(): void {
		if (this.installed) return;
		this.installed = true;
		const console_ = console as unknown as Record<
			"log" | "info" | "warn" | "error",
			(...args: unknown[]) => void
		>;
		for (const level of ["log", "info", "warn", "error"] as const) {
			this.originals[level] = console_[level].bind(console);
			console_[level] = (...args: unknown[]) => {
				this.push(level, args);
				this.originals[level]?.(...args);
			};
		}
	}

	uninstall(): void {
		if (!this.installed) return;
		this.installed = false;
		const console_ = console as unknown as Record<
			"log" | "info" | "warn" | "error",
			(...args: unknown[]) => void
		>;
		for (const level of ["log", "info", "warn", "error"] as const) {
			if (this.originals[level]) {
				console_[level] = this.originals[level] as (...args: unknown[]) => void;
			}
		}
		this.originals.log = undefined;
		this.originals.info = undefined;
		this.originals.warn = undefined;
		this.originals.error = undefined;
	}

	snapshot(): MainLogEntry[] {
		return this.entries.slice();
	}

	clear(): void {
		this.entries.length = 0;
	}

	private push(level: MainLogEntry["level"], args: unknown[]): void {
		const text = args
			.map((arg) => {
				if (typeof arg === "string") return arg;
				// An Error's message and stack are not enumerable, so JSON.stringify
				// writes `{}`: every `console.error("…failed:", error)` lost its cause.
				// The stack is what the terminal shows for it.
				if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
				try {
					return JSON.stringify(arg);
				} catch {
					return String(arg);
				}
			})
			.join(" ");
		this.entries.push({ timestampMs: Date.now(), level, text });
		if (this.entries.length > this.capacity) {
			this.entries.splice(0, this.entries.length - this.capacity);
		}
	}
}

export const mainLogBuffer = new MainLogBuffer();

export function isDiagnosticModeEnabled(): boolean {
	const raw = process.env.OPENSCREEN_DIAGNOSTIC;
	if (!raw) return false;
	const lowered = raw.trim().toLowerCase();
	return lowered === "1" || lowered === "true" || lowered === "yes";
}
