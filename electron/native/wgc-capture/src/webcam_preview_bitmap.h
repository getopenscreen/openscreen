#pragma once

#include <algorithm>
#include <cstdint>
#include <span>
#include <vector>

// A bounded, top-down BMP for the presenter preview. Only these small pixels cross
// the process boundary; the native camera and recording clocks remain untouched.
inline std::vector<uint8_t> webcamPreviewBitmap(
    std::span<const uint8_t> frame, int width, int height, bool nv12) {
    if (width < 2 || height < 2 || width > 16384 || height > 16384 ||
        (nv12 && (width % 2 || height % 2))) return {};
    const size_t required = static_cast<size_t>(width) * height * (nv12 ? 3 : 8) / 2;
    if (frame.size() < required) return {};
    const int outWidth = std::min(320, width);
    const int outHeight = std::clamp(height * outWidth / width, 1, 2560);
    const uint32_t bytes = outWidth * outHeight * 4;
    std::vector<uint8_t> bmp(54 + bytes, 0);
    const auto put = [&](size_t at, uint32_t value, int count = 4) {
        for (int i = 0; i < count; ++i) bmp[at + i] = static_cast<uint8_t>(value >> (8 * i));
    };
    bmp[0] = 'B'; bmp[1] = 'M';
    put(2, static_cast<uint32_t>(bmp.size())); put(10, 54); put(14, 40);
    put(18, outWidth); put(22, static_cast<uint32_t>(-outHeight));
    put(26, 1, 2); put(28, 32, 2); put(34, bytes);
    for (int y = 0; y < outHeight; ++y) {
        const int sy = y * height / outHeight;
        for (int x = 0; x < outWidth; ++x) {
            const int sx = x * width / outWidth;
            const size_t to = 54 + (static_cast<size_t>(y) * outWidth + x) * 4;
            if (nv12) {
                const int yy = std::max(0, static_cast<int>(frame[sy * width + sx]) - 16);
                const size_t uv = static_cast<size_t>(width) * height + (sy / 2) * width + (sx & ~1);
                const int u = static_cast<int>(frame[uv]) - 128;
                const int v = static_cast<int>(frame[uv + 1]) - 128;
                bmp[to] = static_cast<uint8_t>(std::clamp((298 * yy + 516 * u + 128) >> 8, 0, 255));
                bmp[to + 1] = static_cast<uint8_t>(std::clamp((298 * yy - 100 * u - 208 * v + 128) >> 8, 0, 255));
                bmp[to + 2] = static_cast<uint8_t>(std::clamp((298 * yy + 409 * v + 128) >> 8, 0, 255));
            } else {
                const size_t from = (static_cast<size_t>(sy) * width + sx) * 4;
                std::copy_n(frame.begin() + from, 3, bmp.begin() + to);
            }
            bmp[to + 3] = 255;
        }
    }
    return bmp;
}
