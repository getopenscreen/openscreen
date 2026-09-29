#include "frame_visibility.h"

#include <cstdio>
#include <string>
#include <vector>

namespace {

int failures = 0;

void expectVisible(const std::string& label, bool actual, bool expected) {
    if (actual == expected) {
        return;
    }
    std::printf("FAIL %s: expected %s, got %s\n", label.c_str(), expected ? "visible" : "blank",
                actual ? "visible" : "blank");
    ++failures;
}

std::vector<std::uint8_t> nv12(int width, int height, std::uint8_t luma) {
    std::vector<std::uint8_t> frame(static_cast<size_t>(width) * height * 3 / 2, 128);
    std::fill(frame.begin(), frame.begin() + static_cast<size_t>(width) * height, luma);
    return frame;
}

std::vector<std::uint8_t> bgra(int width, int height, std::uint8_t value) {
    return std::vector<std::uint8_t>(static_cast<size_t>(width) * height * 4, value);
}

}  // namespace

int main() {
    // The regression this file exists for. A camera's NV12 is studio-range, so an
    // all-black frame is a plane of 16, not 0. Averaged raw that is 16 -- past the
    // average threshold on its own -- and every black frame counted as a picture,
    // which is exactly what the warm-up probe exists to rule out.
    expectVisible("studio-range black is blank", hasVisibleNv12Content(nv12(640, 480, 16)), false);
    expectVisible("true zero is blank", hasVisibleNv12Content(nv12(640, 480, 0)), false);

    // Just above black stays blank; a clearly lit frame does not.
    expectVisible("near-black is blank", hasVisibleNv12Content(nv12(640, 480, 20)), false);
    expectVisible("mid grey is visible", hasVisibleNv12Content(nv12(640, 480, 128)), true);
    expectVisible("studio white is visible", hasVisibleNv12Content(nv12(640, 480, 235)), true);

    // BGRA keeps its own behaviour: full-range, black is 0.
    expectVisible("bgra black is blank", hasVisibleBgraContent(bgra(640, 480, 0)), false);
    expectVisible("bgra grey is visible", hasVisibleBgraContent(bgra(640, 480, 128)), true);

    // Buffers too small to carry a frame must not be read past their end.
    expectVisible("empty nv12", hasVisibleNv12Content({}), false);
    expectVisible("empty bgra", hasVisibleBgraContent({}), false);
    expectVisible("runt nv12", hasVisibleNv12Content({16, 16, 16}), false);

    // The dispatcher has to pick the layout it is told, not guess. The same bytes
    // read as BGRA are bright; read as studio-range NV12 they are black.
    const std::vector<std::uint8_t> blackNv12 = nv12(320, 240, 16);
    expectVisible("dispatch nv12", hasVisibleWebcamContent(blackNv12, true), false);
    expectVisible("dispatch bgra", hasVisibleWebcamContent(bgra(320, 240, 200), false), true);

    if (failures == 0) {
        std::printf("frame_visibility_test: all assertions passed\n");
        return 0;
    }
    std::printf("frame_visibility_test: %d assertion(s) failed\n", failures);
    return 1;
}
