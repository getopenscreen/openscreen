// Hyprland: placing the HUD bar and its panel, which Wayland gives a client no way to do.
//
// A toplevel cannot position itself on Wayland, and Hyprland centres every new floating window
// on its monitor. The bar asks for the bottom centre of the screen, where Windows and macOS put
// it, and was left in the middle instead; the panel (src/components/launch/hudPanel.ts) then
// opened on top of it, and a toast covered the very controls it was about. Hyprland's IPC socket
// can move a window, so on Hyprland the bar is moved to the bottom and the panel next to it
// after each maps. The panel, shown and hidden as often as a popover opens, is also placed
// before it maps, by a window rule, or it would be seen opening mid-screen and then jumping. Both are pinned too: `alwaysOnTop` means nothing on Wayland, and a window
// made fullscreen or maximized (Omarchy's Super+F, Super+Alt+F) otherwise covers the bar,
// which is how the user stops a recording. Best effort only: anything unexpected leaves the
// window where the compositor put it.
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
	pinned?: boolean;
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
	/** The monitor a new window opens on. */
	focused?: boolean;
}

const IPC_TIMEOUT_MS = 500;

/** Whether this process runs in a Hyprland session, whatever distribution ships it. */
export function runsUnderHyprland(env: Env, platform: string = process.platform): boolean {
	return platform === "linux" && Boolean(env.HYPRLAND_INSTANCE_SIGNATURE);
}

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

/** Where the bar goes: centred at the bottom of the work area, `margin` above its edge. */
export function barPositionAtBottom(
	bar: { width: number; height: number },
	workArea: Rect,
	margin: number,
): { x: number; y: number } {
	return {
		x: Math.round(workArea.x + (workArea.width - bar.width) / 2),
		y: Math.round(workArea.y + workArea.height - bar.height - margin),
	};
}

const toRect = (client: HyprlandClient): Rect => ({
	x: client.at[0],
	y: client.at[1],
	width: client.size[0],
	height: client.size[1],
});

/** The bar among this process's windows: the size this process gave it, and not the panel. */
function findBar(
	clients: HyprlandClient[],
	options: { pid: number; panelTitle: string; barSize: { width: number; height: number } },
): HyprlandClient | undefined {
	return clients.find(
		(client) =>
			client.pid === options.pid &&
			client.title !== options.panelTitle &&
			client.size[0] === options.barSize.width &&
			client.size[1] === options.barSize.height,
	);
}

/** Names of the window rules that place the panel and the bar as they map; replaced as they change. */
export const PANEL_RULE = "openscreen-hud-panel";
export const BAR_RULE = "openscreen-hud-bar";

/**
 * The Lua that (re)defines a window rule placing the window titled `title`: floating, at its
 * size, and at `x`,`y` relative to its monitor, which is how a rule's `move` is read. The size is
 * in the rule because a window mapping for the first time has not had the size it was given
 * applied yet: it maps small and then grows, away from where it was placed. Not pinned here: a
 * window pinned by a rule as it maps stays under a fullscreen window, where one pinned after it
 * maps is drawn above it, so the moves after mapping pin it. Null for a title that would need
 * escaping.
 */
export function windowPlacementRule(
	ruleName: string,
	title: string,
	size: { width: number; height: number },
	x: number,
	y: number,
): string | null {
	// Nothing to escape, for the regex or the Lua string it sits in.
	if (!/^[\w ]+$/.test(title)) return null;
	return (
		`hl.window_rule({ name = "${ruleName}", match = { title = "^(${title})$" }, ` +
		`float = true, size = "${Math.round(size.width)} ${Math.round(size.height)}", ` +
		`move = "${Math.round(x)} ${Math.round(y)}" })`
	);
}

/**
 * Before the panel is shown: a window rule that maps it next to the bar, so it never appears
 * where Hyprland would centre it. Resolves false when not under Hyprland, on a Hyprland
 * without Lua, or when the bar cannot be found; the panel is then moved after it maps instead.
 */
export async function presetHudPanelPlacement(options: {
	env: Env;
	pid: number;
	panelTitle: string;
	panelSize: { width: number; height: number };
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
	const bar = findBar(clients, options);
	const monitor = bar && monitors.find((candidate) => candidate.id === bar.monitor);
	if (!bar || !monitor) return false;

	const { x, y } = panelPositionNearBar(
		toRect(bar),
		options.panelSize,
		monitorWorkArea(monitor),
		options.gap,
	);
	const rule = windowPlacementRule(
		PANEL_RULE,
		options.panelTitle,
		options.panelSize,
		x - monitor.x,
		y - monitor.y,
	);
	if (!rule) return false;
	return (await request(socketPath, `eval ${rule}`))?.trim() === "ok";
}

/**
 * Before the bar is shown, and again whenever its size changes: a window rule that maps it at the
 * bottom centre, so it never appears where Hyprland would centre it — at launch, or shown again
 * after being hidden. On the bar's monitor once it has one, else the focused monitor, where a
 * new window opens. Resolves false when not under Hyprland or on a Hyprland without Lua; the bar
 * is then moved after it maps instead.
 */
export async function presetHudBarPlacement(options: {
	env: Env;
	pid: number;
	barTitle: string;
	panelTitle: string;
	barSize: { width: number; height: number };
	margin: number;
}): Promise<boolean> {
	const socketPath = hyprlandSocketPath(options.env);
	if (!socketPath) return false;
	const [clients, monitors] = await Promise.all([
		requestJson<HyprlandClient[]>(socketPath, "clients"),
		requestJson<HyprlandMonitor[]>(socketPath, "monitors"),
	]);
	if (!Array.isArray(clients) || !Array.isArray(monitors)) return false;
	const bar = findBar(clients, options);
	const monitor =
		(bar && monitors.find((candidate) => candidate.id === bar.monitor)) ??
		monitors.find((candidate) => candidate.focused);
	if (!monitor) return false;

	const { x, y } = barPositionAtBottom(options.barSize, monitorWorkArea(monitor), options.margin);
	const rule = windowPlacementRule(
		BAR_RULE,
		options.barTitle,
		options.barSize,
		x - monitor.x,
		y - monitor.y,
	);
	if (!rule) return false;
	return (await request(socketPath, `eval ${rule}`))?.trim() === "ok";
}

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

	const panel = clients.find(
		(client) => client.pid === options.pid && client.title === options.panelTitle,
	);
	const bar = findBar(clients, options);
	const monitor = bar && monitors.find((candidate) => candidate.id === bar.monitor);
	if (!panel || !bar || !monitor) return false;

	const { x, y } = panelPositionNearBar(
		toRect(bar),
		{ width: panel.size[0], height: panel.size[1] },
		monitorWorkArea(monitor),
		options.gap,
	);
	await pinClient(socketPath, panel);
	if (x === panel.at[0] && y === panel.at[1]) return true;
	return moveClient(socketPath, panel.address, x, y);
}

/**
 * Moves the bar window to the bottom centre of the monitor it is on. Found among this
 * process's clients by the size this process gave it, skipping the panel. Resolves false
 * when not under Hyprland or when anything does not match, in which case nothing was moved.
 */
export async function placeHudBarAtBottom(options: {
	env: Env;
	pid: number;
	panelTitle: string;
	barSize: { width: number; height: number };
	margin: number;
}): Promise<boolean> {
	const socketPath = hyprlandSocketPath(options.env);
	if (!socketPath) return false;
	const [clients, monitors] = await Promise.all([
		requestJson<HyprlandClient[]>(socketPath, "clients"),
		requestJson<HyprlandMonitor[]>(socketPath, "monitors"),
	]);
	if (!Array.isArray(clients) || !Array.isArray(monitors)) return false;

	const bar = findBar(clients, options);
	const monitor = bar && monitors.find((candidate) => candidate.id === bar.monitor);
	if (!bar || !monitor) return false;

	const { x, y } = barPositionAtBottom(
		{ width: bar.size[0], height: bar.size[1] },
		monitorWorkArea(monitor),
		options.margin,
	);
	await pinClient(socketPath, bar);
	if (x === bar.at[0] && y === bar.at[1]) return true;
	return moveClient(socketPath, bar.address, x, y);
}

/**
 * Pins a window: shown on every workspace and above a fullscreen or maximized one. Both
 * dispatchers toggle, so an already pinned window is left alone.
 */
async function pinClient(socketPath: string, client: HyprlandClient): Promise<void> {
	if (client.pinned) return;
	const target = `address:${client.address}`;
	for (const command of [
		`dispatch hl.dsp.window.pin({ window = "${target}" })`,
		`dispatch pin ${target}`,
	]) {
		if ((await request(socketPath, command))?.trim() === "ok") return;
	}
}

async function moveClient(
	socketPath: string,
	address: string,
	x: number,
	y: number,
): Promise<boolean> {
	// Hyprland 0.56 evaluates `dispatch` as Lua (hl.dsp.window.move); earlier releases only
	// know the classic dispatcher. Each refuses the other's syntax, so try both in turn.
	const target = `address:${address}`;
	for (const command of [
		`dispatch hl.dsp.window.move({ x = ${x}, y = ${y}, window = "${target}" })`,
		`dispatch movewindowpixel exact ${x} ${y},${target}`,
	]) {
		if ((await request(socketPath, command))?.trim() === "ok") return true;
	}
	return false;
}
