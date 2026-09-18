#!/usr/bin/env bash
# Builds the whisper.cpp-based `whisper-stt-server` helper and stages it (plus
# any ggml backend shared libraries) under
# `electron/native/bin/<os>-<arch>/`.
#
# The helper is a long-lived HTTP server that exposes the same
# spawn -> GET / -> POST /inference contract the previous native STT helper
# used, but links libwhisper directly and reads whisper.cpp's DTW token timestamps.
# See technical-documentation/architecture/transcription-and-captions.md
#
# Local use:
#   bash scripts/build-whisper-stt.sh         # default backend for host
#   bash scripts/build-whisper-stt.sh --clean # wipe build cache first
#
# The default backend per host:
#   macOS arm64  -> Metal
#   macOS x64    -> CPU
#   Windows x64  -> Vulkan
#   Linux x64    -> Vulkan

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly OUT_ROOT="${ROOT}/electron/native/bin"
readonly SRC_DIR="${ROOT}/electron/native/whisper-stt"

# On Windows the inner vulkan-shaders-gen sub-project hits MAX_PATH when the
# build tree is nested under the repo. Use a short root (overridable) on
# Windows; Unix hosts can keep the cached tree inside the repo.
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == CYGWIN* || "$(uname -s)" == MSYS* ]]; then
  BUILD_ROOT="${WHISPER_STT_BUILD_ROOT:-/c/wstbuild}"
else
  BUILD_ROOT="${WHISPER_STT_BUILD_ROOT:-${ROOT}/.cache/whisper-stt-build}"
fi
readonly BUILD_ROOT

CLEAN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=1; shift ;;
    -h|--help)
      cat <<-EOF
		Usage: $0 [--clean]
		Builds whisper-stt-server and stages it under
		\`electron/native/bin/<os>-<arch>/\`.

		--clean   Wipe the build cache before configuring.
		EOF
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

os_arch_tag() {
  local os_arch
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64)  os_arch="darwin-arm64" ;;
    Darwin:x86_64) os_arch="darwin-x64" ;;
    Linux:x86_64)  os_arch="linux-x64" ;;
    Linux:aarch64) os_arch="linux-arm64" ;;
    MINGW*|CYGWIN*|MSYS*)
      # `uname -m` cannot be trusted here. Git Bash is an x86_64 build, so on Windows
      # on ARM it runs emulated and reports x86_64 while the machine is arm64 — the
      # script would then build and stage an x64 helper on an ARM64 host without ever
      # saying so. Node is a native binary and reports the real architecture, and this
      # is a Node project, so it is always at hand. `uname -m` stays as the fallback.
      local arch
      arch="$(node -p 'process.arch' 2>/dev/null || true)"
      [[ -n "${arch}" ]] || arch="$(uname -m)"
      os_arch="win32-${arch/x86_64/x64}"
      ;;
    *) echo "Unsupported host: $(uname -s):$(uname -m)" >&2; exit 1 ;;
  esac
  echo "${os_arch}"
}

readonly OS_ARCH="$(os_arch_tag)"
readonly OUT_DIR="${OUT_ROOT}/${OS_ARCH}"

# Kept beside the other build constants so it is greppable next to the ffmpeg one in
# scripts/fetch-ffmpeg-macos.mjs; the two must agree, and both must match
# `mac.minimumSystemVersion` in electron-builder.json5.
readonly MACOS_DEPLOYMENT_TARGET="13.0"

# Determine the default backend flag for this host.
backend_flag_for_host() {
  case "${OS_ARCH}" in
    darwin-arm64) echo "-DOSC_ENABLE_METAL=ON" ;;
    darwin-x64)   echo "" ;;
    win32-x64|linux-x64|linux-arm64) echo "-DOSC_ENABLE_VULKAN=ON" ;;
    # Windows on ARM: CPU (ARM NEON), not Vulkan. ggml's Vulkan backend needs glslc
    # from the Vulkan SDK to compile its shaders, and requiring a ~1 GB SDK install
    # would make the arm64 helper unbuildable on a stock machine. Adreno itself is a
    # capable Vulkan target — the emulated x64 helper already runs inference on it —
    # so switching this to Vulkan is a worthwhile follow-up once the SDK is a declared
    # build prerequisite. Measure before assuming it wins: native NEON on 12 Oryon
    # cores against emulated code driving the GPU is not an obvious comparison.
    # `-DGGML_OPENMP=OFF` is not optional here. clang-cl links ggml against
    # `libomp140.aarch64.dll`, and the only copy of that file on a Visual Studio
    # install lives under `VC/Redist/.../debug_nonredist/` — a directory whose name
    # states the licence position: it may not be redistributed. Without OpenMP,
    # ggml uses its own thread pool and the helper needs no runtime we cannot ship.
    win32-arm64) echo "-DGGML_OPENMP=OFF" ;;
    *) echo "Unknown os-arch: ${OS_ARCH}" >&2; exit 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# macOS: make the staged tree relocatable.
#
# CMake links the helper and every ggml/whisper dylib against `@rpath/...` and
# then bakes a single absolute LC_RPATH pointing at its own build tree
# (`.cache/whisper-stt-build/build-<tag>-<variant>/bin`). That resolves on the
# machine that ran the build and nowhere else: delete the build cache, or
# download the CI artifact onto a different runner, and dyld cannot find
# libwhisper at all — the process aborts (SIGABRT, exit 134) before main().
#
# This is the macOS twin of the Windows 0xC0000135 incident that shipped in
# 1.8.0-rc.1..rc.3 (see the OpenSSL note in the CMakeLists). Swapping the
# absolute rpath for `@loader_path` makes each binary look for its siblings
# next to itself, which is exactly how the staged directory and the packaged
# `resources/electron/native/bin/<tag>/` are laid out.
#
# Editing a Mach-O header invalidates its code signature, and arm64 refuses to
# execute an unsigned-but-modified image ("killed: 9"), so each patched file is
# re-signed ad-hoc afterwards.
# ---------------------------------------------------------------------------
relocate_macos_rpaths() {
  local out_dir="$1"

  local f rp
  for f in "${out_dir}"/*; do
    # Symlinks share the payload of their target; patching the target is
    # enough, and codesign would follow the link and sign it twice.
    [[ -L "${f}" ]] && continue
    [[ -f "${f}" ]] || continue
    # Mach-O only: skips *.metal shader sidecars and anything else non-binary.
    file -b "${f}" | grep -q "Mach-O" || continue

    # Drop every *absolute* LC_RPATH. An absolute rpath in a shipped artifact
    # is always a build-machine path; relative ones (@loader_path,
    # @executable_path) are already correct and must survive.
    while read -r rp; do
      [[ "${rp}" == /* ]] || continue
      install_name_tool -delete_rpath "${rp}" "${f}" 2>/dev/null || true
    done < <(otool -l "${f}" | awk '/cmd LC_RPATH/{n=1;next} n&&/^ *path /{print $2;n=0}')

    # Idempotent: a second run would otherwise stack duplicate rpaths.
    if ! otool -l "${f}" | awk '/cmd LC_RPATH/{n=1;next} n&&/^ *path /{print $2;n=0}' |
      grep -qx "@loader_path"; then
      install_name_tool -add_rpath "@loader_path" "${f}"
    fi

    codesign --force --sign - --timestamp=none "${f}" 2>/dev/null ||
      echo "[whisper-stt] WARN: could not re-sign ${f##*/}" >&2
  done

  echo "[whisper-stt] rewrote macOS rpaths to @loader_path in ${out_dir}"
}

# Runs a command inside the MSVC environment for the host/target pair.
#
# Only Windows on ARM needs this. Everywhere else the Visual Studio generator sets the
# environment up itself, and Unix hosts have no such notion — so this is a no-op unless
# a vcvarsall is both needed and found, and a plain `"$@"` otherwise.
run_in_vs_env() {
  if [[ "${OS_ARCH}" != "win32-arm64" ]]; then
    "$@"
    return
  fi
  local vcvars
  vcvars="$(ls "/c/Program Files (x86)/Microsoft Visual Studio/2022"/*/VC/Auxiliary/Build/vcvarsall.bat 2>/dev/null | head -1)"
  if [[ -z "${vcvars}" ]]; then
    echo "[whisper-stt] WARN: vcvarsall.bat not found; building without an MSVC environment" >&2
    "$@"
    return
  fi
  # Host arch decides the vcvars argument: `arm64` when building natively on ARM64,
  # `amd64_arm64` when cross-compiling from an x64 host such as a CI runner.
  local host vcarg
  host="$(node -p 'process.arch' 2>/dev/null || echo x64)"
  if [[ "${host}" == "arm64" ]]; then vcarg="arm64"; else vcarg="amd64_arm64"; fi
  # A throwaway .cmd rather than nested quoting. `cmd //c "call \"...\" && ..."`
  # has to survive bash, MSYS path mangling and cmd in turn, and it did not: the
  # escaped quotes reached cmd verbatim and it reported the batch file "not found".
  # scripts/build-windows-compositor-addon.mjs solves it the same way.
  # Where the standalone LLVM lives. `command -v` first so a PATH install wins;
  # the default installer location is the fallback.
  local llvm_bin=""
  if command -v clang-cl >/dev/null 2>&1; then
    llvm_bin="$(dirname "$(command -v clang-cl)")"
  elif [[ -x "/c/Program Files/LLVM/bin/clang-cl.exe" ]]; then
    llvm_bin="/c/Program Files/LLVM/bin"
  fi
  local script
  script="$(mktemp -t whisper-vsenv-XXXXXX.cmd)"
  {
    echo "@echo off"
    printf 'call "%s" %s || exit /b 1
' "$(cygpath -w "${vcvars}")" "${vcarg}"
    # vcvarsall does not add a standalone LLVM to PATH, and CMake then fails to find
    # clang-cl at all. Prepend it so the compiler ggml demands for ARM is visible
    # without turning its absolute path (which contains spaces) into another quoting
    # problem inside the batch file.
    if [[ -n "${llvm_bin}" ]]; then
      printf 'set "PATH=%s;%%PATH%%"
' "$(cygpath -w "${llvm_bin}")"
    fi
    echo "$*"
  } > "${script}"
  local status=0
  cmd //c "$(cygpath -w "${script}")" || status=$?
  rm -f "${script}"
  return ${status}
}

build_variant() {
  local variant_name="$1"
  shift
  local extra_cmake_flags=("$@")

  local build_dir="${BUILD_ROOT}/build-${OS_ARCH}-${variant_name}"
  if [[ "${CLEAN}" -eq 1 ]]; then
    rm -rf "${build_dir}"
  fi
  mkdir -p "${build_dir}" "${OUT_DIR}"

  echo "[whisper-stt] configuring ${variant_name} in ${build_dir}"
  # ponytail: macOS's default /bin/bash is 3.2 (last GPLv2 release Apple ships),
  # where `"${arr[@]}"` on a genuinely empty array trips `set -u` ("unbound
  # variable") even though bash 4+ treats it as zero words. The
  # `${arr[@]+"${arr[@]}"}` idiom expands to nothing when the array is empty
  # and to the normal quoted expansion otherwise, on both bash versions.
  # Windows on ARM must be built with clang, not MSVC: ggmls CPU backend refuses
  # outright ("MSVC is not supported for ARM, use clang" in
  # ggml/src/ggml-cpu/CMakeLists.txt), because the NEON intrinsics it relies on are
  # absent from MSVCs ARM64 code generator. The Visual Studio generator can host the
  # LLVM toolset, so the target platform stays ARM64 and only the compiler changes.
  local toolchain_flags=()
  if [[ "${OS_ARCH}" == "win32-arm64" ]]; then
    # clang-cl from a standalone LLVM, driven by Ninja rather than the Visual Studio
    # generator. `-T ClangCL` would need the "C++ Clang tools for Windows" VS
    # component, which is a second ~1 GB LLVM next to the one the compositor addon
    # already requires for bindgen; Ninja lets both builds share one toolchain.
    # Ninja gets no MSVC environment of its own, so configure and build run inside
    # vcvarsall (see run_in_vs_env below) for the headers, libs and the linker.
    toolchain_flags+=(-G Ninja -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl)
  fi

  # Paths must be Windows-native for the arm64 path: cmake runs from inside a .cmd,
  # where Git Bash no longer rewrites `/c/...` for the native program it invokes, and
  # CMake reports the source directory as missing. Everywhere else the MSYS form is
  # what the surrounding tooling expects, so only this branch converts.
  local src_arg="${SRC_DIR}" build_arg="${build_dir}"
  if [[ "${OS_ARCH}" == "win32-arm64" ]]; then
    src_arg="$(cygpath -w "${SRC_DIR}")"
    build_arg="$(cygpath -w "${build_dir}")"
  fi

  run_in_vs_env cmake -S "${src_arg}" -B "${build_arg}" \
    -DCMAKE_BUILD_TYPE=Release \
    ${toolchain_flags[@]+"${toolchain_flags[@]}"} \
    ${extra_cmake_flags[@]+"${extra_cmake_flags[@]}"}

  echo "[whisper-stt] building ${variant_name}"
  # ponytail: macOS has no `nproc` (it is GNU coreutils), so this silently built
  # with -j4 on an 8-core Mac. `sysctl -n hw.ncpu` is the BSD equivalent.
  run_in_vs_env cmake --build "${build_arg}" --config Release \
    -j "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

  local bin_name="whisper-stt-server"
  if [[ "${OS_ARCH}" == win32-* ]]; then
    bin_name="${bin_name}.exe"
  fi

  # CMake generator-specific output locations: Ninja drops the binary at the
  # build root and libraries under bin/; MSBuild (Visual Studio on Windows)
  # puts Release/ configurations under ${build_dir}/Release/ and bin/Release/.
  local built_exe=""
  local search_dirs=()
  if [[ "${OS_ARCH}" == win32-* ]]; then
    for cand in "${build_dir}/Release/whisper-stt-server.exe" "${build_dir}/whisper-stt-server.exe"; do
      if [[ -f "${cand}" ]]; then built_exe="${cand}"; break; fi
    done
    search_dirs=("${build_dir}/bin/Release" "${build_dir}/bin" "${build_dir}/Release")
  else
    for cand in "${build_dir}/whisper-stt-server" "${build_dir}/Release/whisper-stt-server"; do
      if [[ -f "${cand}" ]]; then built_exe="${cand}"; break; fi
    done
    search_dirs=("${build_dir}/bin" "${build_dir}")
  fi
  if [[ -z "${built_exe}" ]]; then
    echo "FATAL: could not find whisper-stt-server binary in ${build_dir}" >&2
    exit 1
  fi
  cp "${built_exe}" "${OUT_DIR}/${bin_name}"

  # Stage any shared libraries / backend sidecars that CMake produced.
  # Copy everything that looks like a ggml/whisper shared library, plus any
  # .metal shader files (only produced when Metal is not embedded).
  #
  # ponytail: the pattern list used to be `ggml*.*|whisper.*|libwhisper.*`,
  # which only ever matched on Windows. CMake names shared libraries
  # `ggml-base.dll` on Windows but `libggml-base.dylib` / `libggml-base.so.0`
  # everywhere else, so on macOS and Linux every ggml sidecar was skipped and
  # only libwhisper was staged — leaving a helper that cannot resolve
  # @rpath/libggml.0.dylib and dies in dyld before main(). The `lib` prefix and
  # the `.so.<N>` version suffixes are what the globs below add.
  #
  # -P preserves the symlink farm (libggml.dylib -> libggml.0.dylib ->
  # libggml.0.15.1.dylib); plain `cp` dereferences each one into a full copy of
  # the same payload, which tripled the staged size for no benefit.
  local found_libs=0
  for lib_dir in "${search_dirs[@]}"; do
    if [[ -d "${lib_dir}" ]]; then
      for f in "${lib_dir}"/*; do
        # -f follows symlinks (true for both link and target); -L catches the
        # links themselves so the farm is staged intact.
        if [[ -f "${f}" || -L "${f}" ]]; then
          # Patterns, in order: Windows DLLs; macOS dylibs; Linux .so plus its
          # versioned forms (libggml-base.so.0, libggml-base.so.0.15.1); Metal
          # shader sidecars. A comment cannot be placed inside a `case` pattern
          # list — a `| \` continuation would swallow it as part of the pattern.
          case "${f##*/}" in
            ggml*.dll|whisper.dll|parakeet.dll|\
libggml*.dylib|libwhisper*.dylib|libparakeet*.dylib|\
libggml*.so|libggml*.so.*|libwhisper*.so|libwhisper*.so.*|\
libparakeet*.so|libparakeet*.so.*|\
*.metal)
              # The output directory may contain dereferenced regular files from a
              # downloaded release artifact. Remove the exact destination first so
              # cp can recreate this build's symlink farm without following an old
              # regular-file/symlink mix. -P preserves links without -a's macOS
              # chflags pass, which can itself report ELOOP while replacing a link.
              rm -f "${OUT_DIR}/${f##*/}"
              cp -P "${f}" "${OUT_DIR}/"
              found_libs=1
              ;;
          esac
        fi
      done
    fi
  done

  # Fail here rather than in the installer. `found_libs` was computed and then
  # never read, so a staging glob that matched nothing — which is precisely what
  # happened on macOS and Linux — still exited 0 and produced a green build.
  if [[ "${found_libs}" -eq 0 ]]; then
    echo "FATAL: staged no shared libraries alongside ${bin_name}." >&2
    echo "       Searched: ${search_dirs[*]}" >&2
    echo "       The helper links ggml/whisper as shared libraries; without them" >&2
    echo "       it cannot start. Check the sidecar glob in this script." >&2
    exit 1
  fi

  if [[ "${OS_ARCH}" == darwin-* ]]; then
    relocate_macos_rpaths "${OUT_DIR}"
  fi

  # Linux: stage GCC's OpenMP runtime beside what links it.
  #
  # Every binary staged above links libgomp.so.1, and nothing shipped it. The
  # deb/rpm/pacman declare it since 1.9.2, but the AppImage has no dependency
  # mechanism at all, so on a machine without it the whole STT stack dies in
  # ld.so before main() and transcription shows an end user a developer error.
  #
  # It belongs HERE rather than in stage-whisper-stt.sh, and that distinction is
  # the whole point: this script runs on the machine that COMPILES these
  # binaries, and build-whisper-stt.yml pins that to ubuntu-22.04, matching the
  # floor before-pack.cjs enforces. Copying it at packaging time instead took it
  # from whoever happened to run the build — and a 24.04 desktop's libgomp needs
  # GLIBC_2.38, so a developer there could no longer package at all. Staged here
  # it travels inside the whisper artifact, so every consumer gets the 22.04 copy
  # whatever their own distro is.
  #
  # libgomp is the only system library this stack may bundle. The AppImage
  # project's excludelist names the two it must not — libgbm.so.1 is "part of
  # mesa" and speaks to the host's DRM stack, libasound.so.2 loads the host's
  # ALSA plugins — and libgomp, a self-contained runtime, is absent from it.
  #
  # Resolved through the binary rather than a hardcoded /usr/lib path so arm64
  # needs no second case, and copied under its soname because that is the
  # DT_NEEDED the loader looks for; the file on disk is libgomp.so.1.0.0. No
  # patchelf is needed: these binaries already carry RUNPATH=$ORIGIN.
  if [[ "${OS_ARCH}" == linux-* ]]; then
    local gomp
    gomp="$(ldd "${OUT_DIR}/${bin_name}" 2>/dev/null | awk '/libgomp\.so\.1/ {print $3; exit}')"
    if [[ -z "${gomp}" || ! -f "${gomp}" ]]; then
      echo "FATAL: libgomp.so.1 is not resolvable for ${bin_name}." >&2
      echo "       Install it (libgomp1 on Debian/Ubuntu, libgomp on Fedora/Arch)." >&2
      echo "       Without it the AppImage ships an STT stack that cannot load," >&2
      echo "       which is silent until a user tries to transcribe." >&2
      exit 1
    fi
    # Already ours: ldd resolved it through $ORIGIN on a re-run of this script.
    if [[ "$(cd "$(dirname "${gomp}")" && pwd)" != "$(cd "${OUT_DIR}" && pwd)" ]]; then
      cp -v "${gomp}" "${OUT_DIR}/libgomp.so.1"
    fi
  fi

  echo "[whisper-stt] built ${variant_name} -> ${OUT_DIR}/${bin_name}"
  ls -la "${OUT_DIR}"
}

# ---------------------------------------------------------------------------
# The one build: Metal/Vulkan/CPU depending on host.
# ---------------------------------------------------------------------------
DEFAULT_FLAG="$(backend_flag_for_host)"
BUILD_FLAGS=()
if [[ -n "${DEFAULT_FLAG}" ]]; then
  BUILD_FLAGS+=("${DEFAULT_FLAG}")
fi
# Pin the macOS floor the app actually ships against (`mac.minimumSystemVersion` in
# electron-builder.json5). Without it CMake
# defaults the deployment target to the BUILD MACHINE's SDK, so whisper-stt-server and
# the libwhisper/libggml*/libparakeet dylibs inherit whatever macOS built them —
# measured 26.0 on the shipped v1.10.0 payload, and ~15.x from CI's `macos-latest`,
# a floor that moves on its own whenever GitHub rolls that image.
#
# This is the macOS twin of the ubuntu-22.04 pin in build-whisper-stt.yml: same defect
# (a shipped binary's floor decided by the runner rather than by the project), different
# libc. Note it is NOT a loader version gate — dyld does not refuse a binary whose minos
# exceeds the running OS. Setting it is what makes the linker enforce macOS 12 symbol
# availability, which is what actually fails at load time. See issue #515.
if [[ "${OS_ARCH}" == darwin-* ]]; then
  BUILD_FLAGS+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS_DEPLOYMENT_TARGET}")
fi
# See the comment in build_variant() re: bash 3.2 + `set -u` + empty arrays
# (macOS x64/CPU has no DEFAULT_FLAG, so BUILD_FLAGS is genuinely empty here).
build_variant "default" ${BUILD_FLAGS[@]+"${BUILD_FLAGS[@]}"}

echo "[whisper-stt] done. Binaries under: ${OUT_DIR}"
