// wav2vec2-for-CTC forward pass on ggml (HuggingFace Wav2Vec2ForCTC, both the
// "group norm, post-LN" base layout and the "layer norm, pre-LN" large one).
// Weights come from scripts/convert-wav2vec2-gguf.mjs.
//
// Layout: activations are [channels, time] (ne0 = channels) for the linear
// layers, and transposed to [time, channels] only where a convolution or a
// per-channel norm needs time contiguous.

#include "ctc_aligner.h"

#include <ggml.h>
#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <gguf.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>

namespace {

constexpr int kGraphSize = 8192;
// Longest input one graph sees; longer ones run in windows. Attention is
// quadratic in time and the first convolutions are wide, so this bounds memory
// (about 265 MB of compute buffers at 20 s, for either model: the first
// convolutions dominate).
constexpr int kWindowFrames = 1000;   // 20 s
constexpr int kContextFrames = 50;    // 1 s of context kept on each side of a window

struct Layer {
	ggml_tensor *q_w, *q_b, *k_w, *k_b, *v_w, *v_b, *o_w, *o_b;
	ggml_tensor *ln1_w, *ln1_b, *ff1_w, *ff1_b, *ff2_w, *ff2_b, *ln2_w, *ln2_b;
};

}  // namespace

struct CtcModel {
	CtcModelInfo info;
	int hidden = 0, n_heads = 0, pos_k = 0, pos_groups = 0;
	float eps = 1e-5f;
	bool group_norm = false, stable = false;
	std::vector<int> conv_k, conv_s;

	std::vector<ggml_tensor*> conv_w, conv_b, conv_ln_w, conv_ln_b;
	ggml_tensor *fp_ln_w = nullptr, *fp_ln_b = nullptr, *fp_w = nullptr, *fp_b = nullptr;
	ggml_tensor *pos_w = nullptr, *pos_b = nullptr, *enc_ln_w = nullptr, *enc_ln_b = nullptr;
	ggml_tensor *head_w = nullptr, *head_b = nullptr;
	std::vector<Layer> layers;

	ggml_context* wctx = nullptr;
	gguf_context* gctx = nullptr;
	ggml_backend_buffer_t wbuf = nullptr;
	ggml_backend_t gpu = nullptr, cpu = nullptr;
	ggml_backend_sched_t sched = nullptr;
	std::string device = "CPU";

	~CtcModel() {
		if (sched) ggml_backend_sched_free(sched);
		if (wbuf) ggml_backend_buffer_free(wbuf);
		if (gpu) ggml_backend_free(gpu);
		if (cpu) ggml_backend_free(cpu);
		if (wctx) ggml_free(wctx);
		if (gctx) gguf_free(gctx);
	}
};

void CtcModelDeleter::operator()(CtcModel* m) const { delete m; }

const CtcModelInfo& ctc_info(const CtcModel& model) { return model.info; }
std::string ctc_device(const CtcModel& model) { return model.device; }

namespace {

int64_t key(gguf_context* g, const char* k, std::string& err) {
	const int64_t id = gguf_find_key(g, k);
	if (id < 0 && err.empty()) err = std::string("missing metadata ") + k;
	return id;
}

std::vector<std::string> str_array(gguf_context* g, int64_t id) {
	std::vector<std::string> out;
	if (id < 0) return out;
	const size_t n = gguf_get_arr_n(g, id);
	for (size_t i = 0; i < n; ++i) out.emplace_back(gguf_get_arr_str(g, id, i));
	return out;
}

std::vector<int> u32_array(gguf_context* g, int64_t id) {
	std::vector<int> out;
	if (id < 0) return out;
	const auto* p = static_cast<const uint32_t*>(gguf_get_arr_data(g, id));
	out.assign(p, p + gguf_get_arr_n(g, id));
	return out;
}

ggml_tensor* layer_norm(ggml_context* ctx, ggml_tensor* x, ggml_tensor* w, ggml_tensor* b, float eps) {
	return ggml_add(ctx, ggml_mul(ctx, ggml_norm(ctx, x, eps), w), b);
}

ggml_tensor* linear(ggml_context* ctx, ggml_tensor* x, ggml_tensor* w, ggml_tensor* b) {
	return ggml_add(ctx, ggml_mul_mat(ctx, w, x), b);
}

// 1-D convolution of `x` [time, in] with `w` [k, in, out] -> [out, time']. The
// columns are F16, as in whisper.cpp's encoder: half the memory traffic of F32,
// which made the CPU path 1.7x slower, and `w` must be F16 to match.
ggml_tensor* conv1d(ggml_context* ctx, ggml_tensor* w, ggml_tensor* x, int stride, int pad) {
	ggml_tensor* cols = ggml_im2col(ctx, w, x, stride, 0, pad, 0, 1, 0, false, GGML_TYPE_F16);
	// cols: [k * in, time']
	cols = ggml_reshape_2d(ctx, cols, cols->ne[0], cols->ne[1]);
	ggml_tensor* w2 = ggml_reshape_2d(ctx, w, w->ne[0] * w->ne[1], w->ne[2]);
	return ggml_mul_mat(ctx, w2, cols);
}

ggml_tensor* build(CtcModel& m, ggml_context* ctx, ggml_tensor* wave) {
	// ---- feature encoder ----
	ggml_tensor* x = wave;  // [time, 1]
	ggml_tensor* y = nullptr;
	for (size_t i = 0; i < m.conv_w.size(); ++i) {
		y = conv1d(ctx, m.conv_w[i], x, m.conv_s[i], 0);  // [512, t]
		if (m.conv_b[i]) y = ggml_add(ctx, y, m.conv_b[i]);
		if (m.group_norm) {
			// Time-major for the next convolution. Only the first layer is normed:
			// GroupNorm with one group per channel, i.e. each channel over time.
			ggml_tensor* t = ggml_cont(ctx, ggml_transpose(ctx, y));  // [t, 512]
			if (i == 0) {
				t = ggml_norm(ctx, t, m.eps);
				t = ggml_add(ctx, ggml_mul(ctx, t, ggml_reshape_2d(ctx, m.conv_ln_w[0], 1, t->ne[1])),
				             ggml_reshape_2d(ctx, m.conv_ln_b[0], 1, t->ne[1]));
			}
			x = ggml_gelu_erf(ctx, t);
		} else {
			y = layer_norm(ctx, y, m.conv_ln_w[i], m.conv_ln_b[i], m.eps);
			x = ggml_cont(ctx, ggml_transpose(ctx, ggml_gelu_erf(ctx, y)));  // [t, 512]
		}
	}
	// x: [t, 512] -> [512, t]
	ggml_tensor* h = ggml_cont(ctx, ggml_transpose(ctx, x));
	const int64_t T = h->ne[1];

	// ---- feature projection ----
	h = layer_norm(ctx, h, m.fp_ln_w, m.fp_ln_b, m.eps);
	h = linear(ctx, h, m.fp_w, m.fp_b);  // [H, T]

	// ---- positional convolution (grouped, same padding, drop the last frame) ----
	{
		ggml_tensor* ht = ggml_cont(ctx, ggml_transpose(ctx, h));  // [T, H]
		const int64_t cg = m.hidden / m.pos_groups;
		ggml_tensor* pos = nullptr;
		for (int g = 0; g < m.pos_groups; ++g) {
			ggml_tensor* xin = ggml_view_2d(ctx, ht, T, cg, ht->nb[1], g * cg * ht->nb[1]);
			ggml_tensor* wg = ggml_view_3d(ctx, m.pos_w, m.pos_k, cg, cg, m.pos_w->nb[1],
			                               m.pos_w->nb[2], g * cg * m.pos_w->nb[2]);
			ggml_tensor* part = conv1d(ctx, wg, ggml_cont(ctx, xin), 1, m.pos_k / 2);  // [cg, T+1]
			pos = pos ? ggml_concat(ctx, pos, part, 0) : part;
		}
		pos = ggml_view_2d(ctx, pos, m.hidden, T, pos->nb[1], 0);
		pos = ggml_gelu_erf(ctx, ggml_add(ctx, pos, m.pos_b));
		h = ggml_add(ctx, h, pos);
	}
	if (!m.stable) h = layer_norm(ctx, h, m.enc_ln_w, m.enc_ln_b, m.eps);

	// ---- transformer ----
	const int64_t dh = m.hidden / m.n_heads;
	const float scale = 1.0f / std::sqrt(static_cast<float>(dh));
	for (const Layer& L : m.layers) {
		ggml_tensor* res = h;
		ggml_tensor* a = m.stable ? layer_norm(ctx, h, L.ln1_w, L.ln1_b, m.eps) : h;
		ggml_tensor* q = ggml_reshape_3d(ctx, linear(ctx, a, L.q_w, L.q_b), dh, m.n_heads, T);
		ggml_tensor* k = ggml_reshape_3d(ctx, linear(ctx, a, L.k_w, L.k_b), dh, m.n_heads, T);
		ggml_tensor* v = ggml_reshape_3d(ctx, linear(ctx, a, L.v_w, L.v_b), dh, m.n_heads, T);
		q = ggml_permute(ctx, q, 0, 2, 1, 3);                    // [dh, T, nh]
		k = ggml_permute(ctx, k, 0, 2, 1, 3);                    // [dh, T, nh]
		v = ggml_cont(ctx, ggml_permute(ctx, v, 1, 2, 0, 3));    // [T, dh, nh]
		ggml_tensor* kq = ggml_mul_mat(ctx, k, q);               // [Tk, Tq, nh]
		kq = ggml_soft_max_ext(ctx, kq, nullptr, scale, 0.0f);
		ggml_tensor* o = ggml_mul_mat(ctx, v, kq);               // [dh, Tq, nh]
		o = ggml_cont(ctx, ggml_permute(ctx, o, 0, 2, 1, 3));    // [dh, nh, T]
		o = linear(ctx, ggml_reshape_2d(ctx, o, m.hidden, T), L.o_w, L.o_b);
		h = ggml_add(ctx, res, o);
		if (m.stable) {
			ggml_tensor* f = layer_norm(ctx, h, L.ln2_w, L.ln2_b, m.eps);
			f = linear(ctx, ggml_gelu_erf(ctx, linear(ctx, f, L.ff1_w, L.ff1_b)), L.ff2_w, L.ff2_b);
			h = ggml_add(ctx, h, f);
		} else {
			h = layer_norm(ctx, h, L.ln1_w, L.ln1_b, m.eps);
			ggml_tensor* f = linear(ctx, ggml_gelu_erf(ctx, linear(ctx, h, L.ff1_w, L.ff1_b)), L.ff2_w, L.ff2_b);
			h = layer_norm(ctx, ggml_add(ctx, h, f), L.ln2_w, L.ln2_b, m.eps);
		}
	}
	if (m.stable) h = layer_norm(ctx, h, m.enc_ln_w, m.enc_ln_b, m.eps);
	return linear(ctx, h, m.head_w, m.head_b);  // [V, T]
}

int frames_for(const CtcModel& m, int64_t n) {
	for (size_t i = 0; i < m.conv_k.size(); ++i) {
		if (n < m.conv_k[i]) return 0;
		n = (n - m.conv_k[i]) / m.conv_s[i] + 1;
	}
	return static_cast<int>(n);
}

// Logits for one window of already-normalized samples.
bool run_window(CtcModel& m, const float* pcm, int64_t n, std::vector<float>& logits, int& frames,
                std::string& err) {
	frames = frames_for(m, n);
	if (frames <= 0) return true;
	ggml_init_params p = {ggml_tensor_overhead() * kGraphSize + ggml_graph_overhead_custom(kGraphSize, false),
	                      nullptr, true};
	ggml_context* ctx = ggml_init(p);
	ggml_tensor* wave = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, n, 1);
	ggml_set_input(wave);
	ggml_tensor* out = build(m, ctx, wave);
	ggml_set_output(out);
	ggml_cgraph* gf = ggml_new_graph_custom(ctx, kGraphSize, false);
	ggml_build_forward_expand(gf, out);
	ggml_backend_sched_reset(m.sched);
	bool ok = ggml_backend_sched_alloc_graph(m.sched, gf);
	if (ok) {
		ggml_backend_tensor_set(wave, pcm, 0, n * sizeof(float));
		ok = ggml_backend_sched_graph_compute(m.sched, gf) == GGML_STATUS_SUCCESS;
	}
	if (ok) {
		if (out->ne[1] != frames) {
			err = "unexpected frame count";
			ok = false;
		} else {
			logits.resize(static_cast<size_t>(out->ne[0]) * frames);
			ggml_backend_tensor_get(out, logits.data(), 0, logits.size() * sizeof(float));
		}
	} else if (err.empty()) {
		err = "ggml graph allocation or compute failed";
	}
	ggml_free(ctx);
	return ok;
}

}  // namespace

CtcModelPtr ctc_load(const std::string& path, bool use_gpu, int threads, std::string& err) {
	CtcModelPtr m(new CtcModel());
	gguf_init_params gp = {true, &m->wctx};
	m->gctx = gguf_init_from_file(path.c_str(), gp);
	if (!m->gctx) {
		err = "cannot read " + path;
		return nullptr;
	}
	gguf_context* g = m->gctx;
	CtcModelInfo& info = m->info;
	info.vocab = str_array(g, key(g, "w2v.vocab", err));
	info.languages = str_array(g, key(g, "w2v.languages", err));
	int64_t id;
	if ((id = key(g, "w2v.blank_id", err)) >= 0) info.blank = gguf_get_val_u32(g, id);
	if ((id = key(g, "w2v.hidden_size", err)) >= 0) m->hidden = gguf_get_val_u32(g, id);
	if ((id = key(g, "w2v.num_attention_heads", err)) >= 0) m->n_heads = gguf_get_val_u32(g, id);
	if ((id = key(g, "w2v.layer_norm_eps", err)) >= 0) m->eps = gguf_get_val_f32(g, id);
	if ((id = key(g, "w2v.num_conv_pos_embeddings", err)) >= 0) m->pos_k = gguf_get_val_u32(g, id);
	if ((id = key(g, "w2v.num_conv_pos_embedding_groups", err)) >= 0) m->pos_groups = gguf_get_val_u32(g, id);
	if ((id = key(g, "w2v.feat_extract_norm", err)) >= 0) m->group_norm = std::string(gguf_get_val_str(g, id)) == "group";
	if ((id = key(g, "w2v.stable_layer_norm", err)) >= 0) m->stable = gguf_get_val_bool(g, id);
	m->conv_k = u32_array(g, key(g, "w2v.conv_kernel", err));
	m->conv_s = u32_array(g, key(g, "w2v.conv_stride", err));
	int n_layers = 0;
	if ((id = key(g, "w2v.num_hidden_layers", err)) >= 0) n_layers = gguf_get_val_u32(g, id);
	if (!err.empty()) return nullptr;
	info.stride = 1;
	for (int s : m->conv_s) info.stride *= s;
	info.receptive_field = 1;
	for (int i = static_cast<int>(m->conv_k.size()) - 1; i >= 0; --i)
		info.receptive_field = (info.receptive_field - 1) * m->conv_s[i] + m->conv_k[i];

	auto T = [&](const std::string& name, bool required = true) -> ggml_tensor* {
		ggml_tensor* t = ggml_get_tensor(m->wctx, name.c_str());
		if (!t && required && err.empty()) err = "missing tensor " + name;
		return t;
	};
	for (size_t i = 0; i < m->conv_k.size(); ++i) {
		const std::string p = "feature_extractor.conv_layers." + std::to_string(i) + ".";
		m->conv_w.push_back(T(p + "conv.weight"));
		m->conv_b.push_back(T(p + "conv.bias", false));
		const bool has_ln = !m->group_norm || i == 0;
		m->conv_ln_w.push_back(has_ln ? T(p + "layer_norm.weight") : nullptr);
		m->conv_ln_b.push_back(has_ln ? T(p + "layer_norm.bias") : nullptr);
	}
	m->fp_ln_w = T("feature_projection.layer_norm.weight");
	m->fp_ln_b = T("feature_projection.layer_norm.bias");
	m->fp_w = T("feature_projection.projection.weight");
	m->fp_b = T("feature_projection.projection.bias");
	m->pos_w = T("encoder.pos_conv_embed.conv.weight");
	m->pos_b = T("encoder.pos_conv_embed.conv.bias");
	m->enc_ln_w = T("encoder.layer_norm.weight");
	m->enc_ln_b = T("encoder.layer_norm.bias");
	m->head_w = T("lm_head.weight");
	m->head_b = T("lm_head.bias");
	for (int l = 0; l < n_layers; ++l) {
		const std::string p = "encoder.layers." + std::to_string(l) + ".";
		m->layers.push_back({
			T(p + "attention.q_proj.weight"), T(p + "attention.q_proj.bias"),
			T(p + "attention.k_proj.weight"), T(p + "attention.k_proj.bias"),
			T(p + "attention.v_proj.weight"), T(p + "attention.v_proj.bias"),
			T(p + "attention.out_proj.weight"), T(p + "attention.out_proj.bias"),
			T(p + "layer_norm.weight"), T(p + "layer_norm.bias"),
			T(p + "feed_forward.intermediate_dense.weight"), T(p + "feed_forward.intermediate_dense.bias"),
			T(p + "feed_forward.output_dense.weight"), T(p + "feed_forward.output_dense.bias"),
			T(p + "final_layer_norm.weight"), T(p + "final_layer_norm.bias"),
		});
	}
	if (!err.empty()) return nullptr;
	// conv1d() multiplies them with F16 columns; anything else aborts inside ggml.
	for (const ggml_tensor* w : m->conv_w) {
		if (w->type != GGML_TYPE_F16) err = "convolution weights must be F16";
	}
	if (m->pos_w->type != GGML_TYPE_F16) err = "convolution weights must be F16";
	if (!err.empty()) return nullptr;
	if (static_cast<int>(info.vocab.size()) != m->head_w->ne[1]) {
		err = "vocabulary does not match lm_head";
		return nullptr;
	}

	// ---- backends ----
	if (use_gpu) {
		for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
			ggml_backend_dev_t dev = ggml_backend_dev_get(i);
			const auto type = ggml_backend_dev_type(dev);
			if (type != GGML_BACKEND_DEVICE_TYPE_GPU && type != GGML_BACKEND_DEVICE_TYPE_IGPU) continue;
			m->gpu = ggml_backend_dev_init(dev, nullptr);
			if (m->gpu) {
				m->device = ggml_backend_dev_name(dev);
				break;
			}
		}
	}
	m->cpu = ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
	if (!m->cpu) {
		err = "no CPU backend";
		return nullptr;
	}
	{
		ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(ggml_backend_get_device(m->cpu));
		using set_threads_t = void (*)(ggml_backend_t, int);
		auto set_threads = reinterpret_cast<set_threads_t>(
			ggml_backend_reg_get_proc_address(reg, "ggml_backend_set_n_threads"));
		if (set_threads) set_threads(m->cpu, threads);
	}
	ggml_backend_t weights_on = m->gpu ? m->gpu : m->cpu;
	m->wbuf = ggml_backend_alloc_ctx_tensors(m->wctx, weights_on);
	if (!m->wbuf) {
		err = "cannot allocate the model's weights";
		return nullptr;
	}
	{
		// The path is UTF-8, which Windows' fopen reads in the ANSI code page
		// (issue #1405). Not ggml_fopen: the helper links the CRT statically, so
		// a FILE* opened inside ggml.dll belongs to another CRT and crashes here.
#ifdef _WIN32
		FILE* f = _wfopen(std::filesystem::path(std::u8string(path.begin(), path.end())).c_str(), L"rb");
#else
		FILE* f = std::fopen(path.c_str(), "rb");
#endif
		if (!f) {
			err = "cannot open " + path;
			return nullptr;
		}
		std::vector<uint8_t> buf;
		const size_t data_off = gguf_get_data_offset(g);
		for (int64_t i = 0; i < gguf_get_n_tensors(g); ++i) {
			ggml_tensor* t = ggml_get_tensor(m->wctx, gguf_get_tensor_name(g, i));
			const size_t nbytes = ggml_nbytes(t);
			buf.resize(nbytes);
#ifdef _WIN32
			_fseeki64(f, static_cast<int64_t>(data_off + gguf_get_tensor_offset(g, i)), SEEK_SET);
#else
			fseeko(f, static_cast<off_t>(data_off + gguf_get_tensor_offset(g, i)), SEEK_SET);
#endif
			if (std::fread(buf.data(), 1, nbytes, f) != nbytes) {
				std::fclose(f);
				err = "truncated model file " + path;
				return nullptr;
			}
			ggml_backend_tensor_set(t, buf.data(), 0, nbytes);
		}
		std::fclose(f);
	}
	std::vector<ggml_backend_t> backends;
	if (m->gpu) backends.push_back(m->gpu);
	backends.push_back(m->cpu);
	m->sched = ggml_backend_sched_new(backends.data(), nullptr, static_cast<int>(backends.size()),
	                                  kGraphSize, false, true);
	if (!m->sched) {
		err = "cannot create the ggml scheduler";
		return nullptr;
	}
	return m;
}

bool ctc_emissions(CtcModel& m, const float* pcm, size_t n, std::vector<float>& out, int& frames,
                   std::string& err) {
	const int V = static_cast<int>(m.info.vocab.size());
	const int64_t stride = m.info.stride;
	frames = frames_for(m, static_cast<int64_t>(n));
	out.assign(static_cast<size_t>(std::max(frames, 0)) * V, 0.0f);
	if (frames <= 0) return true;

	// Wav2Vec2FeatureExtractor(do_normalize=True): zero mean, unit variance, per input.
	double mean = 0.0, var = 0.0;
	for (size_t i = 0; i < n; ++i) mean += pcm[i];
	mean /= static_cast<double>(n);
	for (size_t i = 0; i < n; ++i) var += (pcm[i] - mean) * (pcm[i] - mean);
	var /= static_cast<double>(n);
	const double inv = 1.0 / std::sqrt(var + 1e-7);
	std::vector<float> x(n);
	for (size_t i = 0; i < n; ++i) x[i] = static_cast<float>((pcm[i] - mean) * inv);

	// Windows of kWindowFrames, stepping by kWindowFrames - 2 * kContextFrames; each
	// keeps its frames away from the edges it shares with a neighbour.
	const int64_t win_samples = kWindowFrames * stride + (m.info.receptive_field - stride);
	const int hop = kWindowFrames - 2 * kContextFrames;
	std::vector<float> logits;
	for (int f0 = 0;; f0 += hop) {
		const int64_t s0 = static_cast<int64_t>(f0) * stride;
		const int64_t len = std::min<int64_t>(win_samples, static_cast<int64_t>(n) - s0);
		int wf = 0;
		if (!run_window(m, x.data() + s0, len, logits, wf, err)) return false;
		const bool last = s0 + len >= static_cast<int64_t>(n);
		const int keep_from = f0 == 0 ? 0 : kContextFrames;
		const int keep_to = last ? wf : std::min(wf, kWindowFrames - kContextFrames);
		for (int i = keep_from; i < keep_to && f0 + i < frames; ++i) {
			const float* row = logits.data() + static_cast<size_t>(i) * V;
			float mx = row[0];
			for (int v = 1; v < V; ++v) mx = std::max(mx, row[v]);
			double sum = 0.0;
			for (int v = 0; v < V; ++v) sum += std::exp(row[v] - mx);
			const float lse = mx + static_cast<float>(std::log(sum));
			float* dst = out.data() + static_cast<size_t>(f0 + i) * V;
			for (int v = 0; v < V; ++v) dst[v] = row[v] - lse;
		}
		if (last) break;
	}
	return true;
}
