# One JSON snapshot of every process whose executable lives under $Root: CPU seconds, memory, role.
param([Parameter(Mandatory)][string]$Root)
$rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
$procs = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase) }
$out = foreach ($p in $procs) {
	$cl = [string]$p.CommandLine
	$role = if ($cl -match '--type=([a-z-]+)') { $Matches[1] } elseif ($p.Name -ne 'Openscreen.exe') { $p.Name } else { 'main' }
	if ($role -eq 'utility' -and $cl -match '--utility-sub-type=([A-Za-z.]+)') { $role = "utility:$($Matches[1])" }
	[pscustomobject]@{
		pid = [int]$p.ProcessId
		ppid = [int]$p.ParentProcessId
		name = $p.Name
		role = $role
		cpuSec = ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 1e7
		ws = [int64]$p.WorkingSetSize
		peakWs = [int64]$p.PeakWorkingSetSize * 1024
		priv = [int64]$p.PrivatePageCount
	}
}
@($out) | ConvertTo-Json -Compress -Depth 3
