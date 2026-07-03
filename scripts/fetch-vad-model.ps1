# Fetches the bundled Silero VAD model into `electron/native/models/silero/`.
# Mirror of `scripts/fetch-vad-model.sh` for Windows hosts. See the .sh script
# for the rationale; this file exists so `npm run setup:vad` works in either
# shell.

$ErrorActionPreference = "Stop"

$root   = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outDir = Join-Path $root "electron\native\models\silero"
$out    = Join-Path $outDir "ggml-silero-v6.2.0.bin"
$url    = "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin"

if (Test-Path -LiteralPath $out) {
	$existing = (Get-Item -LiteralPath $out).Length
	if ($existing -gt 0) {
		Write-Host "Silero VAD model already present at $out; skipping download."
		exit 0
	}
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$tmp = "$out.partial"
Write-Host "Downloading Silero VAD model -> $out"
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
Move-Item -LiteralPath $tmp -Destination $out -Force

$size = (Get-Item -LiteralPath $out).Length
Write-Host "Done: $size bytes at $out"
