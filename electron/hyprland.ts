// Hyprland: placing the HUD panel next to the bar, which Wayland gives a client no way to do.
//
// A toplevel cannot position itself on Wayland, and Hyprland centres every new floating window
// on its monitor. The HUD bar starts centred too, so the panel (src/components/launch/hudPanel.ts)
// opened on top of it, and a toast covered the very controls it was about. Hyprland's IPC socket
// can move a window, so on Hyprland the panel is moved next to the bar after it maps. Best
// effort only: anything unexpected leaves the window where the compositor put it.
import net from "node:net";
import path from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface HyprlandClient {
	address: string;
	pid: number;
	title: string;
	at: [number, number];
	size: [number, number];
	monitor: number;
}

interface HyprlandMonitor {
	id: number;
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
	/** Logical px taken by bars and docks: left, top, right, bottom. */
	reserved: [number, number, number, number];
}

const IPC_TIMEOUT_MS = 500;

/** The request socket of the Hyprland instance this process runs under, or null outside one. */
export function hyprlandSocketPath(env: Env): string | null {
	const signature = env.HYPRLAND_INSTANCE_SIGNATURE;
	const runtimeDir = env.XDG_RUNTIME_DIR;
	if (!signature || !runtimeDir) return null;
	return path.join(runtimeDir, "hypr", signature, ".socket.sock");
}

/** One request over Hyprland's IPC socket; null on any failure, so callers simply give up. */
function request(socketPath: string, command: string): Promise<string | null> {
	return new Promise((resolve) => {
		let reply = "";
		const socket = net.createConnection(socketPath);
		const done = (value: string | null) => {
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(IPC_TIMEOUT_MS, () => done(null));
		socket.on("connect", () => socket.write(command));
		socket.on("data", (chunk) => {
			reply += chunk.toString("utf8");
		});
		socket.on("end", () => done(reply));
		socket.on("error", () => done(null));
	});
}

async function requestJson<T>(socketPath: string, command: string): Promise<T | null> {
	const reply = await request(socketPath, `j/${command}`);
	if (!reply) return null;
	try {
		return JSON.parse(reply) as T;
	} catch {
		return null;
	}
}

/** A monitor's usable area in logical px: its size less the bars and docks reserved on it. */
export function monitorWorkArea(monitor: HyprlandMonitor): Rect {
	const [left, top, right, bottom] = monitor.reserved;
	const width = monitor.width / monitor.scale;
	const height = monitor.height / monitor.scale;
	return {
		x: monitor.x + left,
		y: monitor.y + top,
		width: width - left - right,
		height: height - top - bottom,
	};
}

/**
 * Where the panel goes: centred on the bar, above it with `gap` between, or below it when there
 * is room below and not above. When neither side has room it takes the roomier one, so the clamp
 * into the work area covers as little of the bar as it can.
 */
export function panelPositionNearBar(
	bar: Rect,
	panel: { width: number; height: number },
	workArea: Rect,
	gap: number,
): { x: number; y: number } {
	const above = bar.y - gap - panel.height;
	const below = bar.y + bar.height + gap;
	const roomAbove = bar.y - gap - workArea.y;
	const roomBelow = workArea.y + workArea.height - below;
	let y = above;
	if (panel.height > roomAbove) {
		y = panel.height <= roomBelow || roomBelow > roomAbove ? below : above;
	}
	const x = bar.x + (bar.width - panel.width) / 2;
	const clamp = (value: number, min: number, max: number) =>
		Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
	return {
		x: clamp(x, workArea.x, workArea.x + workArea.width - panel.width),
		y: clamp(y, workArea.y, workArea.y + workArea.height - panel.height),
	};
}

const toRect = (client: HyprlandClient): Rect => ({
	x: client.at[0],
	y: client.at[1],
	width: client.size[0],
	height: client.size[1],
});

/**
 * Moves the panel window next to the bar. Both are found among this process's clients: the
 * panel by its title, the bar by the size this process gave it. Resolves false when not under
 * Hyprland or when anything does not match, in which case nothing was moved.
 */
export async function placeHudPanelNearBar(options: {
	env: Env;
	pid: number;
	panelTitle: string;
	barSize: { width: number; height: number };
	gap: number;
}): Promise<boolean> {
	const socketPath = hyprlandSocketPath(options.env);
	if (!socketPath) return false;
	const [clients, monitors] = await Promise.all([
		requestJson<HyprlandClient[]>(socketPath, "clients"),
		requestJson<HyprlandMonitor[]>(socketPath, "monitors"),
	]);
	if (!Array.isArray(clients) || !Array.isArray(monitors)) return false;

	const ours = clients.filter((client) => client.pid === options.pid);
	const panel = ours.find((client) => client.title === options.panelTitle);
	const bar = ours.find(
		(client) =>
			client !== panel &&
			client.size[0] === options.barSize.width &&
			client.size[1] === options.barSize.height,
	);
	const monitor = bar && monitors.find((candidate) => candidate.id === bar.monitor);
	if (!panel || !bar || !monitor) return false;

	const { x, y } = panelPositionNearBar(
		toRect(bar),
		{ width: panel.size[0], height: panel.size[1] },
		monitorWorkArea(monitor),
		options.gap,
	);
	if (x === panel.at[0] && y === panel.at[1]) return true;
	// Hyprland 0.56 evaluates `dispatch` as Lua (hl.dsp.window.move); earlier releases only
	// know the classic dispatcher. Each refuses the other's syntax, so try both in turn.
	const target = `address:${panel.address}`;
	for (const command of [
		`dispatch hl.dsp.window.move({ x = ${x}, y = ${y}, window = "${target}" })`,
		`dispatch movewindowpixel exact ${x} ${y},${target}`,
	]) {
		if ((await request(socketPath, command))?.trim() === "ok") return true;
	}
	return false;
}
