# Puts every visible top-level window of process $ProcessId (or of its descendants: a launcher shim
# owns no window) above all others. A window a background
# process creates opens behind the foreground one (Windows refuses the focus steal), so without this
# the desktop capture films whatever covers the editor.
param([Parameter(Mandatory)][int]$ProcessId)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
	public delegate bool EnumProc(IntPtr h, IntPtr l);
	[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
	[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
	[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
	[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
	[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$pids = @{ $ProcessId = $true }
do {
	$added = 0
	foreach ($p in $all) { if ($pids.ContainsKey([int]$p.ParentProcessId) -and -not $pids.ContainsKey([int]$p.ProcessId)) { $pids[[int]$p.ProcessId] = $true; $added++ } }
} while ($added)
$done = 0
[Win]::EnumWindows({
	param($h, $l)
	$p = 0
	[void][Win]::GetWindowThreadProcessId($h, [ref]$p)
	if ($pids.ContainsKey([int]$p) -and [Win]::IsWindowVisible($h) -and [Win]::GetWindowTextLength($h) -gt 0) {
		# A minimized window measures nothing: bring it back maximized first (SW_MAXIMIZE).
		if ([Win]::IsIconic($h)) { [void][Win]::ShowWindow($h, 3) }
		# HWND_TOPMOST, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
		[void][Win]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0013)
		$script:done++
	}
	return $true
}, [IntPtr]::Zero) | Out-Null
$done
