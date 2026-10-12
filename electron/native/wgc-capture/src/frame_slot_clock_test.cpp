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

void expectTrue(const char* label, bool condition, int64_t detail) {
    if (condition) {
        return;
    }
    std::printf("FAIL %s (%lld)\n", label, static_cast<long long>(detail));
    ++failures;
}

constexpr int64_t kSecondHns = 10'000'000;
constexpr int64_t kMsHns = 10'000;

struct Take {
    int64_t samples = 0;
    int64_t lastSampleHns = -1;
    int64_t minIntervalHns = INT64_MAX;
    int64_t maxIntervalHns = 0;
    bool increasing = true;
    // Where the samples would end if their times were a count of frames at the
    // nominal rate, the rule this replaces for repeated frames (#945).
    int64_t countClockEndHns = 0;
};

// main.cpp's screen writer on a virtual recording clock. Each tick costs
// `workHns(tickStart)`; every `dropEvery`-th tick writes nothing (the DXGI path's
// contended frame); the sleep is the writer's: to the next due slot, capped at one
// period. Every sample is stamped by sampleTimeForTick with its tick's start.
template <typename Work>
Take writeTake(int fps, int64_t durationHns, Work workHns, int dropEvery) {
    FrameSlotClock clock(fps);
    const int64_t periodHns = kSecondHns / fps;
    Take take;
    int64_t nowHns = 0;
    int64_t ticks = 0;
    while (nowHns < durationHns) {
        const int64_t tickStartHns = nowHns;
        nowHns += workHns(tickStartHns);
        ++ticks;
        if (dropEvery == 0 || ticks % dropEvery != 0) {
            const int64_t sampleHns = sampleTimeForTick(tickStartHns, take.lastSampleHns);
            if (take.lastSampleHns >= 0) {
                const int64_t interval = sampleHns - take.lastSampleHns;
                take.increasing = take.increasing && interval > 0;
                take.minIntervalHns = std::min(take.minIntervalHns, interval);
                take.maxIntervalHns = std::max(take.maxIntervalHns, interval);
            }
            take.lastSampleHns = sampleHns;
            ++take.samples;
        }
        clock.advance(tickStartHns);
        nowHns += std::clamp<int64_t>(clock.nextDueHns() - nowHns, 0, periodHns);
    }
    take.countClockEndHns = (take.samples - 1) * kSecondHns / fps;
    return take;
}

}  // namespace

int main() {
    // Nothing written yet: the first frame is due at once, whenever it comes.
    FrameSlotClock clock(60);
    expectEqual("first frame due at once", clock.nextDueHns(), 0);

    // The first frame is the origin, not the recording start.
    clock.advance(5'000'000);
    expectEqual("origin is the first frame", clock.nextDueHns(), 5'000'000 + 166'666);

    // A tick 2.5 periods late skips the slots it missed: the next one is due at the
    // first slot after it, not at once (no catch-up burst).
    clock.advance(5'000'000 + 416'666);
    expectEqual("a late tick skips the missed slots", clock.nextDueHns(), 5'000'000 + 500'000);

    // A tick a hair early still moves on by one slot: the clock never stands still.
    FrameSlotClock early(60);
    early.advance(0);
    early.advance(166'000);
    expectEqual("an early tick still advances one slot", early.nextDueHns(), 333'333);

    // Samples carry their tick's time, kept strictly increasing.
    expectEqual("a sample carries its tick's time", sampleTimeForTick(500, 400), 500);
    expectEqual("the first sample carries its tick's time", sampleTimeForTick(0, -1), 0);
    expectEqual("a sample never repeats the last time", sampleTimeForTick(400, 400), 401);

    // The regression this file exists for. Ten minutes at 60 fps under the load the
    // report measured: a 300 ms stall at 1:00, then 2:30 of ticks that cost 25 ms
    // (more than a period) from 5:00, and one contended frame in every 97 dropped.
    // The video must end on the recording clock, within a few frames of the take's
    // length (the last tick may be a dropped one), with the stall left as a gap of
    // its own length and no burst after it.
    const int64_t tenMinutesHns = 600 * kSecondHns;
    auto load = [](int64_t tickStartHns) -> int64_t {
        if (tickStartHns >= 60 * kSecondHns && tickStartHns < 60 * kSecondHns + 5 * kMsHns) {
            return 300 * kMsHns;
        }
        if (tickStartHns >= 300 * kSecondHns && tickStartHns < 450 * kSecondHns) {
            return 25 * kMsHns;
        }
        return 5 * kMsHns;
    };
    const Take loaded = writeTake(60, tenMinutesHns, load, 97);
    expectTrue("sample times strictly increase", loaded.increasing, loaded.samples);
    expectTrue("the video ends on the recording clock",
               loaded.lastSampleHns > tenMinutesHns - 50 * kMsHns &&
                   loaded.lastSampleHns <= tenMinutesHns,
               loaded.lastSampleHns);
    expectTrue("the stall is a gap of its own length", loaded.maxIntervalHns >= 300 * kMsHns,
               loaded.maxIntervalHns);
    expectTrue("no burst of frames after a stall", loaded.minIntervalHns >= 5 * kMsHns,
               loaded.minIntervalHns);
    // The same take counted at the nominal rate would end seconds short: the overload
    // alone writes ~40 frames a second for 2:30. The scenario has teeth.
    expectTrue("a frame count would have lost the overload",
               loaded.lastSampleHns - loaded.countClockEndHns > 30 * kSecondHns,
               loaded.lastSampleHns - loaded.countClockEndHns);

    // An idle writer keeps the nominal cadence: 3 s at 60 fps is 180 samples.
    const Take idle = writeTake(60, 3 * kSecondHns, [](int64_t) -> int64_t { return 50'000; }, 0);
    expectEqual("steady writer keeps the cadence", idle.samples, 180);

    // Screen at 60 and webcam at 30 in one writer, both stamped with the tick's
    // start and the first tick stalling 300 ms: the two streams end within one
    // webcam frame of each other, on the same clock.
    {
        FrameSlotClock screen(60);
        FrameSlotClock webcam(30);
        int64_t nowHns = 0;
        int64_t lastScreenHns = -1;
        int64_t lastWebcamHns = -1;
        bool stalled = false;
        while (nowHns < 3 * kSecondHns) {
            const int64_t tickStartHns = nowHns;
            if (tickStartHns >= webcam.nextDueHns()) {
                lastWebcamHns = sampleTimeForTick(tickStartHns, lastWebcamHns);
                webcam.advance(tickStartHns);
            }
            nowHns += 50'000;
            if (!stalled) {
                nowHns += 3'000'000;
                stalled = true;
            }
            lastScreenHns = sampleTimeForTick(tickStartHns, lastScreenHns);
            screen.advance(tickStartHns);
            nowHns += std::clamp<int64_t>(screen.nextDueHns() - nowHns, 0, kSecondHns / 60);
        }
        const int64_t drift = lastScreenHns - lastWebcamHns;
        expectTrue("screen and webcam stay aligned after a first-tick stall",
                   drift > -kSecondHns / 30 && drift < kSecondHns / 30, drift);
    }

    // Due times come from the origin, not from adding a truncated 1/fps
    // (166'666 hns at 60 fps) per frame, which lost 14 ms an hour.
    FrameSlotClock hour(60);
    for (int64_t i = 0; i < 60 * 3600; ++i) {
        hour.advance(hour.nextDueHns());
    }
    expectEqual("no rounding drift over an hour", hour.nextDueHns(), 3600 * kSecondHns);

    if (failures == 0) {
        std::printf("frame_slot_clock_test: all assertions passed\n");
        return 0;
    }
    std::printf("frame_slot_clock_test: %d assertion(s) failed\n", failures);
    return 1;
}
