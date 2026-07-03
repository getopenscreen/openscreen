import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Filename of the bundled Silero VAD model. Single file, portable across
 * all platforms (ggml has no per-arch variants) — placed under
 * `electron/native/models/silero/` in the checkout and packaged into
 * `process.resourcesPath/models/silero/` via electron-builder's `extraResources`
 * entry for `electron/native/models`.
 */
const VAD_MODEL_FILE = "ggml-silero-v6.2.0.bin";
const VAD_MODEL_DIR_NAME = "silero";

/**
 * Pinned SHA-256 of the upstream ggml-silero-v6.2.0.bin from
 *   https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin
 * (885098 bytes, ggml magic verified against the upstream blob's content-length).
 * Verified at fetch time by `scripts/fetch-vad-model.{sh,ps1}` once a release
 * maintainer downloads it against a clean install and locks the digest here;
 * a tampered or partially-downloaded copy of the model then shows up at
 * runtime as a "hash mismatch" rather than as silently-wrong VAD output.
 */
const VAD_MODEL_EXPECTED_SHA256 =
	"2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987";

/**
 * Required runtime asset for whisper-server's built-in VAD. whisper.cpp ships
 * with Silero VAD as a native integration (the ggml model ships with the
 * project, no separate download UX). We bundle it for one reason: VAD is
 * load-bearing for accurate word-level timestamps after leading silence, and
 * a "first-run download" pathway is exactly the kind of fallback that has
 * failed in the wild on offline installs.
 */
export function resolveVadModelPath(here: string = process.cwd()): string | null {
	const resourceRoot = process.resourcesPath ?? "";
	const candidates = [
		// Packaged: extraResources entry copies electron/native/models → resourcesPath/models.
		path.join(resourceRoot, "models", VAD_MODEL_DIR_NAME, VAD_MODEL_FILE),
		// Local checkout: alongside the whisper-server binary source tree.
		path.join(here, "electron", "native", "models", VAD_MODEL_DIR_NAME, VAD_MODEL_FILE),
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return null;
}

/** Pinned upstream digest; see `VAD_MODEL_EXPECTED_SHA256` above. */
export function expectedVadSha256(): string {
	return VAD_MODEL_EXPECTED_SHA256;
}
