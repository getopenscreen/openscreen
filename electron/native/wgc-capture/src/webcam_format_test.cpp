#include "webcam_format.h"

#include <cstdio>
#include <string>

namespace {

int failures = 0;

void expectFormat(const std::string& label, WebcamFormat actual, int width, int height, int fps) {
    if (actual.width == width && actual.height == height && actual.fps == fps) {
        return;
    }
    std::printf(
        "FAIL %s: expected %dx%d@%d, got %dx%d@%d\n",
        label.c_str(),
        width,
        height,
        fps,
        actual.width,
        actual.height,
        actual.fps);
    ++failures;
}

// Every mode a Logitech BRIO advertises that this helper could drive, as read
// off the device with `ffmpeg -f dshow -list_options true`.
const std::vector<WebcamFormat> kBrio = {
    {640, 480, 30, false},   {640, 360, 30, false},  {1280, 720, 30, false},
    {1920, 1080, 30, false}, {1280, 720, 90, true},  {1920, 1080, 60, true},
    {2560, 1440, 30, true},  {3840, 2160, 30, true}, {160, 120, 30, false},
    {340, 340, 30, false},   {1600, 896, 30, false}, {1024, 576, 30, false},
};

}  // namespace

int main() {
    // The regression this file exists for: a BRIO asked for 1080p must not come
    // back with the 640x480 default it enumerates first.
    expectFormat("brio targets 1080p", chooseWebcamFormat(kBrio, 1920, 1080, 30), 1920, 1080, 30);

    // Asked for more than the camera can do uncompressed, it must stop at the
    // best uncompressed mode rather than pin an MJPEG one. Pinning MJPEG and
    // asking the source reader for RGB32 produced a reader that delivered no
    // samples at all, so the take had no camera in it.
    expectFormat(
        "4K request settles for the best uncompressed mode",
        chooseWebcamFormat(kBrio, 3840, 2160, 30),
        1920,
        1080,
        30);
    if (chooseWebcamFormat(kBrio, 3840, 2160, 30).compressed) {
        std::printf("FAIL 4K request must not pin a compressed mode\n");
        ++failures;
    }

    // A camera with nothing but compressed modes still has to be usable.
    expectFormat(
        "compressed-only camera is still driven",
        chooseWebcamFormat({{1920, 1080, 30, true}, {1280, 720, 30, true}}, 1920, 1080, 30),
        1920,
        1080,
        30);

    // Uncompressed wins even when it is much smaller than a compressed option.
    expectFormat(
        "uncompressed beats a larger compressed mode",
        chooseWebcamFormat({{3840, 2160, 30, true}, {640, 480, 30, false}}, 3840, 2160, 30),
        640,
        480,
        30);

    // 1080p60 exists too; at a 30 fps encode the extra frames only cost bandwidth.
    expectFormat(
        "prefers the frame rate we encode at",
        chooseWebcamFormat({{1920, 1080, 60}, {1920, 1080, 30}}, 1920, 1080, 30),
        1920,
        1080,
        30);

    // Nothing reaches 30, so take the best the camera can do rather than fail.
    expectFormat(
        "falls back to the highest rate offered",
        chooseWebcamFormat({{1920, 1080, 15}, {1920, 1080, 24}}, 1920, 1080, 30),
        1920,
        1080,
        24);

    // A 720p-only camera keeps working, just smaller.
    expectFormat(
        "720p camera stays 720p",
        chooseWebcamFormat({{1280, 720, 30}, {640, 480, 30}}, 1920, 1080, 30),
        1280,
        720,
        30);

    // 2560x800 has fewer pixels than 1920x1080 but is far wider; picking it
    // would letterbox the overlay and cost a needless downscale.
    expectFormat(
        "rejects an oversized dimension even when pixel count fits",
        chooseWebcamFormat({{2560, 800, 30}, {1280, 720, 30}}, 1920, 1080, 30),
        1280,
        720,
        30);

    // Only modes above the target: scale down from the cheapest of them.
    expectFormat(
        "oversized-only camera takes the smallest mode",
        chooseWebcamFormat({{3840, 2160, 30}, {2560, 1440, 30}}, 1920, 1080, 30),
        2560,
        1440,
        30);

    // Nothing to choose from: hand the target back and let the driver decide.
    expectFormat("empty list returns the target", chooseWebcamFormat({}, 1920, 1080, 30), 1920, 1080, 30);

    // Drivers do report junk; it must not win.
    expectFormat(
        "ignores degenerate entries",
        chooseWebcamFormat({{0, 0, 30}, {-1920, 1080, 30}, {1280, 720, 30}}, 1920, 1080, 30),
        1280,
        720,
        30);

    if (failures == 0) {
        std::printf("webcam_format_test: all assertions passed\n");
        return 0;
    }
    std::printf("webcam_format_test: %d assertion(s) failed\n", failures);
    return 1;
}
