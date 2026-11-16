#include "webcam_format.h"
#include "dshow_webcam_format.h"

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

// A Logitech C920, the most common webcam there is. Its uncompressed (YUY2)
// modes trade rate for size all the way down to 2 fps; only MJPEG reaches
// 1080p at 30. 1600x896 is 7.5 fps, rounded here as the helper rounds it.
const std::vector<WebcamFormat> kC920 = {
    {640, 480, 30, false},   {160, 90, 30, false},   {160, 120, 30, false},
    {176, 144, 30, false},   {320, 180, 30, false},  {320, 240, 30, false},
    {352, 288, 30, false},   {432, 240, 30, false},  {640, 360, 30, false},
    {800, 448, 30, false},   {800, 600, 24, false},  {864, 480, 24, false},
    {960, 720, 15, false},   {1024, 576, 15, false}, {1280, 720, 10, false},
    {1600, 896, 8, false},   {1920, 1080, 5, false}, {2304, 1296, 2, false},
    {2304, 1536, 2, false},  {640, 480, 30, true},   {1280, 720, 30, true},
    {1600, 896, 30, true},   {1920, 1080, 30, true},
};

// A Logitech StreamCam as Media Foundation lists it on Windows 11: every mode
// it has at 30 fps, plus its largest YUY2 ones. The NV12 entries mirror the
// MJPEG ones size for size, so the camera reaches 1080p at 30 uncompressed.
const std::vector<WebcamFormat> kStreamCam = {
    {640, 480, 30, false},   {848, 480, 30, false},   {960, 540, 15, false},
    {1280, 720, 10, false},  {1600, 896, 8, false},   {1920, 1080, 5, false},
    {640, 480, 30, false},   {640, 480, 30, true},    {848, 480, 30, false},
    {848, 480, 30, true},    {960, 540, 30, false},   {960, 540, 30, true},
    {1280, 720, 30, false},  {1280, 720, 30, true},   {1600, 896, 30, false},
    {1600, 896, 30, true},   {1920, 1080, 30, false}, {1920, 1080, 30, true},
};

void expectCompressed(const std::string& label, WebcamFormat actual, bool compressed) {
    if (actual.compressed == compressed) {
        return;
    }
    std::printf("FAIL %s: expected a%s mode\n", label.c_str(), compressed ? " compressed" : "n uncompressed");
    ++failures;
}

}  // namespace

int main() {
    // The first 4K format NVIDIA Broadcast actually offers: MEDIASUBTYPE_ARGB32.
    const GUID broadcastArgb = {0x773C9AC0, 0x3274, 0x11D0,
                               {0xB7, 0x24, 0x00, 0xAA, 0x00, 0x6C, 0x1A, 0x01}};
    if (!isBgraDshowSubtype(broadcastArgb)) {
        std::printf("FAIL NVIDIA Broadcast ARGB32 must be read without a conversion graph\n");
        ++failures;
    }
    if (!isBgraDshowSubtype(MEDIASUBTYPE_RGB32) || isBgraDshowSubtype(MEDIASUBTYPE_RGB24) ||
        isBgraDshowSubtype(MEDIASUBTYPE_NV12) || isBgraDshowSubtype(MEDIASUBTYPE_YUY2)) {
        std::printf("FAIL BGRA classification must retain RGB32 and distinguish other pixel layouts\n");
        ++failures;
    }
    // The regression this file exists for: a BRIO asked for 1080p must not come
    // back with the 640x480 default it enumerates first.
    expectFormat("brio targets 1080p", chooseWebcamFormat(kBrio, 1920, 1080, 30), 1920, 1080, 30);

    // Asked for more than 1080p, a BRIO stays on its uncompressed 1080p30: its
    // larger modes are MJPEG, and decoding 1440p or 4K at 30 costs more than
    // the 1080p30 ceiling (4K takes 20 ms of every 33 ms frame on a desktop).
    for (const int height : {1440, 2160}) {
        const std::string label = "brio on " + std::to_string(height) + "p";
        const WebcamFormat chosen = chooseWebcamFormat(kBrio, height * 16 / 9, height, 30);
        expectFormat(label + " stays at 1080p30", chosen, 1920, 1080, 30);
        expectCompressed(label, chosen, false);
    }

    // getopenscreen/openscreen#1112: a C920 only reaches 1080p at 30 in MJPEG;
    // its uncompressed 1080p runs at 5 fps. Excluding MJPEG outright left it on
    // YUY2 800x448 at 30 on every preset.
    for (const int height : {1080, 1440, 2160}) {
        const std::string label = "c920 on " + std::to_string(height) + "p";
        const WebcamFormat chosen = chooseWebcamFormat(kC920, height * 16 / 9, height, 30);
        expectFormat(label + " takes MJPEG 1080p30", chosen, 1920, 1080, 30);
        expectCompressed(label, chosen, true);
    }

    // The StreamCam already has NV12 1080p30, so MJPEG would only add a decode.
    for (const int height : {1080, 1440, 2160}) {
        const std::string label = "streamcam on " + std::to_string(height) + "p";
        const WebcamFormat chosen = chooseWebcamFormat(kStreamCam, height * 16 / 9, height, 30);
        expectFormat(label + " keeps NV12 1080p30", chosen, 1920, 1080, 30);
        expectCompressed(label, chosen, false);
    }

    // Same size and rate: the uncompressed mode wins wherever it is listed.
    expectCompressed(
        "uncompressed breaks a tie",
        chooseWebcamFormat({{1920, 1080, 30, true}, {1920, 1080, 30, false}}, 1920, 1080, 30),
        false);

    // The decoder runs at the camera's rate, not ours: MJPEG 1080p60 costs
    // twice the ceiling even though only 30 of its frames are kept.
    expectFormat(
        "a 1080p60 MJPEG mode is too costly to decode",
        chooseWebcamFormat({{1920, 1080, 60, true}, {1280, 720, 30, false}}, 1920, 1080, 30),
        1280,
        720,
        30);

    // A camera with nothing but compressed modes still has to be usable.
    expectFormat(
        "compressed-only camera is still driven",
        chooseWebcamFormat({{1920, 1080, 30, true}, {1280, 720, 30, true}}, 1920, 1080, 30),
        1920,
        1080,
        30);

    // Even one too costly to decode: better a working 4K MJPEG than no camera.
    expectFormat(
        "a camera with only costly compressed modes is still driven",
        chooseWebcamFormat({{3840, 2160, 30, true}}, 1920, 1080, 30),
        3840,
        2160,
        30);

    // A mode too costly to decode loses even to a much smaller one.
    expectFormat(
        "4K MJPEG loses to a cheap mode",
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
