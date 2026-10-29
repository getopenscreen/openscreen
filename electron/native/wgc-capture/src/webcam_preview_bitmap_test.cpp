#include "webcam_preview_bitmap.h"
#include <cstdio>

int main() {
    int failures = 0;
    const auto check = [&](bool pass) { if (!pass) ++failures; };
    std::vector<uint8_t> bgra = {1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0};
    const auto bmp = webcamPreviewBitmap(bgra, 2, 2, false);
    check(bmp.size() == 70 && bmp[0] == 'B' && bmp[1] == 'M');
    check(bmp[18] == 2 && bmp[22] == 254 && bmp[23] == 255); // top-down
    check(bmp[54] == 1 && bmp[56] == 3 && bmp[57] == 255 && bmp[62] == 7);
    const std::vector<uint8_t> black = {16, 16, 16, 16, 128, 128};
    const auto dark = webcamPreviewBitmap(black, 2, 2, true);
    check(dark[54] == 0 && dark[55] == 0 && dark[56] == 0 && dark[57] == 255);
    const std::vector<uint8_t> white = {235, 235, 235, 235, 128, 128};
    const auto light = webcamPreviewBitmap(white, 2, 2, true);
    check(light[54] == 255 && light[55] == 255 && light[56] == 255);
    const std::vector<uint8_t> red = {81, 81, 81, 81, 90, 240};
    const auto color = webcamPreviewBitmap(red, 2, 2, true);
    check(color[54] < 3 && color[55] < 3 && color[56] > 250);
    check(webcamPreviewBitmap({}, 2, 2, false).empty());
    check(webcamPreviewBitmap(bgra, 3, 2, true).empty());
    check(webcamPreviewBitmap(bgra, -1, 2, false).empty());
    check(webcamPreviewBitmap(bgra, 16385, 2, false).empty());
    const std::vector<uint8_t> large(640 * 480 * 4, 32);
    const auto small = webcamPreviewBitmap(large, 640, 480, false);
    check(small.size() == 54 + 320 * 240 * 4 && small[54] == 32 && small[57] == 255);
    std::printf("webcam preview bitmap: %d failures\n", failures);
    return failures ? 1 : 0;
}
