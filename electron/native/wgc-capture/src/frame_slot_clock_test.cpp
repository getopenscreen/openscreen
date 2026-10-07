#include "frame_slot_clock.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>

namespace {

int failures = 0;

void expectEqual(const char* label, int64_t actual, int64_t expected) {
    if (actual == expected) {
        return;
    }
    std::printf("FAIL %s: expected %lld, got %lld\n", label, static_cast<long long>(expected),
                static_cast<long long>(actual));
    ++failures;
}

constexpr int64_t kSecondHns = 10'000'000;

// main.cpp's writer loop on a virtual clock: each tick costs `workHns`, one
// tick stalls `stallHns` more once the clock reaches `stallAtHns`, and the
// sleep is the same capped wait the writer takes. Returns frames written.
int64_t writeFor(int fps, int64_t durationHns, int64_t workHns, int64_t stallAtHns, int64_t stallHns) {
    FrameSlotClock clock(fps);
    const int64_t periodHns = kSecondHns / fps;
    int64_t nowHns = 0;
    int64_t frames = 0;
    bool stalled = false;
    while (nowHns < durationHns) {
        nowHns += workHns;
        if (!stalled && nowHns >= stallAtHns) {
            nowHns += stallHns;
            stalled = true;
        }
        ++frames;
        clock.advance(nowHns);
        nowHns += std::clamp<int64_t>(clock.nextDueHns() - nowHns, 0, periodHns);
    }
    return frames;
}

}  // namespace

int main() {
    // Nothing written yet: the first frame is due at once, whenever it comes.
    FrameSlotClock clock(60);
    expectEqual("first frame due at once", clock.nextDueHns(), 0);

    // The first frame is the origin, not the recording start.
    clock.advance(5'000'000);
    expectEqual("origin is the first frame", clock.nextDueHns(), 5'000'000 + 166'666);

    // The regression this file exists for (#945). A writer that misses ticks
    // owes their frames: the encoder numbers frames at the nominal rate, so
    // the count is the video's clock. A 300 ms stall one second in, 60 fps
    // for 3 s from the end of the first tick at 5 ms: 180 frames, the same as
    // with no stall. The old rule, resyncing to now after the stall, wrote 163:
    // the video ran 283 ms short, ahead of the audio for the rest of the take.
    expectEqual("steady writer keeps the count", writeFor(60, 3 * kSecondHns, 50'000, 3 * kSecondHns, 0), 180);
    expectEqual("stalled writer catches up", writeFor(60, 3 * kSecondHns, 50'000, kSecondHns, 3'000'000), 180);

    // Due times come from the origin, not from adding a truncated 1/fps
    // (166'666 hns at 60 fps) per frame, which lost 14 ms an hour.
    FrameSlotClock hour(60);
    for (int i = 0; i < 60 * 3600; ++i) {
        hour.advance(0);
    }
    expectEqual("no rounding drift over an hour", hour.nextDueHns(), 3600 * kSecondHns);

    if (failures == 0) {
        std::printf("frame_slot_clock_test: all assertions passed\n");
        return 0;
    }
    std::printf("frame_slot_clock_test: %d assertion(s) failed\n", failures);
    return 1;
}
