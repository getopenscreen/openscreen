#include "frame_visibility.h"

#include <algorithm>

namespace {

// Sampling at most this many pixels keeps the probe cheap on a 4K frame while
// still covering it evenly.
constexpr size_t kMaxSamples = 4096;

// Luma is judged on a full-range 0..255 scale. A frame counts as visible when
// any sample is clearly above black, or when the picture is dim but not empty.
constexpr int kMaxLumaThreshold = 24;
constexpr int kAverageLumaThreshold = 4;

// BT.709/BT.601 studio range: black sits at 16, white at 235.
constexpr int kStudioBlack = 16;
constexpr int kStudioSpan = 235 - kStudioBlack;

bool isVisible(uint64_t lumaTotal, int maxLuma, size_t sampled) {
    const uint64_t averageLuma = sampled > 0 ? lumaTotal / sampled : 0;
    return maxLuma > kMaxLumaThreshold || averageLuma > kAverageLumaThreshold;
}

}  // namespace

bool hasVisibleBgraContent(const std::vector<std::uint8_t>& frame) {
    if (frame.size() < 4) {
        return false;
    }

    uint64_t lumaTotal = 0;
    int maxLuma = 0;
    const size_t pixelCount = frame.size() / 4;
    const size_t step = std::max<size_t>(1, pixelCount / kMaxSamples);
    size_t sampled = 0;
    for (size_t pixel = 0; pixel < pixelCount; pixel += step) {
        const size_t offset = pixel * 4;
        const int b = frame[offset + 0];
        const int g = frame[offset + 1];
        const int r = frame[offset + 2];
        const int luma = (r * 54 + g * 183 + b * 19) >> 8;
        lumaTotal += static_cast<uint64_t>(luma);
        maxLuma = std::max(maxLuma, luma);
        sampled += 1;
    }

    return isVisible(lumaTotal, maxLuma, sampled);
}

bool hasVisibleNv12Content(const std::vector<std::uint8_t>& frame) {
    if (frame.size() < 6) {
        return false;
    }

    const size_t lumaCount = frame.size() * 2 / 3;
    const size_t step = std::max<size_t>(1, lumaCount / kMaxSamples);
    uint64_t lumaTotal = 0;
    int maxLuma = 0;
    size_t sampled = 0;
    for (size_t offset = 0; offset < lumaCount; offset += step) {
        // Studio range mapped onto 0..255, so the thresholds mean the same here
        // as they do for BGRA. Skip this and an all-black frame averages 16 --
        // past the average threshold on its own, so every black frame would
        // count as a picture.
        const int studio = static_cast<int>(frame[offset]);
        const int luma = std::clamp(((studio - kStudioBlack) * 255) / kStudioSpan, 0, 255);
        lumaTotal += static_cast<uint64_t>(luma);
        maxLuma = std::max(maxLuma, luma);
        sampled += 1;
    }

    return isVisible(lumaTotal, maxLuma, sampled);
}

bool hasVisibleWebcamContent(const std::vector<std::uint8_t>& frame, bool isNv12) {
    return isNv12 ? hasVisibleNv12Content(frame) : hasVisibleBgraContent(frame);
}
