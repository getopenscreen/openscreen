#!/usr/bin/env bash
# Builds the six platform-arch variants of `whisper-server` (Apple Silicon
# Metal, NVIDIA CUDA, Vulkan, and CPU) and stages them under
# `electron/native/bin/<os>-<arch>/`.
#
# This is intentionally a separate script (not `build.yml` itself) because
# whisper.cpp CMake builds can take 20–40 minutes per variant on CI; the
#   shipped binaries are uploaded as artifacts of a dedicated workflow
#   `.github/workflows/build-whisper-binaries.yml` and consumed by
#   `build.yml` on tagged releases.
#
# Local use:
#   bash scripts/build-whisper-binaries.sh                # all variants on this host
#   bash scripts/build-whisper-binaries.sh --cpu-only     # cheap local smoke test
#   WHISPER_CPP_REPO=v1.9.1 bash scripts/build-whisper-binaries.sh --metal
#
# The pod5 ponytail constraint: skip the matrix when the host can't possibly
# produce a variant (e.g. CUDA build on a Mac) — exit 0 instead of failing CI.

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly WHISPER_CPP_REPO="${WHISPER_CPP_REPO:-https://github.com/ggerganov/whisper.cpp.git}"
readonly WHISPER_CPP_REF="${WHISPER_CPP_REF:-v1.9.1}"
readonly BUILD_ROOT="${ROOT}/.cache/whisper-build"
readonly OUT_ROOT="${ROOT}/electron/native/bin"

CPU_ONLY=0
VARIANTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cpu-only) CPU_ONLY=1; shift ;;
    --metal) VARIANTS+=("metal"); shift ;;
    --cuda) VARIANTS+=("cuda"); shift ;;
    --vulkan) VARIANTS+=("vulkan"); shift ;;
    --cpu) VARIANTS+=("cpu"); shift ;;
    -h|--help)
      cat <<-EOF
		Usage: $0 [--cpu-only | --metal --cuda --vulkan --cpu]
		Builds whisper-server variants and stages them under \`electron/native/bin/<os>-<arch>/\`.

		Without arguments, picks variants enabled by the host's toolchain.
		EOF
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ "${#VARIANTS[@]}" -eq 0 && "${CPU_ONLY}" -eq 0 ]]; then
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64|Darwin:x86_64) VARIANTS+=(metal cpu) ;;
    Linux:x86_64|Linux:aarch64)
      if command -v nvcc >/dev/null 2>&1; then VARIANTS+=(cuda); fi
      if command -v vulkaninfo >/dev/null 2>&1; then VARIANTS+=(vulkan); fi
      VARIANTS+=(cpu)
      ;;
    MINGW*|CYGWIN*|MSYS*)
      VARIANTS+=(cpu)  # CUDA/Vulkan staged only when self-hosted GPU runners exist.
      ;;
    *) VARIANTS+=(cpu) ;;
  esac
fi

if [[ "${CPU_ONLY}" -eq 1 ]]; then
  VARIANTS=(cpu)
fi

echo "Variants to build: ${VARIANTS[*]:-none}"

if [[ "${#VARIANTS[@]}" -eq 0 ]]; then
  echo "No variants selected; nothing to do."
  exit 0
fi

fetch_sources() {
  if [[ -d "${BUILD_ROOT}/whisper.cpp" ]]; then
    echo "Reusing cached source at ${BUILD_ROOT}/whisper.cpp"
    return
  fi
  echo "Cloning whisper.cpp @ ${WHISPER_CPP_REF}"
  git clone --depth 1 --branch "${WHISPER_CPP_REF}" "${WHISPER_CPP_REPO}" "${BUILD_ROOT}/whisper.cpp"
}

# Single-variant build helper. Args: <variant> <cmake-presets…>
build_variant() {
  local variant="$1"
  shift
  local cmake_flags=("$@")
  local out_dir="${OUT_ROOT}/$(os_arch_tag)/whisper-server-${variant}"
  mkdir -p "${out_dir%/*}"
  local build_dir="${BUILD_ROOT}/build-${variant}"
  rm -rf "${build_dir}"
  cmake -S "${BUILD_ROOT}/whisper.cpp" -B "${build_dir}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DWHISPER_BUILD_SERVER=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_EXAMPLES=OFF \
    "${cmake_flags[@]}"
  cmake --build "${build_dir}" --config Release -j "$(nproc 2>/dev/null || echo 4)"
  cp "${build_dir}/bin/whisper-server" "${out_dir}/whisper-server-${variant}"
  echo "Built ${variant} → ${out_dir}/whisper-server-${variant}"
}

os_arch_tag() {
  local os_arch
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64) os_arch="darwin-arm64" ;;
    Darwin:x86_64) os_arch="darwin-x64" ;;
    Linux:x86_64) os_arch="linux-x64" ;;
    Linux:aarch64) os_arch="linux-arm64" ;;
    MINGW*|CYGWIN*|MSYS*)
      local arch
      arch="$(uname -m)"
      os_arch="win32-${arch/x86_64/x64}"
      ;;
    *) echo "Unsupported host: $(uname -s):$(uname -m)" >&2; exit 1 ;;
  esac
  echo "${os_arch}"
}

fetch_sources
for variant in "${VARIANTS[@]}"; do
  case "${variant}" in
    metal)
      if [[ "$(uname -s)" != "Darwin" ]]; then
        echo "Skipping metal: requires macOS host"
        continue
      fi
      build_variant metal \
        -DWHISPER_METAL=ON \
        -DWHISPER_COREML=ON
      ;;
    cuda)
      if ! command -v nvcc >/dev/null 2>&1; then
        echo "Skipping cuda: nvcc not on PATH"
        continue
      fi
      build_variant cuda \
        -DWHISPER_CUDA=ON \
        -DCMAKE_CUDA_ARCHITECTURES="50;52;60;61;70;75;80;86;89;90"
      ;;
    vulkan)
      if ! command -v vulkaninfo >/dev/null 2>&1; then
        echo "Skipping vulkan: vulkaninfo not on PATH"
        continue
      fi
      build_variant vulkan \
        -DWHISPER_VULKAN=ON
      ;;
    cpu)
      build_variant cpu
      ;;
    *)
      echo "Unknown variant: ${variant}" >&2
      exit 2
      ;;
  esac
done

echo "Done. Binaries under: ${OUT_ROOT}/$(os_arch_tag)/"
