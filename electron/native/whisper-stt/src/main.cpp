// whisper-stt-server: long-lived HTTP helper for OpenScreen's STT pipeline.
//
// Wires the POC's transcription core (tools/stt-eval/whispercpp-dtw-poc/harness/wcpp_dtw_bench.cpp)
// into an httplib-shaped loop, so the Electron main process can keep the same
// spawn → poll / → POST /inference → verbose_json shape that the previous
// native STT helper provided. whisper.cpp's `whisper_full`
// already does mel featurization, tokenization, decoding, AND long-form (>30 s)
// chunking internally — the helper is ~400 lines because none of that is our
// problem any more.
//
// Wire contract (Node side: electron/stt/whisperServer.ts):
//   POST /inference    multipart/form-data, fields:
//                       - file           (WAV: 16 kHz mono PCM16)
//                       - language       ("en" | "fr" | ... | "auto")
//                       - prompt         (optional: names and terms to bias the
//                                         decode toward, issue #1023)
//                       - response_format ("verbose_json" — accepted for compat
//                                          with the previous CT2 client)
//   GET  /             200 "ok" once the model is loaded — readiness probe.
//
// Response shape (verbose_json, preserved from the previous helper contract):
//   {
//     "language":          "en",
//     "detected_language": "en",
//     "backend":           "whispercpp-vulkan" | "whispercpp-cpu" | ...,
//     "timing":            { "elapsed_s": <>, "audio_s": <>, "rtf": <> },
//     "segments": [
//       { "id": 0, "text": "...",
//         "start": 0.0, "end": 11.0,
//         "words": [ { "word": "...", "start": 0.5, "end": 0.9, "probability": 0.9 }, ... ]
//       }, ...
//     ],
//     "speech": [ { "start": 0.4, "end": 2.1 }, ... ]   // only when the VAD model loaded
//   }
//
// Concurrency: whisper contexts are not thread-safe. /inference is serialized
// behind a single mutex (the Node side already has a single-flight queue, so
// this is a belt-and-braces guarantee against a future bug or parallel invoker).

#include "whisper.h"
#include "ctc_aligner.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <ggml.h>

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#endif

namespace {

void log(const std::string& msg) {
	std::cerr << "[whisper-stt] " << msg << std::endl;
	std::cerr.flush();
}

// whisper.cpp and ggml read every path as UTF-8, but Windows hands a console
// program its argv and getenv() in the ANSI code page: a model under a
// non-ASCII profile folder aborted the boot (issue #1405). On Windows the arguments and
// the environment are read wide and converted, elsewhere they already are UTF-8.
#ifdef _WIN32
std::string utf8(const wchar_t* w) {
	const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
	if (n <= 1) return {};
	std::string s(static_cast<size_t>(n - 1), '\0');
	WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
	return s;
}
#endif

std::vector<std::string> utf8_args(int argc, char** argv) {
#ifdef _WIN32
	int wargc = 0;
	if (wchar_t** wargv = CommandLineToArgvW(GetCommandLineW(), &wargc)) {
		std::vector<std::string> args;
		for (int i = 0; i < wargc; ++i) args.push_back(utf8(wargv[i]));
		LocalFree(wargv);
		return args;
	}
#endif
	return {argv, argv + argc};
}

std::optional<std::string> utf8_env(const char* name) {
#ifdef _WIN32
	const std::wstring wname(name, name + std::strlen(name));
	if (const wchar_t* p = _wgetenv(wname.c_str())) return utf8(p);
#else
	if (const char* p = std::getenv(name)) return p;
#endif
	return std::nullopt;
}

std::string json_escape(const std::string& s) {
	std::string out;
	out.reserve(s.size() + 8);
	for (unsigned char c : s) {
		switch (c) {
			case '"':  out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\n': out += "\\n";  break;
			case '\r': out += "\\r";  break;
			case '\t': out += "\\t";  break;
			default:
				if (c < 0x20) {
					char buf[8];
					std::snprintf(buf, sizeof(buf), "\\u%04x", c);
					out += buf;
				} else {
					out += static_cast<char>(c);
				}
		}
	}
	return out;
}

// Minimal WAV reader: PCM16, any channel count, any sample rate. Fixtures
// (and the renderer's writeSamplesAsWav) are guaranteed PCM16 mono 16 kHz.
// ponytail: v1.9.1 of whisper.cpp dropped `examples/dr_wav.h` in favour of
// miniaudio, but pulling in the full miniaudio.h (4 MB header) just to read
// a 16 kHz mono PCM16 stream would be silly. The format is dead simple; this
// parser is the same one the POC harness shipped.
bool read_wav_pcm16(const std::filesystem::path& path, std::vector<float>& pcm,
                    int& sample_rate_out, int& channels_out) {
	std::ifstream f(path, std::ios::binary);
	if (!f) { log("cannot open " + path.filename().string()); return false; }

	auto read_u32 = [&]()-> uint32_t {
		uint32_t v = 0; f.read(reinterpret_cast<char*>(&v), 4); return v;
	};
	auto read_u16 = [&]()-> uint16_t {
		uint16_t v = 0; f.read(reinterpret_cast<char*>(&v), 2); return v;
	};
	auto read_i16 = [&]()-> int16_t {
		int16_t v = 0; f.read(reinterpret_cast<char*>(&v), 2); return v;
	};

	char tag[4];
	f.read(tag, 4);
	if (f.gcount() != 4 || std::memcmp(tag, "RIFF", 4) != 0) { log("not RIFF"); return false; }
	(void)read_u32();
	f.read(tag, 4);
	if (std::memcmp(tag, "WAVE", 4) != 0) { log("not WAVE"); return false; }

	uint16_t fmt_format = 0, fmt_channels = 0, fmt_bits = 0;
	uint32_t fmt_sample_rate = 0;
	bool got_fmt = false;

	while (f) {
		char chunk_tag[4];
		f.read(chunk_tag, 4);
		if (f.gcount() != 4) break;
		const uint32_t chunk_size = read_u32();
		if (std::memcmp(chunk_tag, "fmt ", 4) == 0) {
			if (chunk_size < 16) {
				log("invalid fmt chunk size: " + std::to_string(chunk_size));
				return false;
			}
			fmt_format      = read_u16();
			fmt_channels    = read_u16();
			if (fmt_channels == 0) {
				log("invalid fmt_channels: 0");
				return false;
			}
			fmt_sample_rate = read_u32();
			(void)read_u32();
			(void)read_u16();
			fmt_bits        = read_u16();
			const uint32_t fmt_extra = chunk_size - 16;
			if (fmt_extra) f.seekg(fmt_extra, std::ios::cur);
			got_fmt = true;
		} else if (std::memcmp(chunk_tag, "data", 4) == 0) {
			if (!got_fmt || fmt_format != 1 || fmt_bits != 16 || fmt_channels == 0) {
				log("expected PCM16, got format=" + std::to_string(fmt_format) +
				    " bits=" + std::to_string(fmt_bits) +
				    " channels=" + std::to_string(fmt_channels));
				return false;
			}
			sample_rate_out = static_cast<int>(fmt_sample_rate);
			channels_out    = fmt_channels;
			const size_t frames = chunk_size / 2 / fmt_channels;
			pcm.resize(frames);
			if (fmt_channels == 1) {
				for (size_t i = 0; i < frames; ++i) pcm[i] = static_cast<float>(read_i16()) / 32768.0f;
			} else {
				std::vector<int> count(frames, 0);
				for (size_t ch = 0; ch < fmt_channels; ++ch) {
					for (size_t i = 0; i < frames; ++i) {
						pcm[i] += static_cast<float>(read_i16()) / 32768.0f;
						++count[i];
					}
				}
				for (size_t i = 0; i < frames; ++i) pcm[i] /= count[i];
			}
			return true;
		} else {
			f.seekg(chunk_size + (chunk_size & 1), std::ios::cur);
		}
	}
	log("data chunk not found in " + path.filename().string());
	return false;
}

// Write the runtime-detected ggml device name to a stable string the JSON
// response can use. Order: enumerate registered devices and pick the first
// non-CPU one if any exists (CPU is always last in ggml's priority order).
// Falls back to "cpu" when nothing else is registered, which is also what
// ggml does on its own.
std::string detect_active_backend() {
	const size_t n = ggml_backend_dev_count();
	for (size_t i = 0; i < n; ++i) {
		ggml_backend_dev_t dev = ggml_backend_dev_get(i);
		if (!dev) continue;
		// Only compute devices are candidates. This drops ggml-cpu (type CPU)
		// and ggml-blas (type ACCEL — Accelerate on macOS), neither of which is
		// the GPU offload this field is meant to report. IGPU is accepted
		// because that is how an integrated adapter enumerates.
		// `auto`: ggml_backend_dev_type names both a C enum and the accessor
		// function, so spelling the type out needs the `enum` tag to disambiguate.
		const auto type = ggml_backend_dev_type(dev);
		if (type != GGML_BACKEND_DEVICE_TYPE_GPU && type != GGML_BACKEND_DEVICE_TYPE_IGPU) {
			continue;
		}
		const char* name = ggml_backend_dev_name(dev);
		if (!name) continue;
		std::string s = name;
		// These are ggml *device* names, which carry a device index:
		// "Vulkan0", "CUDA0", "MTL0". Matching the bare backend title is why
		// Metal never matched — ggml-metal's device name is built from
		// GGML_METAL_NAME ("MTL"), and the string "Metal" appears nowhere in
		// it, so every Apple Silicon run reported `whispercpp-cpu` while the
		// Metal backend was in fact bound. `backend` is documented as the
		// source of truth for which device ran, so this was the one number a
		// consumer could not get right on macOS.
		if (s.find("Vulkan")  != std::string::npos) return "whispercpp-vulkan";
		if (s.find("CUDA")    != std::string::npos) return "whispercpp-cuda";
		if (s.find("MTL")     != std::string::npos) return "whispercpp-metal";
		if (s.find("Metal")   != std::string::npos) return "whispercpp-metal";
	}
	// Last resort: the CPU device, or a hard "cpu" if ggml has nothing
	// registered (shouldn't happen — whisper.cpp's loader registers at
	// least ggml-cpu on every platform).
	if (n > 0 && ggml_backend_dev_get(0)) {
		const char* name = ggml_backend_dev_name(ggml_backend_dev_get(0));
		if (name && *name) return "whispercpp-cpu";
	}
	return "whispercpp-cpu";
}

struct Word {
	double start  = 0.0;
	double end    = 0.0;
	// t_dtw of the word's first token: the end of that token, so always inside
	// the word. Only used to tell which stretch of speech a word belongs to.
	double anchor = 0.0;
	double prob   = 0.0;
	std::string text;
};

// One stretch of speech copied from the upload into the buffer whisper decodes.
struct Kept {
	int64_t at;    // first sample in that buffer
	int64_t from;  // first sample in the upload
	int64_t len;
};

// A whisper time (centiseconds on the speech-only buffer) back on the upload's
// clock, in seconds. Inside a kept stretch it moves with the stretch; in the
// silence inserted between two stretches it snaps to the nearer edge, so a
// word can never land in audio that was cut out. No stretches: VAD was off.
double to_original_sec(int64_t cs, const std::vector<Kept>& kept) {
	if (kept.empty()) return cs / 100.0;
	const int64_t x = cs * 160;  // 16 kHz: 160 samples per centisecond
	for (size_t i = 0; i < kept.size(); ++i) {
		const Kept& k = kept[i];
		if (x < k.at) {
			if (i == 0) return k.from / 16000.0;
			const Kept& p = kept[i - 1];
			const bool nearer_prev = x - (p.at + p.len) <= k.at - x;
			return (nearer_prev ? p.from + p.len : k.from) / 16000.0;
		}
		if (x < k.at + k.len) return (k.from + x - k.at) / 16000.0;
	}
	return (kept.back().from + kept.back().len) / 16000.0;
}

std::string base64(const void* data, size_t n) {
	static const char* abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const auto* p = static_cast<const unsigned char*>(data);
	std::string out;
	out.reserve((n + 2) / 3 * 4);
	for (size_t i = 0; i < n; i += 3) {
		const uint32_t v = (p[i] << 16) | (i + 1 < n ? p[i + 1] << 8 : 0) | (i + 2 < n ? p[i + 2] : 0);
		out += abc[(v >> 18) & 63];
		out += abc[(v >> 12) & 63];
		out += i + 1 < n ? abc[(v >> 6) & 63] : '=';
		out += i + 2 < n ? abc[v & 63] : '=';
	}
	return out;
}

} // namespace

int main(int argc, char** argv) {
	std::string model_path;
	std::string vad_model_path;
	std::string host = "127.0.0.1";
	bool host_from_flag = false;
	bool force_cpu = false;
	int port = 0;
	int threads = std::max(1u, std::thread::hardware_concurrency());

	const std::vector<std::string> args = utf8_args(argc, argv);
	const size_t n_args = args.size();
	for (size_t i = 1; i < n_args; ++i) {
		const std::string& a = args[i];
		if (a == "--model"   && i + 1 < n_args) model_path = args[++i];
		else if (a == "--vad-model" && i + 1 < n_args) vad_model_path = args[++i];
		else if (a == "--host" && i + 1 < n_args) { host = args[++i]; host_from_flag = true; }
		else if (a == "--port" && i + 1 < n_args) port = std::atoi(args[++i].c_str());
		else if (a == "--threads" && i + 1 < n_args) threads = std::atoi(args[++i].c_str());
		else if (a == "--cpu") force_cpu = true;
	}
	// ponytail: prefer env var (matches the prior native STT model env var
	// shape; the Node wrapper passes both ways).
	if (model_path.empty()) {
		if (auto p = utf8_env("OPENSCREEN_WHISPER_MODEL")) model_path = *p;
	}
	if (vad_model_path.empty()) {
		if (auto p = utf8_env("OPENSCREEN_VAD_MODEL")) vad_model_path = *p;
		else if (auto q = utf8_env("OPENSCREEN_WHISPER_VAD_MODEL")) vad_model_path = *q;
	}
	if (port == 0) {
		if (auto p = utf8_env("OPENSCREEN_WHISPER_PORT")) port = std::atoi(p->c_str());
	}
	if (auto p = utf8_env("OPENSCREEN_WHISPER_THREADS")) threads = std::atoi(p->c_str());
	// Only a fallback, never an override: the app always passes --host 127.0.0.1,
	// and an env var that can widen a shipped binary's bind address behind an
	// explicit flag is a hole, not a knob. Anything but loopback is refused
	// outright — this server has no authentication of any kind.
	if (!host_from_flag) {
		if (auto p = utf8_env("OPENSCREEN_WHISPER_HOST")) host = *p;
	}
	if (host != "127.0.0.1" && host != "::1" && host != "localhost") {
		std::cerr << "FATAL: refusing to bind " << host
		          << " — whisper-stt-server is unauthenticated and loopback-only"
		          << std::endl;
		return 2;
	}

	if (model_path.empty()) {
		std::cerr << "FATAL: --model <path-to-ggml.bin> or "
		             "OPENSCREEN_WHISPER_MODEL is required" << std::endl;
		return 2;
	}
	log("boot: model=" + model_path +
	    (!vad_model_path.empty() ? (" vad_model=" + vad_model_path) : "") +
	    " host=" + host +
	    " port=" + (port > 0 ? std::to_string(port) : "(any)") +
	    " threads=" + std::to_string(threads));

	// ---- Init whisper context with DTW alignment (POC §4.1) ----
	whisper_context_params cparams = whisper_context_default_params();
	cparams.use_gpu    = !force_cpu; // Parent retries with --cpu if a GPU backend aborts.
	cparams.flash_attn = false;  // CRITICAL: DTW is silently disabled by v1.9.1
	                             // if flash_attn is true; the guardrail in the
	                             // /inference handler still runs, but skipping
	                             // the request is wasted work.
	cparams.dtw_token_timestamps = true;
	cparams.dtw_aheads_preset    = WHISPER_AHEADS_SMALL;
	whisper_context* ctx = whisper_init_from_file_with_params(model_path.c_str(), cparams);
	if (!ctx && cparams.use_gpu) {
		// Metal/Vulkan allocation can fail transiently when the editor or another
		// creative app is already using most GPU memory. Captions should degrade to
		// a slower CPU run instead of leaving the HTTP readiness probe to time out.
		log("GPU model initialization failed; retrying with CPU inference");
		cparams.use_gpu = false;
		ctx = whisper_init_from_file_with_params(model_path.c_str(), cparams);
	}
	if (!ctx) {
		log("whisper_init_from_file_with_params failed for " + model_path);
		return 3;
	}
	const std::string active_backend = cparams.use_gpu ? detect_active_backend() : "whispercpp-cpu";
	log("model loaded; backend=" + active_backend);

	// ---- Init VAD context (Silero VAD v6.2.0) ----
	// On the CPU, always. Asked for the GPU on Vulkan, whisper.cpp 1.9.1 puts the
	// VAD weights in a Vulkan buffer, then finds no GPU for the VAD's own backend
	// and aborts inside ggml (0xC0000409) — so the app relaunched the helper with
	// --cpu and every transcription lost its GPU. Silero is 0.9 MB: the CPU is
	// not where the time goes.
	struct whisper_vad_context* vctx = nullptr;
	if (!vad_model_path.empty()) {
		struct whisper_vad_context_params vad_ctx_params = whisper_vad_default_context_params();
		vad_ctx_params.n_threads = threads;
		vad_ctx_params.use_gpu   = false;
		vctx = whisper_vad_init_from_file_with_params(vad_model_path.c_str(), vad_ctx_params);
		if (vctx) {
			log("VAD model loaded; path=" + vad_model_path);
		} else {
			log("WARNING: failed to load VAD model from " + vad_model_path);
		}
	}

	// ---- HTTP server ----
	httplib::Server svr;
	std::mutex infer_mu;  // whisper contexts are not thread-safe

	// GET / — readiness probe. The Node wrapper polls this until 200 to know
	// the model is loaded and the GPU is bound (a Vulkan/D3D driver bug can
	// make whisper_init succeed but the first /inference still segfault).
	svr.Get("/", [&](const httplib::Request&, httplib::Response& res) {
		nlohmann::json probe = {
			{"status", "ok"},
			{"vad",    vctx != nullptr}
		};
		res.set_content(probe.dump(), "application/json");
	});

	// The upload of /inference and /emissions: a 16 kHz mono PCM16 WAV in the
	// multipart field `file`. False after answering 400.
	const auto read_upload = [](const httplib::Request& req, httplib::Response& res,
	                            std::vector<float>& pcm) -> bool {
		auto it = req.files.find("file");
		if (it == req.files.end()) {
			res.status = 400;
			res.set_content(R"({"error":"missing 'file' form field"})", "application/json");
			return false;
		}
		const auto& file_entry = it->second;

		// Write the upload to a temp file because read_wav_pcm16 takes a path.
		// whisper.cpp needs float PCM in memory; parsing the multipart bytes
		// directly would just duplicate the WAV reader. tmpfile() is fine —
		// /inference is single-flight, so concurrent temp files aren't a risk.
		// Portable unique-ish name: no PID API (GetCurrentProcessId is
		// Windows-only) — a monotonic counter plus a high-res clock reading
		// is enough to avoid collisions on one host.
		static std::atomic<uint64_t> tmp_wav_counter{0};
		const auto tmp_wav_id = tmp_wav_counter.fetch_add(1, std::memory_order_relaxed);
		const auto tmp_wav_ts = std::chrono::high_resolution_clock::now().time_since_epoch().count();
		// Kept a path, not .string(): that converts to the ANSI code page and
		// throws on a temp folder under a non-ASCII profile (issue #1405).
		const std::filesystem::path tmp_wav = std::filesystem::temp_directory_path() /
		                                      ("openscreen-stt-" + std::to_string(tmp_wav_ts) +
		                                       "-" + std::to_string(tmp_wav_id) + ".wav");
		{
			std::ofstream out(tmp_wav, std::ios::binary);
			out.write(file_entry.content.data(),
			          static_cast<std::streamsize>(file_entry.content.size()));
		}
		int sample_rate = 0, channels = 0;
		const bool ok = read_wav_pcm16(tmp_wav, pcm, sample_rate, channels);
		std::error_code ec;
		std::filesystem::remove(tmp_wav, ec);
		if (!ok) {
			res.status = 400;
			res.set_content(R"({"error":"failed to parse WAV"})", "application/json");
			return false;
		}
		if (sample_rate != 16000 || channels != 1) {
			res.status = 400;
			res.set_content(
				R"({"error":"expected 16 kHz mono PCM16 WAV"})",
				"application/json");
			return false;
		}
		return true;
	};

	// POST /inference — multipart form with `file` (WAV) + `language` + `response_format`.
	svr.Post("/inference", [&](const httplib::Request& req, httplib::Response& res) {
		std::vector<float> pcm;
		if (!read_upload(req, res, pcm)) return;

		// language param
		std::string language = "auto";
		if (auto p = req.get_file_value("language"); !p.content.empty()) language = p.content;
		else if (auto kv = req.params.find("language"); kv != req.params.end()) language = kv->second;
		// "auto" → empty string tells whisper.cpp to detect; matches the
		// Node contract (electron/stt/whisperServer.ts) and OpenAI convention.
		// The project's names and terms (issue #1023). Empty = no prompt.
		const std::string prompt = req.get_file_value("prompt").content;

		const std::lock_guard<std::mutex> lk(infer_mu);

		whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
		wparams.token_timestamps = true;
		wparams.language         = language.empty() ? "auto" : language.c_str();
		wparams.print_progress   = false;
		wparams.print_realtime   = false;
		wparams.print_timestamps = false;
		wparams.n_threads        = threads;
		// Carried into every 30 s window whisper_full decodes, not only the first:
		// a name said at minute 3 is as likely to be misheard as one said at 0:05.
		// whisper.cpp keeps the last n_text_ctx/2 tokens of an over-long prompt.
		if (!prompt.empty()) {
			wparams.initial_prompt       = prompt.c_str();
			wparams.carry_initial_prompt = true;
		}

		// ---- Speech only (Silero VAD), cut here rather than by whisper_full ----
		// whisper_full's own `vad` param maps SEGMENT times back onto the upload
		// but not token times, so every word (t_dtw included) came back early by
		// all the silence removed before it: 13 s into a 25 s clip. Cutting here
		// keeps the map. The stretches also go out as `speech`, which the Node
		// side anchors phrase edges on.
		const auto t0 = std::chrono::steady_clock::now();  // VAD time is part of the run
		std::vector<float> speech;
		std::vector<Kept> kept;
		nlohmann::json speech_json = nlohmann::json::array();
		if (vctx) {
			whisper_vad_segments* vs = whisper_vad_segments_from_samples(
				vctx, whisper_vad_default_params(), pcm.data(), static_cast<int>(pcm.size()));
			if (!vs) {
				res.status = 500;
				res.set_content(R"({"error":"VAD failed"})", "application/json");
				return;
			}
			const int64_t n_pcm = static_cast<int64_t>(pcm.size());
			const auto to_sample = [&](float cs) {
				return std::clamp<int64_t>(std::llround(cs * 160.0), 0, n_pcm);
			};
			const int n_vs = whisper_vad_segments_n_segments(vs);
			for (int i = 0; i < n_vs; ++i) {
				const int64_t from = to_sample(whisper_vad_segments_get_segment_t0(vs, i));
				const int64_t end  = to_sample(whisper_vad_segments_get_segment_t1(vs, i));
				if (end <= from) continue;
				speech_json.push_back({{"start", from / 16000.0}, {"end", end / 16000.0}});
				// As whisper.cpp does: 0.1 s past the detected end so a soft ending
				// survives, and 0.1 s of silence between stretches. Unlike it, the
				// tail never runs into the next stretch and decodes it twice.
				const int64_t next = i + 1 < n_vs
					? to_sample(whisper_vad_segments_get_segment_t0(vs, i + 1))
					: n_pcm;
				const int64_t to = std::max(end, std::min(end + 1600, next));
				if (!kept.empty()) speech.insert(speech.end(), 1600, 0.0f);
				kept.push_back({static_cast<int64_t>(speech.size()), from, to - from});
				speech.insert(speech.end(), pcm.begin() + from, pcm.begin() + to);
			}
			whisper_vad_free_segments(vs);
		}
		// VAD on and no speech found: nothing to decode, so nothing to report.
		const std::vector<float>& input = vctx ? speech : pcm;

		const int rc  = input.empty() ? 0 : whisper_full(ctx, wparams, input.data(), static_cast<int>(input.size()));
		const auto t1 = std::chrono::steady_clock::now();
		if (rc != 0) {
			log("whisper_full returned " + std::to_string(rc));
			res.status = 500;
			res.set_content(
				std::string(R"({"error":"whisper_full failed: rc=)") + std::to_string(rc) + R"("})",
				"application/json");
			return;
		}
		const double elapsed_s = std::chrono::duration<double>(t1 - t0).count();
		const double audio_s   = pcm.size() / 16000.0;
		const double rtf       = audio_s > 0 ? elapsed_s / audio_s : 0.0;

		const int n_vocab = whisper_n_vocab(ctx);
		const whisper_token eot = whisper_token_eot(ctx);
		std::vector<std::string> vocab_strs(n_vocab);
		for (int i = 0; i < n_vocab; ++i) vocab_strs[i] = whisper_token_to_str(ctx, i);

		// ---- §4.1 guardrail (POC-validated): DTW must be active ----
		// Mirrors the POC's harness check; if any non-special token has
		// t_dtw == -1, or the abs-delta sum is zero (= DTW identical to the
		// heuristic, the 2024 failure mode), reject with 500.
		bool   dtw_guard_pass      = true;
		std::string guardrail_msg;
		int64_t dtw_abs_delta_sum  = 0;
		int64_t prev_t_dtw         = 0;
		int    non_special_tokens  = 0;

		// ---- Walk segments → tokens → words (POC §1.4 mapping) ----
		struct Segment {
			double start = 0.0, end = 0.0;
			std::string text;
			std::vector<Word> words;
		};
		std::vector<Segment> segments;

		// whisper.cpp writes a token's t_dtw when the DTW path enters the decoder
		// row that PREDICTS the next token (whisper_exp_compute_token_level_
		// timestamps_dtw, v1.9.1): it marks the END of the token, not its start.
		// So a word runs from the t_dtw of the text token before it to the t_dtw
		// of its own last token. Taking its first token's t_dtw as the start put
		// every word one token late (+175 ms median, tools/stt-eval/word-timing).
		// The previous token carries across segments; the request's very first
		// word has none and starts on its first token's time (the Node side
		// anchors it on the speech onset anyway).
		double prev_tok_end = -1.0;
		const int n_segments = input.empty() ? 0 : whisper_full_n_segments(ctx);
		for (int si = 0; si < n_segments; ++si) {
			Segment seg;
			seg.start = to_original_sec(whisper_full_get_segment_t0(ctx, si), kept);
			seg.end   = to_original_sec(whisper_full_get_segment_t1(ctx, si), kept);
			if (const char* t = whisper_full_get_segment_text(ctx, si)) seg.text = t;

			struct W { double start; double end; double anchor; double p_sum; int p_n; std::string text; };
			std::vector<W> word_buf;
			std::string cur_text;
			bool in_word = false;
			double w_start = 0, w_end = 0, w_anchor = 0;
			double w_p_sum = 0; int w_p_n = 0;

			const int n_tokens = whisper_full_n_tokens(ctx, si);
			for (int ti = 0; ti < n_tokens; ++ti) {
				const whisper_token_data td = whisper_full_get_token_data(ctx, si, ti);
				std::string raw = (td.id >= 0 && td.id < n_vocab) ? vocab_strs[td.id] : std::string();

				if (td.id >= eot) continue;  // special token: skip text and words

				if (td.t_dtw == -1) {
					dtw_guard_pass = false;
					if (guardrail_msg.empty()) guardrail_msg = "token t_dtw == -1 (DTW not computed)";
				}
				const int64_t delta = std::abs(td.t_dtw - td.t0);
				dtw_abs_delta_sum += delta;
				if (non_special_tokens > 0 && td.t_dtw < prev_t_dtw) {
					dtw_guard_pass = false;
					if (guardrail_msg.empty()) guardrail_msg = "non-monotonic t_dtw";
				}
				prev_t_dtw = td.t_dtw;
				++non_special_tokens;

				const bool starts_word = (!in_word) || (!raw.empty() && raw[0] == ' ');
				const double td_dtw = to_original_sec(td.t_dtw >= 0 ? td.t_dtw : 0, kept);

				if (starts_word && in_word) {
					word_buf.push_back({ w_start, w_end, w_anchor, w_p_sum, w_p_n, cur_text });
					w_p_sum = 0; w_p_n = 0; cur_text.clear();
				}
				if (starts_word) {
					in_word = true;
					w_start  = prev_tok_end >= 0 ? prev_tok_end : td_dtw;
					w_anchor = td_dtw;
					cur_text = (!raw.empty() && raw[0] == ' ') ? raw.substr(1) : raw;
				} else {
					cur_text += raw;
				}
				w_end        = td_dtw;
				prev_tok_end = td_dtw;
				w_p_sum += td.p;
				w_p_n   += 1;
			}
			if (in_word) {
				word_buf.push_back({ w_start, w_end, w_anchor, w_p_sum, w_p_n, cur_text });
			}
			for (const W& b : word_buf) {
				Word w;
				w.start  = b.start;
				w.end    = b.end;
				w.anchor = b.anchor;
				w.prob   = b.p_sum / std::max(1, b.p_n);
				w.text   = b.text;
				seg.words.push_back(w);
			}
			segments.push_back(std::move(seg));
		}

		// Final §4.1 check: zero abs-delta sum → DTW identical to heuristic.
		if (non_special_tokens > 0 && dtw_abs_delta_sum == 0) {
			dtw_guard_pass = false;
			if (guardrail_msg.empty()) guardrail_msg = "Σ|t_dtw − t0| == 0 (DTW identical to heuristic)";
		}
		log("§4.1 guardrail: " + std::string(dtw_guard_pass ? "PASS" : "FAIL") +
		    " (non_special_tokens=" + std::to_string(non_special_tokens) +
		    ", Σ|t_dtw-t0|=" + std::to_string(dtw_abs_delta_sum) +
		    (guardrail_msg.empty() ? ")" : (", " + guardrail_msg + ")")));
		if (!dtw_guard_pass) {
			res.status = 500;
			res.set_content(
				std::string(R"({"error":"DTW guardrail failed: )") + json_escape(guardrail_msg) + R"("})",
				"application/json");
			return;
		}

		// ---- Emit verbose_json (CT2-compatible shape + backend + timing) ----
		//
		// Report the language whisper actually decoded with, not the one the
		// request asked for. `language` is the raw request parameter, and the
		// renderer sends "auto" on every call (there is no language selector in
		// the UI yet), so echoing it back meant `detected_language` never
		// carried a language at all: the media stage's "detected language" line
		// rendered the literal string "auto", and AxcutTranscript.language was
		// set to it via transcribe.ts. whisper_full_lang_id() returns the id
		// whisper resolved — the detected one under "auto", and the forced one
		// otherwise, which is correct for both paths.
		std::string resolved_language = language;
		const int lang_id = input.empty() ? -1 : whisper_full_lang_id(ctx);
		if (lang_id >= 0) {
			if (const char* lang_str = whisper_lang_str(lang_id)) {
				resolved_language = lang_str;
			}
		}
		nlohmann::json reply;
		reply["language"]          = resolved_language;
		reply["detected_language"] = resolved_language;
		reply["backend"]           = active_backend;
		reply["timing"] = {
			{"elapsed_s", elapsed_s},
			{"audio_s",   audio_s},
			{"rtf",       rtf},
		};
		nlohmann::json segs = nlohmann::json::array();
		for (size_t i = 0; i < segments.size(); ++i) {
			const auto& s = segments[i];
			nlohmann::json seg;
			seg["id"]    = static_cast<int>(i);
			seg["text"]  = s.text;
			seg["start"] = s.start;
			seg["end"]   = s.end;
			nlohmann::json words = nlohmann::json::array();
			for (const auto& w : s.words) {
				words.push_back({
					{"word",        w.text},
					{"start",       w.start},
					{"end",         w.end},
					{"anchor",      w.anchor},
					{"probability", w.prob},
				});
			}
			seg["words"] = std::move(words);
			segs.push_back(std::move(seg));
		}
		reply["segments"] = std::move(segs);
		if (vctx) reply["speech"] = std::move(speech_json);
		res.set_content(reply.dump(), "application/json");
	});

	// POST /emissions — the CTC aligner's acoustic pass (issue #948, phase 3).
	// Multipart form: `file` (the same WAV as /inference), `model` (path of a
	// wav2vec2 GGUF, see ctc_aligner.h) and `regions` (JSON [[start_s, end_s], ...]).
	// Answers the model's vocabulary and, per region, base64 float32 log-probs
	// [frames x vocab]; frame i of a region sees the audio from
	// `start + i * stride_s` for `receptive_s`. The forced alignment itself runs
	// on the Node side (electron/stt/ctcAlign.ts). The model stays loaded until a
	// request names another one.
	CtcModelPtr aligner;
	std::string aligner_path;
	svr.Post("/emissions", [&](const httplib::Request& req, httplib::Response& res) {
		std::vector<float> pcm;
		if (!read_upload(req, res, pcm)) return;
		const std::string model = req.get_file_value("model").content;
		nlohmann::json regions = nlohmann::json::parse(req.get_file_value("regions").content, nullptr, false);
		if (model.empty() || !regions.is_array()) {
			res.status = 400;
			res.set_content(R"({"error":"need 'model' and a JSON 'regions' array"})", "application/json");
			return;
		}
		const std::lock_guard<std::mutex> lk(infer_mu);
		const auto t0 = std::chrono::steady_clock::now();
		if (!aligner || aligner_path != model) {
			aligner.reset();
			std::string err;
			aligner = ctc_load(model, cparams.use_gpu, threads, err);
			if (!aligner) {
				log("aligner: " + err);
				res.status = 500;
				res.set_content(nlohmann::json{{"error", "aligner: " + err}}.dump(), "application/json");
				return;
			}
			aligner_path = model;
			log("aligner loaded on " + ctc_device(*aligner) + ": " + model);
		}
		const CtcModelInfo& info = ctc_info(*aligner);
		nlohmann::json out_regions = nlohmann::json::array();
		const int64_t n_pcm = static_cast<int64_t>(pcm.size());
		for (const auto& r : regions) {
			if (!r.is_array() || r.size() != 2 || !r[0].is_number() || !r[1].is_number()) continue;
			const int64_t from = std::clamp<int64_t>(std::llround(r[0].get<double>() * 16000.0), 0, n_pcm);
			const int64_t to = std::clamp<int64_t>(std::llround(r[1].get<double>() * 16000.0), from, n_pcm);
			std::vector<float> lp;
			int frames = 0;
			std::string err;
			if (!ctc_emissions(*aligner, pcm.data() + from, static_cast<size_t>(to - from), lp, frames, err)) {
				log("aligner: " + err);
				res.status = 500;
				res.set_content(nlohmann::json{{"error", "aligner: " + err}}.dump(), "application/json");
				return;
			}
			out_regions.push_back({
				{"start", from / 16000.0},
				{"frames", frames},
				{"logprobs", base64(lp.data(), lp.size() * sizeof(float))},
			});
		}
		const double elapsed_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
		nlohmann::json reply = {
			{"vocab", info.vocab},
			{"blank", info.blank},
			{"languages", info.languages},
			{"stride_s", info.stride / 16000.0},
			{"receptive_s", info.receptive_field / 16000.0},
			{"device", ctc_device(*aligner)},
			{"elapsed_s", elapsed_s},
			{"regions", std::move(out_regions)},
		};
		res.set_content(reply.dump(), "application/json");
	});

	// ---- bind + listen ----
	int bound_port = port;
	if (bound_port == 0) {
		bound_port = svr.bind_to_any_port(host);
	} else if (!svr.bind_to_port(host, bound_port)) {
		std::cerr << "FATAL: bind_to_port(" << host << ":" << bound_port << ") failed" << std::endl;
		if (vctx) whisper_vad_free(vctx);
		whisper_free(ctx);
		return 4;
	}
	log("listening on " + host + ":" + std::to_string(bound_port));
	const int rc = svr.listen_after_bind() ? 0 : 5;
	if (rc != 0) {
		std::cerr << "FATAL: listen_after_bind failed" << std::endl;
	}
	if (vctx) whisper_vad_free(vctx);
	whisper_free(ctx);
	return rc;
}
