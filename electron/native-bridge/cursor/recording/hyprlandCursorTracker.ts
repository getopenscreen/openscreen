import { existsSync, readdirSync } from "node:fs";
import net from "node:net";
import { hrtime } from "node:process";
import type { CursorRecordingData, CursorRecordingSample } from "../../../../src/native/contracts";

export interface HyprlandMonitorGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
	scale?: number;
	transform?: number;
}

export interface HyprlandCaptureRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface HyprlandCaptureGeometry {
	position?: { x: number; y: number } | null;
	width: number;
	height: number;
	/** False for window streams when the portal omitted the window origin. */
	allowMonitorOriginFallback?: boolean;
}

function monitorLogicalSize(monitor: HyprlandMonitorGeometry) {
	const scale = monitor.scale && monitor.scale > 0 ? monitor.scale : 1;
	const swap = (monitor.transform ?? 0) % 2 === 1;
	return {
		width: (swap ? monitor.height : monitor.width) / scale,
		height: (swap ? monitor.width : monitor.height) / scale,
	};
}

export function mapHyprlandCursorToCapture(
	point: { x: number; y: number },
	monitors: HyprlandMonitorGeometry[],
	capture: HyprlandCaptureRect,
) {
	const monitor = monitors.find((candidate) => {
		const { width, height } = monitorLogicalSize(candidate);
		return (
			point.x >= candidate.x &&
			point.y >= candidate.y &&
			point.x < candidate.x + width &&
			point.y < candidate.y + height
		);
	});
	const transform = monitor?.transform ?? 0;
	const logicalX = point.x - capture.x;
	const logicalY = point.y - capture.y;
	// Hyprland cursor coordinates and portal stream positions/sizes are in the
	// compositor's logical coordinate space. The PipeWire frame dimensions are
	// physical pixels and must not be used for this ratio, especially on scaled
	// monitors. `capture` is populated from the portal's logical `size`.
	const logicalWidth = Math.max(1, capture.width);
	const logicalHeight = Math.max(1, capture.height);
	let x = logicalX / logicalWidth;
	let y = logicalY / logicalHeight;

	if (transform === 1) {
		[x, y] = [1 - y, x];
	} else if (transform === 2) {
		[x, y] = [1 - x, 1 - y];
	} else if (transform === 3) {
		[x, y] = [y, 1 - x];
	}

	return {
		cx: Math.min(1, Math.max(0, x)),
		cy: Math.min(1, Math.max(0, y)),
	};
}

function hyprlandSocketPath() {
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	const runtime = process.env.XDG_RUNTIME_DIR?.trim() || (uid === null ? null : `/run/user/${uid}`);
	if (!runtime) return null;

	const configuredSignature = process.env.HYPRLAND_INSTANCE_SIGNATURE?.trim();
	if (configuredSignature) {
		return `${runtime}/hypr/${configuredSignature}/.socket.sock`;
	}

	// Electron launched from a desktop entry may not inherit Hyprland's
	// instance variables even though it runs in the same user session. Discover
	// the one live socket rather than disabling position telemetry in that case.
	try {
		const hyprlandRoot = `${runtime}/hypr`;
		const signature = readdirSync(hyprlandRoot, { withFileTypes: true }).find(
			(entry) => entry.isDirectory() && existsSync(`${hyprlandRoot}/${entry.name}/.socket.sock`),
		)?.name;
		return signature ? `${hyprlandRoot}/${signature}/.socket.sock` : null;
	} catch {
		return null;
	}
}

function monotonicMs() {
	return Number(hrtime.bigint() / 1_000_000n);
}

export class HyprlandCursorTracker {
	private sockets = new Set<net.Socket>();
	private interval: NodeJS.Timeout | null = null;
	private sampleInFlight = false;
	private monitorCache: HyprlandMonitorGeometry[] = [];
	private monitorCacheAt = 0;
	private samples: CursorRecordingSample[] = [];
	private startMs = 0;
	private pausedAt: number | null = null;
	private pausedDurationMs = 0;
	private captureRect: HyprlandCaptureRect | null = null;
	private captureSize: { width: number; height: number } | null = null;
	private allowMonitorOriginFallback = true;
	private lastIpcError: string | null = null;
	private generation = 0;

	constructor(private readonly options: { sampleIntervalMs: number; maxSamples: number }) {}

	static isAvailable() {
		return Boolean(hyprlandSocketPath());
	}

	start() {
		this.generation += 1;
		this.stopSocket();
		this.samples = [];
		this.startMs = monotonicMs();
		this.pausedAt = null;
		this.pausedDurationMs = 0;
		this.interval = setInterval(() => void this.sample(), this.options.sampleIntervalMs);
		this.interval.unref();
		void this.sample();
	}

	stop(): CursorRecordingData {
		this.generation += 1;
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
		this.stopSocket();
		return { version: 2, provider: "native", samples: this.samples, assets: [] };
	}

	pause() {
		if (this.pausedAt === null) this.pausedAt = monotonicMs();
	}

	resume() {
		if (this.pausedAt !== null) {
			this.pausedDurationMs += Math.max(0, monotonicMs() - this.pausedAt);
			this.pausedAt = null;
		}
	}

	rebase() {
		this.generation += 1;
		this.startMs = monotonicMs();
		this.pausedDurationMs = 0;
		this.pausedAt = null;
		this.samples = [];
	}

	setCaptureRect(rect: HyprlandCaptureRect | null) {
		this.captureRect = rect;
		this.captureSize = rect ? { width: rect.width, height: rect.height } : null;
	}

	/**
	 * Some portal backends omit Stream.position even for a monitor stream. Keep
	 * sampling in that case and resolve the origin from Hyprland's monitor list
	 * using the logical stream size. An omitted portal position must not turn a
	 * valid recording into an empty cursor sidecar.
	 */
	setCaptureGeometry(geometry: HyprlandCaptureGeometry | null) {
		if (!geometry) {
			this.captureRect = null;
			this.captureSize = null;
			this.allowMonitorOriginFallback = true;
			return;
		}
		this.allowMonitorOriginFallback = geometry.allowMonitorOriginFallback ?? true;
		this.captureSize = {
			width: Math.max(1, geometry.width),
			height: Math.max(1, geometry.height),
		};
		this.captureRect = geometry.position
			? {
					x: geometry.position.x,
					y: geometry.position.y,
					width: this.captureSize.width,
					height: this.captureSize.height,
				}
			: null;
	}

	hasCaptureGeometry() {
		return this.captureRect !== null || this.captureSize !== null;
	}

	private async sample() {
		if (this.sampleInFlight || this.pausedAt !== null || (!this.captureRect && !this.captureSize))
			return;
		const generation = this.generation;
		this.sampleInFlight = true;
		try {
			const point = await this.request<{ x: number; y: number }>("j/cursorpos");
			const now = monotonicMs();
			if (now - this.monitorCacheAt > 1000 || this.monitorCacheAt === 0) {
				const refreshed = await this.request<HyprlandMonitorGeometry[]>("j/monitors");
				if (Array.isArray(refreshed)) {
					this.monitorCache = refreshed;
					this.monitorCacheAt = now;
				}
			}
			this.correctPortalOriginForExactMonitor(point);
			if (!this.captureRect && this.captureSize && this.allowMonitorOriginFallback) {
				const matches = this.monitorCache.filter((monitor) => {
					const scale = monitor.scale && monitor.scale > 0 ? monitor.scale : 1;
					const widths = [monitor.width, monitor.width / scale].map(Math.round);
					const heights = [monitor.height, monitor.height / scale].map(Math.round);
					return (
						widths.includes(this.captureSize?.width ?? -1) &&
						heights.includes(this.captureSize?.height ?? -1)
					);
				});
				const containing = this.monitorCache.find((monitor) => {
					const { width, height } = monitorLogicalSize(monitor);
					return (
						point.x >= monitor.x &&
						point.y >= monitor.y &&
						point.x < monitor.x + width &&
						point.y < monitor.y + height
					);
				});
				// Exact size wins for monitor captures. For a window capture whose
				// portal size is smaller than the monitor, the containing monitor is
				// the best available origin when the portal omitted Stream.position.
				const monitor = matches.length === 1 ? matches[0] : containing;
				if (monitor) {
					this.captureRect = {
						x: monitor.x,
						y: monitor.y,
						width: this.captureSize.width,
						height: this.captureSize.height,
					};
				}
			}
			if (!this.captureRect || generation !== this.generation) return;
			const mapped = mapHyprlandCursorToCapture(point, this.monitorCache, this.captureRect);
			this.samples.push({
				timeMs: Math.max(0, now - this.startMs - this.pausedDurationMs),
				...mapped,
				visible: true,
				interactionType: "move",
			});
			if (this.samples.length > this.options.maxSamples) this.samples.shift();
		} catch (error) {
			// IPC is best-effort. A compositor restart is recovered on the next sample.
			const message = error instanceof Error ? error.message : String(error);
			if (message !== this.lastIpcError) {
				this.lastIpcError = message;
				console.warn("[hyprland-cursor] sample failed:", message);
			}
		} finally {
			this.sampleInFlight = false;
		}
	}

	/**
	 * Hyprland's portal backend can report a full-monitor stream's origin as
	 * (0,0), even when the selected monitor has a negative or non-zero virtual
	 * desktop origin. If the logical stream size uniquely identifies a monitor
	 * and the pointer is inside it, trust Hyprland's monitor geometry for the
	 * origin. Window streams remain untouched because their size normally does
	 * not uniquely identify a monitor.
	 */
	private correctPortalOriginForExactMonitor(point: { x: number; y: number }) {
		if (!this.captureRect) return;
		const matches = this.monitorCache.filter((monitor) => {
			const scale = monitor.scale && monitor.scale > 0 ? monitor.scale : 1;
			const widths = [monitor.width, monitor.width / scale].map(Math.round);
			const heights = [monitor.height, monitor.height / scale].map(Math.round);
			return (
				widths.includes(Math.round(this.captureRect!.width)) &&
				heights.includes(Math.round(this.captureRect!.height))
			);
		});
		const monitor = matches.find((candidate) => {
			const { width, height } = monitorLogicalSize(candidate);
			return (
				point.x >= candidate.x &&
				point.y >= candidate.y &&
				point.x < candidate.x + width &&
				point.y < candidate.y + height
			);
		});
		if (matches.length === 1 && monitor) {
			this.captureRect.x = monitor.x;
			this.captureRect.y = monitor.y;
		}
	}

	private request<T>(command: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const socketPath = hyprlandSocketPath();
			if (!socketPath) {
				reject(new Error("Hyprland IPC socket is unavailable"));
				return;
			}

			const socket = net.createConnection(socketPath);
			this.sockets.add(socket);
			let response = "";
			let settled = false;
			const settle = (error?: Error, value?: T) => {
				if (settled) return;
				settled = true;
				this.sockets.delete(socket);
				if (error) reject(error);
				else resolve(value as T);
			};

			socket.setTimeout(Math.max(250, this.options.sampleIntervalMs * 2));
			socket.on("connect", () => socket.write(command));
			socket.on("data", (chunk) => {
				response += chunk.toString();
				try {
					settle(undefined, JSON.parse(response) as T);
					socket.destroy();
				} catch {
					// Wait for the rest of a JSON response.
				}
			});
			socket.on("error", (error) => settle(error));
			socket.on("timeout", () => {
				socket.destroy();
				settle(new Error("Hyprland IPC timeout"));
			});
			socket.on("close", () => {
				if (!settled) settle(new Error("Hyprland IPC connection closed"));
			});
		});
	}

	private stopSocket() {
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
	}
}
