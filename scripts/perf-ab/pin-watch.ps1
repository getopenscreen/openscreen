# Pins every visible top-level window whose process runs $ExePath on top as soon as it appears,
# for $Seconds. A window a background process opens lands behind the foreground one, and a fully
# covered Chromium window is throttled, which would time the cover instead of the app.
# Start it BEFORE the app and wait for "ready": compiling the helper costs a CPU burst that must not
# land on the app's startup.
param([Parameter(Mandatory)][string]$ExePath, [int]$Seconds = 40)
Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class Pin {
	delegate bool EnumProc(IntPtr h, IntPtr l);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
	static readonly HashSet<IntPtr> done = new HashSet<IntPtr>();
	static readonly Dictionary<uint, bool> ours = new Dictionary<uint, bool>();
	static bool IsOurs(uint pid, string exe) {
		bool v;
		if (ours.TryGetValue(pid, out v)) return v;
		try { v = string.Equals(Process.GetProcessById((int)pid).MainModule.FileName, exe, StringComparison.OrdinalIgnoreCase); }
		catch { v = false; }
		ours[pid] = v;
		return v;
	}
	public static void Sweep(string exe) {
		EnumWindows((h, l) => {
			uint p;
			GetWindowThreadProcessId(h, out p);
			if (!done.Contains(h) && IsWindowVisible(h) && IsOurs(p, exe)) {
				done.Add(h);
				// HWND_TOPMOST, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
				SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0013);
			}
			return true;
		}, IntPtr.Zero);
	}
}
"@
[Pin]::Sweep($ExePath)
"ready"
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
	[Pin]::Sweep($ExePath)
	Start-Sleep -Milliseconds 5
}
