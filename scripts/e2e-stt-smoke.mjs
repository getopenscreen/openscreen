// End-to-end STT smoke test: spawns whisper-server directly (same binary/args
// as whisperServer.ts) and transcribes the actual user recording (12-second
// webm), same way the IPC handler does.
//
// Run: node scripts/e2e-stt-smoke.mjs

import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const RECORDING = join(
	process.env.APPDATA || tmpdir(),
	"Electron",
	"recordings",
	"recording-1783174040055.webm",
);
const WHISPER_BIN = join(
	ROOT,
	"electron",
	"native",
	"bin",
	"win32-x64",
	"whisper-server-whisper-cpu.exe",
);
const MODEL_PATH = join(
	process.env.APPDATA || tmpdir(),
	"Electron",
	"stt-models",
	"whisper",
	"ggml-small-q5_1.bin",
);

async function extractWav(src, dst) {
	const ffmpeg = spawn("ffmpeg", ["-y", "-i", src, "-ar", "16000", "-ac", "1", "-f", "wav", dst], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise((resolve, reject) => {
		let stderr = "";
		ffmpeg.stderr.on("data", (c) => (stderr += c.toString()));
		ffmpeg.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr}`)),
		);
		ffmpeg.on("error", reject);
	});
}

async function main() {
	console.log("=== STT end-to-end smoke test ===");

	// 1. ffmpeg-extract the recording to 16 kHz mono WAV.
	const tmpDir = join(tmpdir(), "openscreen-stt-e2e");
	await mkdir(tmpDir, { recursive: true });
	const wavPath = join(tmpDir, "audio.wav");
	console.log(`Converting ${RECORDING} → ${wavPath}`);
	await extractWav(RECORDING, wavPath);
	const { size } = await stat(wavPath);
	console.log(`WAV ready: ${size} bytes`);

	// 2. Spawn whisper-server directly (skip the wrapper module to keep the
	//    smoke test dependency-light).
	const port = 18800;
	console.log(`Spawning whisper-server on 127.0.0.1:${port}`);
	const server = spawn(
		WHISPER_BIN,
		["-m", MODEL_PATH, "--port", String(port), "--host", "127.0.0.1"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	server.stderr.on("data", (c) => {
		const line = c.toString().trimEnd();
		if (line) console.log(`  server> ${line}`);
	});

	// 3. Wait for server to be ready (poll /).
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`http://127.0.0.1:${port}/`);
			if (r.ok) break;
		} catch {
			// not up yet
		}
		await new Promise((res) => setTimeout(res, 250));
	}
	console.log(`Server up: ${Date.now() - (deadline - 30_000)}ms`);

	// 4. Read the WAV bytes, post to /inference with response_format=verbose_json.
	const wavBytes = await readFile(wavPath);
	const form = new FormData();
	form.append("file", new Blob([wavBytes], { type: "audio/wav" }), basename(wavPath));
	form.append("response_format", "verbose_json");
	form.append("language", "auto");

	const t0 = Date.now();
	const response = await fetch(`http://127.0.0.1:${port}/inference`, {
		method: "POST",
		body: form,
	});
	const json = await response.json();
	const elapsed = Date.now() - t0;
	console.log(`Inference took ${elapsed}ms`);
	console.log("--- Whisper output ---");
	if (json.text) console.log(`text: ${JSON.stringify(json.text)}`);
	if (Array.isArray(json.segments)) {
		for (const seg of json.segments) {
			console.log(`  [${seg.start?.toFixed(2)}-${seg.end?.toFixed(2)}] ${seg.text?.trim()}`);
		}
	}

	// 5. Cleanup.
	server.kill("SIGTERM");
	await new Promise((res) => setTimeout(res, 1500));
	if (!server.killed) server.kill("SIGKILL");

	console.log("\n=== Smoke test complete ===");
}

main().catch((err) => {
	console.error("FAILED:", err);
	process.exit(1);
});
