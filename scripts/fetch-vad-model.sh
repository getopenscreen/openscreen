#!/usr/bin/env bash
# Fetches the bundled Silero VAD model into `electron/native/models/silero/`.
#
# This runs at install / release-prep time (NOT at app runtime). The app's
# `electron/stt/vadModel.ts` resolves the path unconditionally; if the file
# isn't present, transcription refuses to start. There is no lazy download
# pathway on purpose — VAD is the load-bearing piece that keeps word
# timestamps accurate after leading silence, and a first-run network step
# would be exactly the kind of fallback that's failed in the wild.
#
# Upstream: https://huggingface.co/ggml-org/silero-vad/resolve/main/ggml-silero-v6.2.0.bin
#   (~2 MB; ggml is portable across platforms, no per-arch variant needed).
#
# Local use:
#   bash scripts/fetch-vad-model.sh
#
# CI: invoked by .github/workflows/build.yml before electron-builder packages
# the app, so the bundled installer always carries the model.

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly OUT_DIR="${ROOT}/electron/native/models/silero"
readonly OUT_FILE="${OUT_DIR}/ggml-silero-v6.2.0.bin"
# Repo is `whisper-vad` (publishes the Whisper-friendly ggml Silero port),
# not `silero-vad` (which only carries the upstream PyTorch JIT checkpoints).
readonly URL="https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin"

if [[ -s "${OUT_FILE}" ]]; then
	echo "Silero VAD model already present at ${OUT_FILE}; skipping download."
	exit 0
fi

mkdir -p "${OUT_DIR}"
echo "Downloading Silero VAD model → ${OUT_FILE}"
curl --fail --location --silent --show-error --output "${OUT_FILE}.partial" "${URL}"
mv "${OUT_FILE}.partial" "${OUT_FILE}"

echo "Done: $(du -h "${OUT_FILE}" | cut -f1) at ${OUT_FILE}"
