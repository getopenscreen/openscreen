#pragma once

#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif

#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <vector>

#include "third_party/kissfft/kiss_fft.h"

namespace openscreen::ct2 {

struct FeatureConfig {
  int sample_rate = 16000;
  int n_fft = 400;
  int hop_length = 160;
  int n_mels = 80;
  int chunk_length = 30; // seconds
};

// Pre-built mel filterbank of shape [n_mels, n_fft/2 + 1] (i.e. 80 × 201).
struct MelFilterbank {
  std::vector<float> weights; // row-major: weight[m * (n_fft/2+1) + bin] = gain
  int n_mels = 0;
  int n_bins = 0; // n_fft / 2 + 1
};

MelFilterbank build_mel_filterbank(const FeatureConfig& cfg);
std::vector<float> hann_window(int n_fft);
std::vector<float> reflect_pad(const std::vector<float>& x, int pad);

struct MelFeatures {
  // CTranslate2 Whisper expects a StorageView of shape {1, n_mels, n_frames}
  // with the last dimension contiguous, i.e. data[mel * n_frames + frame].
  // We store exactly that layout here (mel-major) so no transpose is needed.
  std::vector<float> data; // mel-major: [n_mels, n_frames]
  int n_frames = 0;
  int n_mels = 0;
};

MelFeatures compute_log_mel(const std::vector<float>& mono_16k,
                            const FeatureConfig& cfg,
                            const MelFilterbank& fb,
                            const std::vector<float>& window);

} // namespace openscreen::ct2
