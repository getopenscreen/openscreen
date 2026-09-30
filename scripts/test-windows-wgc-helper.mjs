import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const HELPER_PATH =
	process.env.OPENSCREEN_WGC_CAPTURE_EXE ??
	path.join(ROOT, "electron", "native", "bin", "win32-x64", "wgc-capture.exe");

const DURATION_MS = Number(process.env.OPENSCREEN_WGC_TEST_DURATION_MS ?? 5000);
const WITH_SYSTEM_AUDIO =
	process.env.OPENSCREEN_WGC_TEST_SYSTEM_AUDIO === "true" ||
	process.argv.includes("--system-audio");
const WITH_MICROPHONE =
	process.env.OPENSCREEN_WGC_TEST_MICROPHONE === "true" ||
	process.argv.includes("--microphone") ||
	process.argv.includes("--mic");
const WITH_WINDOW =
	process.env.OPENSCREEN_WGC_TEST_WINDOW === "true" || process.argv.includes("--window");
/**
 * Records a window that has a context menu open, next to two unrelated
 * topmost popups from other processes, and checks the menu is in the video and
 * the strangers are not (getopenscreen/openscreen#894). The second half is the
 * point: DWM picks the windows IncludeSecondaryWindows draws by style and
 * z-order, so what it lets in has to be measured, not assumed.
 *
 * It shows windows on the desktop. Run it with no ordinary window (neither a
 * popup nor a tool window) over the test zone, about x 400-1110, y 150-685 at
 * 100 percent DPI, for as long as it runs: with one above the target the menu is
 * missing from the first frame to the last (#910). A run that prints
 * `fixture invalid` found one and measures nothing.
 */
const WITH_WINDOW_POPUP =
	process.env.OPENSCREEN_WGC_TEST_WINDOW_POPUP === "true" ||
	process.argv.includes("--window-popup");
const WITH_WEBCAM =
	process.env.OPENSCREEN_WGC_TEST_WEBCAM === "true" || process.argv.includes("--webcam");
const CAPTURE_CURSOR =
	process.env.OPENSCREEN_WGC_TEST_CAPTURE_CURSOR === "true" ||
	process.argv.includes("--capture-cursor");
const WITH_SOFTWARE_ENCODER =
	process.env.OPENSCREEN_WGC_TEST_SOFTWARE_ENCODER === "true" ||
	process.argv.includes("--software-encoder");
const WITH_SOFTWARE_FALLBACK =
	process.env.OPENSCREEN_WGC_TEST_SOFTWARE_FALLBACK === "true" ||
	process.argv.includes("--software-fallback");
const INJECT_DEFAULT_SINK_WRITER_FAILURE_ENV =
	"OPENSCREEN_WGC_TEST_INJECT_DEFAULT_SINK_WRITER_FAILURE_ONCE";
const INJECTION_MARKER = "TEST-ONLY: Injected default sink-writer creation failure";
const STALL_READBACK_ENV = "OPENSCREEN_WGC_TEST_STALL_READBACK_MS";
/**
 * Reproduces issue #252 on ordinary hardware: holds the frame lock across a
 * stall the way a wedged GPU readback does. Before the fix the helper hung
 * forever with no `[stop-timing]` output at all; it must now always exit.
 */
const WITH_STALLED_READBACK =
	process.env.OPENSCREEN_WGC_TEST_STALL_READBACK === "true" ||
	process.argv.includes("--stall-readback");
const STALL_READBACK_MS = Number(process.env[STALL_READBACK_ENV] ?? 60_000);
const STALL_FRAME_CALLBACK_ENV = "OPENSCREEN_WGC_TEST_STALL_FRAME_CALLBACK_MS";
/**
 * Reproduces getopenscreen/openscreen#460 on ordinary hardware: stalls the WGC
 * frame *callback* itself while it holds the frame lock, the shape that issue
 * actually reproduced on Intel HD 520 ("A WGC frame callback did not finish").
 * Distinct from WITH_STALLED_READBACK above -- that stalls the writer's own
 * readback, which quiesceLegacyCallback()'s drain cannot see
 * (callbacksInFlight_ stays at zero), so it cannot exercise the
 * video-writer-join skip this stall exists to test.
 *
 * Forces the legacy push path on (below), because that is the only path with a
 * frame callback to stall: the default pull path has no WGC-owned thread, so
 * this scenario would otherwise stall nothing and assert on a skip that can
 * never be taken.
 */
const WITH_STALLED_FRAME_CALLBACK =
	process.env.OPENSCREEN_WGC_TEST_STALL_FRAME_CALLBACK === "true" ||
	process.argv.includes("--stall-frame-callback");
const STALL_FRAME_CALLBACK_MS = Number(process.env[STALL_FRAME_CALLBACK_ENV] ?? 60_000);
const LEGACY_FRAME_CALLBACK_ENV = "OPENSCREEN_WGC_LEGACY_FRAME_CALLBACK";
/**
 * Runs any scenario on the pre-#306 push-based delivery path instead of the
 * pull-based default -- the same lever a user gets, so a machine that only
 * fails one way can be A/B'd without swapping builds.
 */
const WITH_LEGACY_FRAME_CALLBACK =
	process.env.OPENSCREEN_WGC_LEGACY_FRAME_CALLBACK === "1" ||
	process.argv.includes("--legacy-frame-callback");
const STOP_BUDGET_ENV = "OPENSCREEN_WGC_STOP_BUDGET_MS";
/**
 * The helper's global shutdown ceiling, pinned into its environment below so
 * the harness and the helper cannot drift apart. It matters because the
 * encoder-finalize step is the one allowed to spend the whole ceiling — issue
 * #34 exists because a long software-encoder finalize legitimately takes
 * seconds — so a limit below it would kill a helper that was still working and
 * report it as the #252 hang.
 */
const STOP_BUDGET_MS = Number(process.env[STOP_BUDGET_ENV] ?? 50_000);
/** Past the helper's own ceiling it never ended itself, which IS issue #252. */
const STOP_HANG_LIMIT_MS = STOP_BUDGET_MS + 15_000;
/** A healthy stop is well under a second. */
const STOP_LATENCY_BUDGET_MS = 15_000;

if (WITH_SOFTWARE_ENCODER && WITH_SOFTWARE_FALLBACK) {
	throw new Error("--software-encoder and --software-fallback are mutually exclusive");
}

function runHelper(
	config,
	{
		injectDefaultSinkWriterFailure = false,
		stallReadbackMs = 0,
		stallFrameCallbackMs = 0,
		legacyFrameCallback = false,
		extraEnv = {},
	} = {},
) {
	return new Promise((resolve, reject) => {
		const env = { ...process.env, ...extraEnv };
		delete env[INJECT_DEFAULT_SINK_WRITER_FAILURE_ENV];
		delete env[STALL_READBACK_ENV];
		delete env[STALL_FRAME_CALLBACK_ENV];
		delete env[LEGACY_FRAME_CALLBACK_ENV];
		env[STOP_BUDGET_ENV] = String(STOP_BUDGET_MS);
		if (legacyFrameCallback) {
			env[LEGACY_FRAME_CALLBACK_ENV] = "1";
		}
		if (injectDefaultSinkWriterFailure) {
			env[INJECT_DEFAULT_SINK_WRITER_FAILURE_ENV] = "1";
		}
		if (stallReadbackMs > 0) {
			env[STALL_READBACK_ENV] = String(stallReadbackMs);
		}
		if (stallFrameCallbackMs > 0) {
			env[STALL_FRAME_CALLBACK_ENV] = String(stallFrameCallbackMs);
		}
		const child = spawn(HELPER_PATH, [JSON.stringify(config)], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let stopTimer = null;
		let stopSentAt = null;
		let stopHung = false;
		let hangTimer = null;
		const scheduleStop = () => {
			if (stopTimer) {
				return;
			}
			stopTimer = setTimeout(() => {
				stopSentAt = Date.now();
				child.stdin.write("stop\n");
				// The whole point of issues #115 and #252 was a helper that never
				// came back from `stop`. Without a bound here the harness inherits
				// the hang instead of reporting it.
				hangTimer = setTimeout(() => {
					stopHung = true;
					child.kill();
				}, STOP_HANG_LIMIT_MS);
			}, DURATION_MS);
		};
		const fallbackTimer = setTimeout(scheduleStop, 15_000);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.includes('"recording-started"') || stdout.includes("Recording started")) {
				scheduleStop();
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(fallbackTimer);
			if (stopTimer) {
				clearTimeout(stopTimer);
			}
			if (hangTimer) {
				clearTimeout(hangTimer);
			}
			resolve({
				code,
				stdout,
				stderr,
				stopHung,
				stopLatencyMs: stopSentAt === null ? null : Date.now() - stopSentAt,
			});
		});
	});
}

/**
 * Every `[stop-timing]` step the helper *finished*, in order.
 *
 * `phase=begin` is the same step announced on entry, so counting both listed
 * every step twice. `phase=abandoned` is kept: that step did end, just badly.
 */
function readStopTimingSteps(stderr) {
	return [...stderr.matchAll(/\[stop-timing\]\s+step=(\S+)\s+elapsed_ms=\d+(?:\s+phase=(\S+))?/g)]
		.filter((match) => match[2] !== "begin")
		.map((match) => match[1]);
}

function assertStopWasClean(result) {
	if (result.stopHung) {
		throw new Error(
			`Helper did not exit within ${STOP_HANG_LIMIT_MS}ms of "stop" (issue #252). ` +
				`stop-timing steps seen: ${readStopTimingSteps(result.stderr).join(", ") || "none"}`,
		);
	}
	const steps = readStopTimingSteps(result.stderr);
	if (!steps.includes("command-received")) {
		throw new Error(
			'Helper never acknowledged the stop command ("[stop-timing] step=command-received").',
		);
	}
	if (steps.includes("wgc-session-close") === false) {
		throw new Error(
			`Helper stopped without completing its shutdown sequence. Steps: ${steps.join(", ")}`,
		);
	}
	if (result.stopLatencyMs !== null && result.stopLatencyMs > STOP_LATENCY_BUDGET_MS) {
		throw new Error(
			`Stop took ${result.stopLatencyMs}ms, over the ${STOP_LATENCY_BUDGET_MS}ms budget.`,
		);
	}
}

function startFixtureWindow() {
	return new Promise((resolve, reject) => {
		const child = spawn("mspaint.exe", [], {
			stdio: ["ignore", "ignore", "ignore"],
			windowsHide: false,
		});

		const poll = setInterval(() => {
			const lookup = spawnSync(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					`(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).MainWindowHandle`,
				],
				{ encoding: "utf8", windowsHide: true },
			);
			const handle = lookup.stdout
				.trim()
				.split(/\r?\n/)
				.find((line) => /^\d+$/.test(line.trim()));
			if (handle && handle !== "0") {
				clearInterval(poll);
				clearTimeout(timer);
				resolve({ child, sourceId: `window:${handle.trim()}:0` });
			}
		}, 250);

		const timer = setTimeout(() => {
			clearInterval(poll);
			child.kill();
			reject(new Error("Timed out waiting for fixture window handle"));
		}, 10_000);
		child.once("error", (error) => {
			clearInterval(poll);
			clearTimeout(timer);
			reject(error);
		});
	});
}

/**
 * Windows Graphics Capture delivers frames on compositor damage, not on a
 * fixed clock -- on a genuinely idle desktop the frame pool can go a full
 * test run without ever firing FrameArrived once. That is invisible to most
 * of this harness, which just needs *a* frame eventually, but the
 * stalled-frame-callback regression check needs one to land *inside* the
 * DURATION_MS window specifically, so the stall this injects is actually the
 * thing holding the frame lock when `stop` arrives.
 *
 * Moving the cursor alone does not reliably do this: most modern GPU/driver
 * combinations composite the cursor on its own hardware overlay plane, so
 * repositioning it never touches the desktop bitmap WGC captures (confirmed
 * empirically here -- frames=0 with a cursor-only nudge running the whole
 * test). A visible window changing position is not optional the way the
 * cursor is; DWM has to redraw the area it moved across. Returns a stop
 * function; always call it, paired failure or not, or the window and its
 * PowerShell host outlive the test process.
 */
function startScreenActivity() {
	const child = spawn(
		"powershell",
		[
			"-NoProfile",
			"-Command",
			"Add-Type -AssemblyName System.Windows.Forms; " +
				"$f = New-Object System.Windows.Forms.Form; " +
				"$f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(0,0); " +
				"$f.Size = New-Object System.Drawing.Size(200,200); " +
				"$f.TopMost = $true; $f.Show(); " +
				"$x = 0; " +
				"while ($true) { " +
				"$f.Location = New-Object System.Drawing.Point($x, 0); " +
				"$x = ($x + 20) % 200; " +
				"[System.Windows.Forms.Application]::DoEvents(); " +
				"Start-Sleep -Milliseconds 100; " +
				"}",
		],
		{ stdio: ["ignore", "ignore", "ignore"], windowsHide: false },
	);
	return () => child.kill();
}

/**
 * One PowerShell file plays both roles of the --window-popup fixture, each in
 * its own process:
 *
 *  - `target`: an ordinary titled window that opens a flat-colour context menu
 *    (a ToolStripDropDown owned by that window, which is what a real app's menu is).
 *  - `intruder`: a borderless TopMost popup of another flat colour that belongs to
 *    nobody the target knows. `-Tool 1` adds WS_EX_TOOLWINDOW, the other
 *    qualifying style, so both are exercised.
 *
 * DPI-aware so every coordinate is a physical pixel, the unit WGC reports in.
 */
const POPUP_FIXTURE_SCRIPT = String.raw`param([string]$Role, [int]$X, [int]$Y, [int]$W, [int]$H, [string]$Color, [int]$Popup = 0, [int]$Tool = 0, [string]$Placement = 'overhang')
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
public class PopupForm : Form {
    public bool IsPopup, ToolWindow;
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            if (IsPopup) { cp.Style = unchecked((int)0x80000000) | 0x10000000 | 0x06000000; }
            cp.ExStyle = (cp.ExStyle & ~0x80) | 0x8 | 0x08000000 | (ToolWindow ? 0x80 : 0);
            return cp;
        }
    }
}
public static class Fx {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    // Every visible window above the target that overlaps it, top of the z-order
    // first, as class/pid/style/exstyle/Q|N. Q marks WS_POPUP or WS_EX_TOOLWINDOW,
    // the styles IncludeSecondaryWindows can draw; DWM only draws a window when
    // every window between it and the target qualifies, so one N above the target
    // would make "the stranger is absent" true for a reason that proves nothing.
    public static string ChainAbove(IntPtr target, RECT t) {
        StringBuilder sb = new StringBuilder();
        for (IntPtr h = GetWindow(target, 3); h != IntPtr.Zero; h = GetWindow(h, 3)) {
            int cloaked; DwmGetWindowAttribute(h, 13, out cloaked, 4);
            RECT r; GetWindowRect(h, out r);
            if (!IsWindowVisible(h) || cloaked != 0 || r.Right <= t.Left || r.Left >= t.Right || r.Bottom <= t.Top || r.Top >= t.Bottom) continue;
            int style = GetWindowLong(h, -16), ex = GetWindowLong(h, -20);
            StringBuilder cn = new StringBuilder(64); GetClassName(h, cn, 64);
            uint pid; GetWindowThreadProcessId(h, out pid);
            bool q = (style & unchecked((int)0x80000000)) != 0 || (ex & 0x80) != 0;
            if (sb.Length > 0) sb.Append(';');
            sb.Append(cn.ToString().Replace(' ', '_')).Append('/').Append(pid).Append("/0x").Append(style.ToString("x")).Append("/0x").Append(ex.ToString("x")).Append(q ? "/Q" : "/N");
        }
        return sb.Length == 0 ? "-" : sb.ToString();
    }
}
"@
[void][Fx]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()
$rgb = $Color.Split(',') | ForEach-Object { [int]$_ }
$fill = [System.Drawing.Color]::FromArgb($rgb[0], $rgb[1], $rgb[2])
if ($Role -eq 'intruder') {
    $form = New-Object PopupForm
    $form.IsPopup = ($Popup -eq 1)
    $form.ToolWindow = ($Tool -eq 1)
    $form.FormBorderStyle = 'None'
    $form.StartPosition = 'Manual'
    $form.Bounds = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
    $form.BackColor = $fill
    $form.TopMost = $true
    $form.Add_Shown({
        $style = '0x{0:x}' -f [Fx]::GetWindowLong($form.Handle, -16)
        $exstyle = '0x{0:x}' -f [Fx]::GetWindowLong($form.Handle, -20)
        [Console]::Out.WriteLine("READY hwnd=$($form.Handle.ToInt64()) style=$style exstyle=$exstyle")
        [Console]::Out.Flush()
    })
    [System.Windows.Forms.Application]::Run($form)
    exit
}
$form = New-Object System.Windows.Forms.Form
$form.Text = 'OpenScreen popup fixture'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.ClientSize = New-Object System.Drawing.Size($W, $H)
$form.BackColor = [System.Drawing.Color]::FromArgb(200, 200, 200)
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.AutoClose = $false
$menu.ShowImageMargin = $false
$menu.ShowCheckMargin = $false
$menu.Padding = [System.Windows.Forms.Padding]::Empty
$menu.BackColor = $fill
$label = New-Object System.Windows.Forms.ToolStripLabel
$label.AutoSize = $false
$label.Size = New-Object System.Drawing.Size(240, 160)
$label.BackColor = $fill
[void]$menu.Items.Add($label)
$form.Add_Shown({
    $r = New-Object Fx+RECT
    [void][Fx]::DwmGetWindowAttribute($form.Handle, 9, [ref]$r, 16)
    $menuX = if ($Placement -eq 'inside') { $r.Left + 60 } else { $r.Right - 140 }
    $menu.Show($form, $form.PointToClient((New-Object System.Drawing.Point($menuX, ($r.Top + 80)))))
    $b = $menu.Bounds
    $chain = [Fx]::ChainAbove($form.Handle, $r)
    [Console]::Out.WriteLine("READY hwnd=$($form.Handle.ToInt64()) left=$($r.Left) top=$($r.Top) right=$($r.Right) bottom=$($r.Bottom) menu=$($b.X),$($b.Y),$($b.Width),$($b.Height) chain=$chain")
    [Console]::Out.Flush()
})
[System.Windows.Forms.Application]::Run($form)
`;

function startPopupFixture(scriptPath, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"powershell",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args.map(String)],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: false },
		);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Popup fixture never became ready.\n${stdout}\n${stderr}`));
		}, 30_000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			const ready = stdout.match(/^READY (.*)$/m);
			if (ready) {
				clearTimeout(timer);
				resolve({
					child,
					info: Object.fromEntries([...ready[1].matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]])),
				});
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(
				new Error(`Popup fixture exited (${code}) before it was ready.\n${stdout}\n${stderr}`),
			);
		});
	});
}

/** Flat fixture colours, matched loosely: H.264 shifts a saturated colour a few levels. */
const POPUP_COLOR = {
	menu: { rgb: "255,0,255", match: (r, g, b) => r > 200 && g < 70 && b > 200 },
	stranger: { rgb: "0,255,0", match: (r, g, b) => g > 200 && r < 80 && b < 80 },
	strangerTool: { rgb: "255,255,0", match: (r, g, b) => r > 200 && g > 200 && b < 80 },
	strangerToolOnly: { rgb: "0,255,255", match: (r, g, b) => g > 200 && b > 200 && r < 80 },
};
/**
 * The three ways a stranger can meet IncludeSecondaryWindows' style rule, one
 * process each: WS_POPUP alone, WS_POPUP + WS_EX_TOOLWINDOW (what a real menu or
 * tooltip is), and WS_EX_TOOLWINDOW alone. All TopMost, all over the target.
 */
const POPUP_STRANGERS = {
	stranger: { x: 300, y: 480, popup: 1, tool: 0 },
	strangerTool: { x: 700, y: 480, popup: 1, tool: 1 },
	strangerToolOnly: { x: 1000, y: 560, popup: 0, tool: 1 },
};

/** The last frame of a recording as raw RGB, so it is measured and not eyeballed. */
function readLastRgbFrame(videoPath) {
	const video = probeStreams(videoPath).find((stream) => stream.codec_type === "video");
	const { width, height } = video;
	const ffmpeg = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-sseof",
			"-0.5",
			"-i",
			videoPath,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgb24",
			"pipe:1",
		],
		{ windowsHide: true, maxBuffer: width * height * 3 + 1024 * 1024 },
	);
	if (ffmpeg.status !== 0 || ffmpeg.stdout.length !== width * height * 3) {
		throw new Error(`ffmpeg frame extraction failed: ${ffmpeg.stderr?.toString() ?? ""}`);
	}
	return { width, height, data: ffmpeg.stdout };
}

function measureColor({ width, height, data }, matches) {
	const box = { count: 0, minX: Infinity, maxX: -1, minY: Infinity, maxY: -1 };
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const i = (y * width + x) * 3;
			if (matches(data[i], data[i + 1], data[i + 2])) {
				box.count += 1;
				box.minX = Math.min(box.minX, x);
				box.maxX = Math.max(box.maxX, x);
				box.minY = Math.min(box.minY, y);
				box.maxY = Math.max(box.maxY, y);
			}
		}
	}
	return box;
}

function measurePopupFrame(videoPath) {
	const frame = readLastRgbFrame(videoPath);
	return {
		width: frame.width,
		height: frame.height,
		menu: measureColor(frame, POPUP_COLOR.menu.match),
		stranger: measureColor(frame, POPUP_COLOR.stranger.match),
		strangerTool: measureColor(frame, POPUP_COLOR.strangerTool.match),
		strangerToolOnly: measureColor(frame, POPUP_COLOR.strangerToolOnly.match),
	};
}

/**
 * One take: `target` shows its menu (`inside`, or `overhang` past the right
 * edge), the three strangers sit over the lower half of it, and the helper is
 * pointed at the target window three times: with the kill switch (the bug), as
 * shipped (the fix), and as a monitor capture (the control that proves the
 * strangers really are on screen and really are detectable).
 */
async function runWindowPopupScenario(placement, scriptPath, baseConfig) {
	const fixtures = [];
	const measured = {};
	try {
		// Strangers first, target last: a window created later sits higher in the
		// z-order, and the target must have nothing but them above it.
		for (const [name, stranger] of Object.entries(POPUP_STRANGERS)) {
			fixtures.push(
				await startPopupFixture(scriptPath, [
					...["-Role", "intruder", "-X", stranger.x, "-Y", stranger.y, "-W", "250", "-H", "120"],
					...["-Color", POPUP_COLOR[name].rgb, "-Popup", stranger.popup, "-Tool", stranger.tool],
				]),
			);
		}
		const target = await startPopupFixture(scriptPath, [
			...["-Role", "target", "-X", "400", "-Y", "150", "-W", "700", "-H", "500"],
			...["-Color", POPUP_COLOR.menu.rgb, "-Placement", placement],
		]);
		fixtures.push(target);
		measured.fixture = {
			target: target.info,
			...Object.fromEntries(
				Object.keys(POPUP_STRANGERS).map((name, i) => [name, fixtures[i].info]),
			),
		};
		// Let DWM finish drawing all three before the first frame is asked for.
		await new Promise((resolve) => setTimeout(resolve, 1000));

		const takes = {
			killSwitch: {
				sourceType: "window",
				extraEnv: { OPENSCREEN_WGC_DISABLE_SECONDARY_WINDOWS: "1" },
			},
			shipped: { sourceType: "window", extraEnv: {} },
			monitor: { sourceType: "display", extraEnv: {} },
		};
		for (const [name, take] of Object.entries(takes)) {
			const videoPath = path.join(
				os.tmpdir(),
				`openscreen-wgc-popup-${placement}-${name}-${process.pid}-${Date.now()}.mp4`,
			);
			const result = await runHelper(
				{
					...baseConfig,
					outputPath: videoPath,
					outputs: { screenPath: videoPath },
					sourceType: take.sourceType,
					sourceId: take.sourceType === "window" ? `window:${target.info.hwnd}:0` : "screen:0:0",
				},
				{ extraEnv: take.extraEnv },
			);
			assertStopWasClean(result);
			if (result.code !== 0) {
				throw new Error(
					`WGC helper exited with ${result.code}\n${result.stdout}\n${result.stderr}`,
				);
			}
			const secondary = result.stdout
				.split(/\r?\n/)
				.find((line) => line.includes('"event":"secondary-windows"'));
			measured[name] = {
				secondaryWindows: secondary ? JSON.parse(secondary).applied : null,
				...measurePopupFrame(videoPath),
			};
			fs.rmSync(videoPath, { force: true });
		}
	} finally {
		for (const fixture of fixtures) {
			fixture.child.kill();
		}
	}
	return measured;
}

function assertWindowPopupScenario(placement, m) {
	const failures = [];
	const target = m.fixture.target;
	const ext = { width: Number(target.right) - Number(target.left) };
	const [menuX, , menuW] = target.menu.split(",").map(Number);
	const menuLeftInFrame = menuX - Number(target.left);
	// Everything above the target must qualify, or a missing stranger proves nothing.
	const blockers = target.chain.split(";").filter((entry) => entry.endsWith("/N"));
	if (blockers.length > 0) {
		failures.push(
			`fixture invalid, non-qualifying windows sit above the target: ${blockers.join(" ")}`,
		);
	}
	// The baseline is the bug itself; if the menu shows up with the option off, this
	// fixture is not testing what it claims to.
	if (m.killSwitch.secondaryWindows !== null || m.killSwitch.menu.count > 20) {
		failures.push(`kill switch did not remove the menu: ${JSON.stringify(m.killSwitch)}`);
	}
	// The control: the strangers must be visible to a monitor capture, or "absent" below
	// means nothing.
	for (const name of ["menu", ...Object.keys(POPUP_STRANGERS)]) {
		if (m.monitor[name].count < 1000) {
			failures.push(
				`control monitor capture did not see the ${name} colour: ${m.monitor[name].count}px`,
			);
		}
	}
	if (m.shipped.secondaryWindows === false) {
		console.log(
			"Windows runtime cannot include secondary windows (needs 11 24H2, build 26100): skipping the menu check.",
		);
	} else {
		if (m.shipped.secondaryWindows !== true) {
			failures.push(
				`helper did not report secondary-windows applied: ${m.shipped.secondaryWindows}`,
			);
		}
		if (m.shipped.menu.count < 5000) {
			failures.push(`menu missing from the window recording: ${m.shipped.menu.count}px`);
		}
		const visibleWidth = m.shipped.menu.maxX - m.shipped.menu.minX + 1;
		if (placement === "overhang") {
			// Clipped at the window edge: touches the last column, never widens the frame.
			if (m.shipped.menu.maxX < m.shipped.width - 2) {
				failures.push(
					`overhanging menu does not reach the frame edge: maxX=${m.shipped.menu.maxX}`,
				);
			}
			const expected = m.shipped.width - menuLeftInFrame;
			if (Math.abs(visibleWidth - expected) > 8 || visibleWidth >= menuW) {
				failures.push(
					`overhanging menu is not clipped: ${visibleWidth}px visible, expected about ${expected}`,
				);
			}
		} else if (Math.abs(visibleWidth - menuW) > 8) {
			failures.push(`menu inside the window is ${visibleWidth}px wide, expected about ${menuW}`);
		}
		if (Math.abs(m.shipped.width - ext.width) > 2) {
			failures.push(`frame width ${m.shipped.width} differs from the window's ${ext.width}`);
		}
	}
	// The privacy half: another process's topmost popups must not leak in.
	for (const name of Object.keys(POPUP_STRANGERS)) {
		if (m.shipped[name].count >= 20) {
			failures.push(
				`LEAK: ${name} popup found in the window recording: ${m.shipped[name].count}px`,
			);
		}
	}
	return failures;
}

function normalizeDeviceName(value) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function scoreDeviceName(candidateName, candidateId, requestedName) {
	const candidate = normalizeDeviceName(candidateName ?? "");
	const id = normalizeDeviceName(candidateId ?? "");
	const requested = normalizeDeviceName(requestedName ?? "");
	if (!requested) return 0;
	if (candidate === requested) return 1000;
	if (candidate.includes(requested) || requested.includes(candidate)) return 900;
	if (id.includes(requested) || requested.includes(id)) return 800;
	return requested
		.split(/\s+/)
		.filter((word) => word.length > 1 && !["camera", "webcam", "video", "input"].includes(word))
		.reduce((score, word) => {
			if (candidate.includes(word)) return score + 100;
			if (id.includes(word)) return score + 50;
			return score;
		}, 0);
}

function resolveDirectShowWebcamClsid(requestedName) {
	if (!requestedName) return "";
	const query = spawnSync(
		"reg.exe",
		["query", "HKCR\\CLSID\\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\Instance", "/s"],
		{ encoding: "utf8", windowsHide: true },
	);
	if (query.status !== 0) return "";
	const entries = [];
	let current = {};
	for (const rawLine of query.stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (/^HKEY_/i.test(line)) {
			if (current.friendlyName || current.clsid) entries.push(current);
			current = {};
			continue;
		}
		const match = line.match(/^(\S+)\s+REG_SZ\s+(.+)$/);
		if (!match) continue;
		if (match[1] === "FriendlyName") current.friendlyName = match[2].trim();
		if (match[1] === "CLSID") current.clsid = match[2].trim();
	}
	if (current.friendlyName || current.clsid) entries.push(current);

	let best = null;
	for (const entry of entries) {
		if (!entry.clsid) continue;
		const score = scoreDeviceName(entry.friendlyName, entry.clsid, requestedName);
		if (!best || score > best.score) {
			best = { ...entry, score };
		}
	}
	return best && best.score > 0 ? best.clsid : "";
}

function probeStreams(outputPath) {
	const ffprobe = spawnSync(
		"ffprobe",
		["-v", "error", "-show_streams", "-of", "json", outputPath],
		{ encoding: "utf8", windowsHide: true },
	);
	if (ffprobe.status !== 0) {
		throw new Error(`ffprobe failed: ${ffprobe.stderr || ffprobe.stdout}`);
	}
	return JSON.parse(ffprobe.stdout).streams ?? [];
}

/**
 * The property the fragmented container exists for, checked without having to
 * kill anything: a fragmented MP4 carries its index up front and its samples in
 * self-describing `moof`+`mdat` pairs, so a prefix of the file still decodes. A
 * plain MP4 only becomes readable when `Finalize()` writes `moov` at the end,
 * which is exactly the call the shutdown watchdog's `TerminateProcess`
 * pre-empts in issues #252 / #292 / #327.
 *
 * Truncating a copy is a proxy for that kill, not a replacement: it proves the
 * container survives losing its tail. It does not prove the helper flushed
 * anything before dying, which only the real kill test can.
 */
function assertPrefixIsReadable(outputPath) {
	const truncatedPath = `${outputPath}.truncated.mp4`;
	const source = fs.readFileSync(outputPath);
	fs.writeFileSync(truncatedPath, source.subarray(0, Math.floor(source.length * 0.6)));
	try {
		// A plain MP4 does not merely lose its tail here, it fails to open at
		// all ("moov atom not found"), so the throw and the empty result are the
		// same finding and get the same message.
		let truncatedStreams = [];
		try {
			truncatedStreams = probeStreams(truncatedPath);
		} catch {
			truncatedStreams = [];
		}
		if (!truncatedStreams.some((stream) => stream.codec_name === "h264")) {
			throw new Error(
				`A 60% prefix of ${outputPath} has no readable H.264 stream, so the recording is ` +
					"still all-or-nothing: the container is not fragmented.",
			);
		}
	} finally {
		fs.rmSync(truncatedPath, { force: true });
	}
}

function measureFirstFrameLuma(outputPath) {
	const ffmpeg = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-i",
			outputPath,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"gray",
			"pipe:1",
		],
		{ windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
	);
	if (ffmpeg.status !== 0) {
		throw new Error(`ffmpeg frame extraction failed: ${ffmpeg.stderr?.toString() ?? ""}`);
	}
	const data = ffmpeg.stdout;
	if (!data || data.length === 0) {
		throw new Error(`ffmpeg did not return frame data for ${outputPath}`);
	}
	let sum = 0;
	let max = 0;
	for (const value of data) {
		sum += value;
		if (value > max) {
			max = value;
		}
	}
	return { average: sum / data.length, max };
}

if (process.platform !== "win32") {
	console.log("Skipping WGC helper smoke test: Windows-only.");
	process.exit(0);
}

if (!fs.existsSync(HELPER_PATH)) {
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
}

const outputPath = path.join(
	os.tmpdir(),
	`openscreen-wgc-helper-${WITH_WEBCAM ? "webcam" : WITH_WINDOW ? "window" : WITH_SYSTEM_AUDIO || WITH_MICROPHONE ? "audio" : "video"}-${process.pid}-${Date.now()}-${randomUUID()}.mp4`,
);
const webcamOutputPath = WITH_WEBCAM ? outputPath.replace(/\.mp4$/i, "-webcam.mp4") : null;

const fixtureWindow = WITH_WINDOW ? await startFixtureWindow() : null;

const config = {
	schemaVersion: 2,
	recordingId: Date.now(),
	preferSoftwareEncoder: WITH_SOFTWARE_ENCODER,
	outputPath,
	sourceType: fixtureWindow ? "window" : "display",
	sourceId: fixtureWindow ? fixtureWindow.sourceId : "screen:0:0",
	displayId: 0,
	fps: 30,
	videoWidth: 1280,
	videoHeight: 720,
	// Same reasoning as scripts/diagnostic-tool/diagnostic.mjs: without Electron
	// there is no honest display rect to send, and the helper reads these as
	// physical pixels. Omitting them lands on the primary monitor
	// deterministically instead of by accident (#346).
	hasDisplayBounds: false,
	captureSystemAudio: WITH_SYSTEM_AUDIO,
	captureMic: WITH_MICROPHONE,
	captureCursor: CAPTURE_CURSOR,
	microphoneDeviceId: process.env.OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_ID ?? "default",
	microphoneDeviceName: process.env.OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_NAME ?? "",
	microphoneGain: 1.4,
	webcamEnabled: WITH_WEBCAM,
	webcamDeviceId: process.env.OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_ID ?? "",
	webcamDeviceName: process.env.OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME ?? "",
	webcamDirectShowClsid: resolveDirectShowWebcamClsid(
		process.env.OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME ?? "",
	),
	// DEFAULT_WEBCAM_QUALITY from src/hooks/webcamCaptureTarget.ts -- the target the
	// app actually sends, so this exercises the format negotiation rather than a
	// size no shipped pipeline ever asks for. A camera that cannot reach it is
	// driven at its own best format, which is the case worth covering anyway.
	webcamWidth: Number(process.env.OPENSCREEN_WGC_TEST_WEBCAM_WIDTH ?? 3840),
	webcamHeight: Number(process.env.OPENSCREEN_WGC_TEST_WEBCAM_HEIGHT ?? 2160),
	webcamFps: Number(process.env.OPENSCREEN_WGC_TEST_WEBCAM_FPS ?? 30),
	outputs: {
		screenPath: outputPath,
		...(webcamOutputPath ? { webcamPath: webcamOutputPath } : {}),
	},
};

if (WITH_WINDOW_POPUP) {
	const scriptPath = path.join(os.tmpdir(), `openscreen-popup-fixture-${process.pid}.ps1`);
	fs.writeFileSync(scriptPath, POPUP_FIXTURE_SCRIPT);
	const scenarios = {};
	const failures = [];
	try {
		for (const placement of ["inside", "overhang"]) {
			scenarios[placement] = await runWindowPopupScenario(placement, scriptPath, config);
			failures.push(
				...assertWindowPopupScenario(placement, scenarios[placement]).map(
					(failure) => `${placement}: ${failure}`,
				),
			);
		}
	} finally {
		fs.rmSync(scriptPath, { force: true });
	}
	console.log(JSON.stringify(scenarios, null, 2));
	if (failures.length > 0) {
		throw new Error(`WGC window popup check failed:\n${failures.join("\n")}`);
	}
	console.log("WGC window popup check passed");
	process.exit(0);
}

const stopScreenActivity = WITH_STALLED_FRAME_CALLBACK ? startScreenActivity() : null;
let result;
try {
	result = await runHelper(config, {
		injectDefaultSinkWriterFailure: WITH_SOFTWARE_FALLBACK,
		stallReadbackMs: WITH_STALLED_READBACK ? STALL_READBACK_MS : 0,
		stallFrameCallbackMs: WITH_STALLED_FRAME_CALLBACK ? STALL_FRAME_CALLBACK_MS : 0,
		legacyFrameCallback: WITH_LEGACY_FRAME_CALLBACK || WITH_STALLED_FRAME_CALLBACK,
	});
} finally {
	if (fixtureWindow) {
		fixtureWindow.child.kill();
	}
	stopScreenActivity?.();
}

// The regression check for issue #252. With the frame lock deliberately wedged
// there is no usable recording to assert on -- what matters is only that the
// helper still noticed the stop and still died, naming the step it died in.
if (WITH_STALLED_READBACK) {
	if (result.stopHung) {
		throw new Error(
			`Helper survived ${STOP_HANG_LIMIT_MS}ms past "stop" with a stalled readback. ` +
				"Its shutdown watchdog did not fire (issue #252).",
		);
	}
	const steps = readStopTimingSteps(result.stderr);
	if (!steps.includes("command-received")) {
		throw new Error(`Helper never acknowledged "stop". Steps seen: ${steps.join(", ") || "none"}`);
	}
	if (!/phase=abandoned/.test(result.stderr)) {
		throw new Error(
			`Helper exited without reporting an abandoned shutdown step. stderr:\n${result.stderr}`,
		);
	}
	console.log("WGC helper stalled-readback stop check passed", {
		stopLatencyMs: result.stopLatencyMs,
		steps,
		abandoned: result.stderr.match(/step=(\S+)\s+elapsed_ms=\d+\s+phase=abandoned/)?.[1] ?? null,
	});
	fs.rmSync(outputPath, { force: true });
	process.exit(0);
}

// The regression check for getopenscreen/openscreen#460: a frame callback
// wedged inside the driver, confirmed on real hardware via a Save Diagnostics
// report. Before the fix, video-writer-join burned its whole step budget
// joining a thread parked behind that same stuck callback -- this asserts
// both that the helper still exits promptly (not the ~13s that step's own
// budget alone would cost) and that it took the specific skip path rather
// than any other route to exiting.
if (WITH_STALLED_FRAME_CALLBACK) {
	if (result.stopHung) {
		throw new Error(
			`Helper survived ${STOP_HANG_LIMIT_MS}ms past "stop" with a stalled frame callback. ` +
				"Its shutdown watchdog did not fire (issue #460).",
		);
	}
	const steps = readStopTimingSteps(result.stderr);
	if (!steps.includes("command-received")) {
		throw new Error(`Helper never acknowledged "stop". Steps seen: ${steps.join(", ") || "none"}`);
	}
	if (!result.stderr.includes("reason=frame-callback-stuck")) {
		throw new Error(
			`Helper did not take the video-writer-join skip path. stderr:\n${result.stderr}`,
		);
	}
	// wgc-quiesce's own drain is a fixed 5000ms, so a healthy skip lands
	// there plus the near-instant audio/microphone/webcam steps -- nowhere
	// near the ~13s (5s drain + the 8s step budget) the join it replaces
	// would have cost before this fix.
	const STALLED_FRAME_CALLBACK_LATENCY_BUDGET_MS = 10_000;
	if (
		result.stopLatencyMs !== null &&
		result.stopLatencyMs > STALLED_FRAME_CALLBACK_LATENCY_BUDGET_MS
	) {
		throw new Error(
			`Stop took ${result.stopLatencyMs}ms with a stalled frame callback, over the ` +
				`${STALLED_FRAME_CALLBACK_LATENCY_BUDGET_MS}ms budget the video-writer-join skip should keep it under.`,
		);
	}
	console.log("WGC helper stalled-frame-callback stop check passed", {
		stopLatencyMs: result.stopLatencyMs,
		steps,
	});
	fs.rmSync(outputPath, { force: true });
	process.exit(0);
}

assertStopWasClean(result);

if (result.code !== 0) {
	if (
		WITH_WEBCAM &&
		/No native Windows webcam devices were found|Failed to initialize native webcam/.test(
			result.stderr,
		)
	) {
		console.log("Skipping WGC webcam smoke test: no native Windows webcam device is available.");
		process.exit(0);
	}
	throw new Error(`WGC helper exited with ${result.code}\n${result.stdout}\n${result.stderr}`);
}
if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
	throw new Error(`WGC helper did not produce a video at ${outputPath}`);
}
if (WITH_WEBCAM && (!fs.existsSync(webcamOutputPath) || fs.statSync(webcamOutputPath).size === 0)) {
	throw new Error(`WGC helper did not produce a webcam video at ${webcamOutputPath}`);
}

const streams = probeStreams(outputPath);
const webcamStreams =
	webcamOutputPath && fs.existsSync(webcamOutputPath) ? probeStreams(webcamOutputPath) : [];
const hasVideo = streams.some((stream) => stream.codec_type === "video");
const hasAudio = streams.some((stream) => stream.codec_type === "audio");
const videoStream = streams.find((stream) => stream.codec_type === "video");
const webcamFormatLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"webcam-format"'));
const webcamFormat = webcamFormatLine ? JSON.parse(webcamFormatLine) : null;
const audioFormatLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"audio-format"'));
const audioFormat = audioFormatLine ? JSON.parse(audioFormatLine) : null;
const cursorCaptureLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"cursor-capture"'));
const cursorCapture = cursorCaptureLine ? JSON.parse(cursorCaptureLine) : null;
const encoderSelectionLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"encoder-selection"'));
const encoderSelection = encoderSelectionLine ? JSON.parse(encoderSelectionLine) : null;
const nativeWebcamDiagnostics = result.stderr.split(/\r?\n/).filter(
	(line) =>
		line.includes("Native webcam candidate") ||
		// Which capture format the camera was actually driven at. Without this
		// the smoke test could pass on a 640x480 take from a 4K camera and say
		// nothing about it.
		line.includes("Native webcam format") ||
		line.includes("DirectShow webcam format") ||
		line.includes("DirectShow webcam connected") ||
		line.includes("falling back to the device default") ||
		// How long the camera took to produce its first frame, and the tally of what
		// the capture loop did with everything it read. Without these, a camera that
		// delivers nothing is only visible as a failed Finalize, which cannot say why.
		line.includes("First webcam frame") ||
		line.includes("Webcam capture loop ended") ||
		line.includes("Webcam frame is"),
);
const nativeMicrophoneDiagnostics = result.stderr
	.split(/\r?\n/)
	.filter(
		(line) =>
			line.includes("Native microphone candidate") ||
			line.includes("Selected native microphone endpoint"),
	);
if (!hasVideo) {
	throw new Error(`WGC helper output has no video stream: ${outputPath}`);
}
if (videoStream.codec_name !== "h264") {
	throw new Error(
		`WGC helper output video codec is ${videoStream.codec_name ?? "unknown"}, expected h264: ${outputPath}`,
	);
}
const videoDurationSeconds = Number(videoStream.duration);
const minimumPlausibleDurationSeconds = Math.max(0.5, (DURATION_MS / 1000) * 0.5);
const maximumPlausibleDurationSeconds = Math.max(
	minimumPlausibleDurationSeconds,
	(DURATION_MS / 1000) * 2 + 2,
);
if (
	!Number.isFinite(videoDurationSeconds) ||
	videoDurationSeconds < minimumPlausibleDurationSeconds ||
	videoDurationSeconds > maximumPlausibleDurationSeconds
) {
	throw new Error(
		`WGC helper output duration ${videoStream.duration ?? "unknown"}s is not plausible for a ${DURATION_MS}ms recording: ${outputPath}`,
	);
}
if (WITH_WEBCAM && !webcamStreams.some((stream) => stream.codec_type === "video")) {
	throw new Error(`WGC helper webcam output has no video stream: ${webcamOutputPath}`);
}
if (
	(CAPTURE_CURSOR && !cursorCapture) ||
	(cursorCapture &&
		(cursorCapture.requested !== CAPTURE_CURSOR || cursorCapture.applied !== CAPTURE_CURSOR))
) {
	throw new Error(
		`WGC helper did not apply requested cursor capture mode (${CAPTURE_CURSOR}): ${result.stdout}`,
	);
}
const expectedEncoderSelection = WITH_SOFTWARE_FALLBACK
	? "software-fallback"
	: WITH_SOFTWARE_ENCODER
		? "software-preferred"
		: "default";
if (
	encoderSelection?.video !== expectedEncoderSelection ||
	encoderSelection.preferSoftwareEncoder !== WITH_SOFTWARE_ENCODER
) {
	throw new Error(
		`WGC helper encoder selection was ${JSON.stringify(encoderSelection)}, expected ${expectedEncoderSelection} with preferSoftwareEncoder=${WITH_SOFTWARE_ENCODER}: ${result.stdout}`,
	);
}
// videoEncoderRuntime is separate from `video` above: it is what
// GetTransformForStream found in the sink writer's own resolved pipeline
// after BeginWriting(), not which configuration path was tried. "unknown"
// here on a run that otherwise passed means the introspection itself is
// broken (wrong COM call, wrong category, wrong attribute), not a real
// ambiguity -- a healthy sink writer always has exactly one encoder node.
if (!["hardware", "software", "unknown"].includes(encoderSelection.videoEncoderRuntime)) {
	throw new Error(
		`WGC helper reported an unrecognised videoEncoderRuntime: ${JSON.stringify(encoderSelection)}`,
	);
}
if (encoderSelection.videoEncoderRuntime === "unknown") {
	throw new Error(
		`WGC helper could not introspect its own sink writer for videoEncoderRuntime: ${JSON.stringify(encoderSelection)}`,
	);
}
// forceSoftwareEncoder disables hardware transforms explicitly
// (MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS=FALSE), so this is deterministic
// regardless of what the test machine has registered -- unlike the "default"
// path, whose runtime legitimately depends on the machine.
if (
	(WITH_SOFTWARE_ENCODER || WITH_SOFTWARE_FALLBACK) &&
	encoderSelection.videoEncoderRuntime !== "software"
) {
	throw new Error(
		`WGC helper forced the software encoder but videoEncoderRuntime was ${encoderSelection.videoEncoderRuntime}, expected software: ${JSON.stringify(encoderSelection)}`,
	);
}
// Every fallback path has to stay fragmented, not just the nominal one. The
// helper degrades to the plain container rather than failing a recording, so
// without this the fix could quietly stop applying and every other assertion
// here would still pass.
if (encoderSelection.container !== "fragmented-mp4") {
	throw new Error(
		`WGC helper wrote a ${encoderSelection.container} container, expected fragmented-mp4: ${result.stdout}`,
	);
}
assertPrefixIsReadable(outputPath);
if (webcamOutputPath && fs.existsSync(webcamOutputPath)) {
	assertPrefixIsReadable(webcamOutputPath);
}

const combinedHelperOutput = `${result.stdout}\n${result.stderr}`;
const helperDiagnosticLines = combinedHelperOutput.split(/\r?\n/).filter(Boolean);
const injectionLines = helperDiagnosticLines.filter((line) => line.includes(INJECTION_MARKER));
const fallbackDiagnosticPatterns = [
	INJECTION_MARKER,
	"WARNING: Sink-writer creation failed (hr=0x80070003)",
	"retrying with the Microsoft software H.264 encoder.",
	"INFO: Registered the Microsoft software H.264 MFT locally for this helper process.",
	"INFO: Created the real software H.264 sink writer successfully.",
];
const fallbackDiagnostics = WITH_SOFTWARE_FALLBACK
	? helperDiagnosticLines.filter((line) =>
			fallbackDiagnosticPatterns.some((pattern) => line.includes(pattern)),
		)
	: [];
if (WITH_SOFTWARE_FALLBACK) {
	if (
		injectionLines.length !== 1 ||
		!injectionLines[0].includes("hr=0x80070003") ||
		!injectionLines[0].includes("consumed exactly once")
	) {
		throw new Error(
			`Expected exactly one consumed 0x80070003 test-only injection, found ${injectionLines.length}: ${combinedHelperOutput}`,
		);
	}
	for (const pattern of fallbackDiagnosticPatterns.slice(1)) {
		if (!helperDiagnosticLines.some((line) => line.includes(pattern))) {
			throw new Error(
				`WGC helper fallback diagnostics are missing ${JSON.stringify(pattern)}: ${combinedHelperOutput}`,
			);
		}
	}
} else if (injectionLines.length !== 0) {
	throw new Error(
		`WGC helper unexpectedly injected a default sink-writer failure: ${combinedHelperOutput}`,
	);
}
if ((WITH_SYSTEM_AUDIO || WITH_MICROPHONE) && !hasAudio) {
	throw new Error(`WGC helper output has no audio stream: ${outputPath}`);
}
const frameLuma = measureFirstFrameLuma(outputPath);
if (frameLuma.average < 1 && frameLuma.max < 5) {
	throw new Error(
		`WGC helper output first frame is black: ${outputPath}\n${result.stdout}\n${result.stderr}`,
	);
}

console.log(
	JSON.stringify(
		{
			success: true,
			stopLatencyMs: result.stopLatencyMs,
			stopTimingSteps: readStopTimingSteps(result.stderr),
			outputPath,
			webcamOutputPath,
			bytes: fs.statSync(outputPath).size,
			webcamBytes:
				webcamOutputPath && fs.existsSync(webcamOutputPath)
					? fs.statSync(webcamOutputPath).size
					: undefined,
			streams: streams.map((stream) => ({
				index: stream.index,
				codecType: stream.codec_type,
				codecName: stream.codec_name,
				duration: stream.duration,
			})),
			webcamStreams: webcamStreams.map((stream) => ({
				index: stream.index,
				codecType: stream.codec_type,
				codecName: stream.codec_name,
				width: stream.width,
				height: stream.height,
				duration: stream.duration,
			})),
			cursorCapture,
			encoderSelection,
			selectedMicrophoneDeviceName: audioFormat?.microphoneDeviceName,
			selectedWebcamDeviceName: webcamFormat?.deviceName,
			nativeMicrophoneDiagnostics,
			nativeWebcamDiagnostics,
			fallbackDiagnostics,
			firstFrameLuma: frameLuma,
		},
		null,
		2,
	),
);
