#include "mel.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace openscreen::ct2 {

// Hankel-style Hann window of length n_fft+1 minus the last sample, per
// faster-whisper::feature_extractor.py:146 (`np.hanning(n_fft + 1)[:-1]`).
std::vector<float> hann_window(int n_fft) {
  // ponytail: brace-init here avoids the C++ "most vexing parse" —
  // `std::vector<float> w(size_t(n_fft));` would parse as a function
  // declaration named `w`. MSVC's /W4 is happy to take that route.
  std::vector<float> w{std::vector<float>(size_t(n_fft))};
  const int M = n_fft + 1;
  for (int i = 0; i < n_fft; ++i) {
    w[size_t(i)] = 0.5f * (1.0f - std::cos(2.0f * float(M_PI) * float(i) /
                                            float(M - 1)));
  }
  return w;
}

// ponytail: see `include/mel.h` for the full doc block; this is a literal
// port of faster-whisper's filterbank matrix construction.
MelFilterbank build_mel_filterbank(const FeatureConfig& cfg) {
  MelFilterbank fb;
  fb.n_mels = cfg.n_mels;
  fb.n_bins = cfg.n_fft / 2 + 1;
  fb.weights.assign(size_t(fb.n_mels) * size_t(fb.n_bins), 0.0f);

  std::vector<float> fftfreqs{std::vector<float>(size_t(fb.n_bins))};
  for (int i = 0; i < fb.n_bins; ++i) {
    fftfreqs[size_t(i)] =
        float(i) * float(cfg.sample_rate) / float(cfg.n_fft);
  }

  const float min_mel = 0.0f;
  const float max_mel = 45.245640471924965f;
  std::vector<float> mels{std::vector<float>(size_t(cfg.n_mels + 2))};
  for (int i = 0; i < cfg.n_mels + 2; ++i) {
    mels[size_t(i)] =
        min_mel + (max_mel - min_mel) * float(i) / float(cfg.n_mels + 1);
  }

  const float f_min = 0.0f;
  const float f_sp = 200.0f / 3.0f;
  std::vector<float> freqs{std::vector<float>(size_t(cfg.n_mels + 2))};
  for (int i = 0; i < cfg.n_mels + 2; ++i) {
    freqs[size_t(i)] = f_min + f_sp * mels[size_t(i)];
  }
  const float min_log_hz = 1000.0f;
  const float min_log_mel = (min_log_hz - f_min) / f_sp;
  const float logstep = std::log(6.4f) / 27.0f;
  for (int i = 0; i < cfg.n_mels + 2; ++i) {
    if (mels[size_t(i)] >= min_log_mel) {
      freqs[size_t(i)] =
          min_log_hz * std::exp(logstep * (mels[size_t(i)] - min_log_mel));
    }
  }

  std::vector<float> fdiff{std::vector<float>(size_t(cfg.n_mels + 1))};
  for (int i = 0; i < cfg.n_mels + 1; ++i) {
    fdiff[size_t(i)] = freqs[size_t(i + 1)] - freqs[size_t(i)];
  }

  for (int m = 0; m < cfg.n_mels; ++m) {
    const float enorm = 2.0f / (freqs[size_t(m + 2)] - freqs[size_t(m)]);
    for (int k = 0; k < fb.n_bins; ++k) {
      // Match faster-whisper::FeatureExtractor.get_mel_filters exactly:
      // lower = (fft_freq - mel_freq[m]) / fdiff[m]
      // upper = (mel_freq[m+2] - fft_freq) / fdiff[m+1]
      const float lower =
          (fftfreqs[size_t(k)] - freqs[size_t(m)]) / fdiff[size_t(m)];
      const float upper =
          (freqs[size_t(m + 2)] - fftfreqs[size_t(k)]) / fdiff[size_t(m + 1)];
      float w = std::max(0.0f, std::min(lower, upper));
      w *= enorm;
      fb.weights[size_t(m) * size_t(fb.n_bins) + size_t(k)] = w;
    }
  }
  return fb;
}

std::vector<float> reflect_pad(const std::vector<float>& x, int pad) {
  if (pad <= 0) return x;
  std::vector<float> out;
  out.reserve(x.size() + size_t(2 * pad));
  // Left reflection: x[pad], x[pad-1], ..., x[1]
  for (int i = pad; i > 0; --i) {
    out.push_back(x[size_t(i)]);
  }
  out.insert(out.end(), x.begin(), x.end());
  // Right reflection: x[L-2], x[L-3], ..., x[L-pad-1]
  // (mirrors np.pad(..., mode='reflect') which does NOT repeat edge samples).
  for (size_t i = 1; i <= size_t(pad); ++i) {
    size_t idx = (i + 1 >= x.size()) ? 0 : (x.size() - 1 - i);
    out.push_back(x[idx]);
  }
  return out;
}

MelFeatures compute_log_mel(const std::vector<float>& mono_16k,
                            const FeatureConfig& cfg,
                            const MelFilterbank& fb,
                            const std::vector<float>& window) {
  // Fast path: the STFT machinery is identical to what faster-whisper does;
  // see include/mel.h for the rationale + the per-line Python trace.
  const int pad_each = cfg.n_fft / 2;
  std::vector<float> padded = reflect_pad(mono_16k, pad_each);
  padded.push_back(0.0f);
  const int n_padded = int(padded.size());
  // Expected frame count for the WHOLE recording (not just one chunk_length
  // window) — used only to size the initial reserve() below so long
  // recordings don't repeatedly reallocate; main.cpp's own chunking slices
  // this full feature buffer into chunk_length windows afterwards.
  const int expected_frames =
      std::max(1, (n_padded - cfg.n_fft) / cfg.hop_length + 1);

  MelFeatures out;
  out.n_mels = cfg.n_mels;
  out.data.reserve(size_t(expected_frames) * size_t(cfg.n_mels));

  const int kept_bins = cfg.n_fft / 2;
  std::vector<float> magnitudes{std::vector<float>(size_t(kept_bins))};

  kiss_fft_cfg fft_cfg = kiss_fft_alloc(cfg.n_fft, 0, nullptr, nullptr);
  if (!fft_cfg) {
    throw std::runtime_error("kiss_fft_alloc failed");
  }

  std::vector<float> windowed_frame{std::vector<float>(size_t(cfg.n_fft))};
  std::vector<float> re_fft;
  std::vector<float> im_fft;
  std::vector<kiss_fft_cpx> buf{std::vector<kiss_fft_cpx>(size_t(cfg.n_fft))};
  std::vector<kiss_fft_cpx> out_fft{std::vector<kiss_fft_cpx>(size_t(cfg.n_fft))};

  for (int frame = 0;; ++frame) {
    const int offset = frame * cfg.hop_length;
    if (offset + cfg.n_fft > n_padded) break;

    for (int i = 0; i < cfg.n_fft; ++i) {
      windowed_frame[size_t(i)] =
          padded[size_t(offset + i)] * window[size_t(i)];
    }
    for (int i = 0; i < cfg.n_fft; ++i) {
      buf[size_t(i)].r = windowed_frame[size_t(i)];
      buf[size_t(i)].i = 0.0f;
    }
    kiss_fft(fft_cfg, buf.data(), out_fft.data());
    re_fft.resize(size_t(cfg.n_fft));
    im_fft.resize(size_t(cfg.n_fft));
    for (int i = 0; i < cfg.n_fft; ++i) {
      re_fft[size_t(i)] = out_fft[size_t(i)].r;
      im_fft[size_t(i)] = out_fft[size_t(i)].i;
    }

    for (int k = 0; k < kept_bins; ++k) {
      magnitudes[size_t(k)] = re_fft[size_t(k)] * re_fft[size_t(k)] +
                              im_fft[size_t(k)] * im_fft[size_t(k)];
    }

    // Mel filterbank: produce linear mel energies for this frame.
    std::vector<float> mel_out{std::vector<float>(size_t(cfg.n_mels), 0.0f)};
    for (int m = 0; m < cfg.n_mels; ++m) {
      float acc = 0.0f;
      const float* row = fb.weights.data() + size_t(m) * size_t(fb.n_bins);
      for (int k = 0; k < kept_bins; ++k) {
        acc += row[size_t(k)] * magnitudes[size_t(k)];
      }
      mel_out[size_t(m)] = acc;
    }

    // Store log10(clipped) in a temporary frame-major buffer. We delay
    // normalization until we know the global max across the whole utterance,
    // matching faster-whisper/whisper exactly (floor = max - 8, then /4 - 1).
    for (int m = 0; m < cfg.n_mels; ++m) {
      const float clipped = std::max(1e-10f, mel_out[size_t(m)]);
      out.data.push_back(std::log10(clipped));
    }
    out.n_frames += 1;
    // No cap here: this computes features for the FULL recording. main.cpp
    // slices the result into chunk_length windows afterwards (see the
    // "compute_log_mel hard-caps at 30s" bug this replaced — capping here
    // silently truncated every recording longer than one chunk before
    // chunking logic ever ran).
  }

  // -------------------------------------------------------------------------
  // Global normalization + transpose to mel-major [n_mels, n_frames].
  // -------------------------------------------------------------------------
  float max_val = -1e30f;
  for (float v : out.data) {
    if (v > max_val) max_val = v;
  }
  const float floor_at = max_val - 8.0f;

  std::vector<float> mel_major;
  mel_major.reserve(out.data.size());
  const int n_frames = out.n_frames;
  const int n_mels = out.n_mels;
  for (int m = 0; m < n_mels; ++m) {
    for (int f = 0; f < n_frames; ++f) {
      const float x = out.data[size_t(f) * size_t(n_mels) + size_t(m)];
      const float clamped = std::max(x, floor_at);
      mel_major.push_back((clamped + 4.0f) / 4.0f);
    }
  }
  out.data = std::move(mel_major);

  kiss_fft_free(fft_cfg);
  return out;
}

} // namespace openscreen::ct2
