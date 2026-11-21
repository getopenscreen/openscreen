#pragma once

#include "mf_encoder.h"

#include <Windows.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

bool sameAudioFormatForMixing(const AudioInputFormat& left, const AudioInputFormat& right);
AudioInputFormat makeAacCompatibleAudioFormat(const AudioInputFormat& source);
void copyAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format,
    double gain,
    std::vector<BYTE>& destination);
void convertAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& sourceFormat,
    const AudioInputFormat& targetFormat,
    double gain,
    std::vector<BYTE>& destination);
// Cross-packet state for the integer-factor downsample path (96/192 kHz -> 48).
// Dropping frames is only safe once everything above the new Nyquist is gone,
// and a filter long enough to do that reaches back further than one packet — so
// its history has to outlive the call. `pendingFrames()` is how far into the
// current output group the stream has got, which is the same accounting the
// caller used to read off a leftover-bytes buffer: a group only produces an
// output frame once all `factor` of its frames have arrived.
//
// The same object also carries the NON-INTEGER conversion stream across
// packets (issue #920, item 24): cumulative frame accounting with absolute
// output positions, and a bounded retention of channel-mapped source frames
// for the interpolation windows. Output frame j of a stream always uses the
// position j * (source rate / target rate) with the interpolation arithmetic
// this file has always used, never a packet-local phase, so identical input
// prefixes produce identical output prefixes regardless of the partition.
//
// Deferral contract, per rate pair (S = source rate, T = target rate):
//   * T != S: an output frame whose interpolation window touches the newest
//     source frame is deferred until the window completes or the stream is
//     finalized, so at most ceil(T/S + 1/2) output frames are outstanding at
//     any time (2 for 48 kHz <-> 44.1 kHz). finalizeAudioConversion() emits
//     the tail with the old whole-stream endpoint clamping; if a stream is
//     NEVER finalized, that bounded tail is dropped by reset() — and therefore
//     by a mixer resume or the end of a take, both of which reset their
//     sources. Packetized per-packet emission counts differ from the pre-fix
//     code by the deferred frames while the stream content itself is
//     identical and drift-free.
//   * T == S (every ordinary microphone packet: WASAPI float32 against a
//     PCM16 target fails sameAudioFormatForMixing on subtype alone): each
//     frame emits immediately — frac == 0 makes the clamped window exact — so
//     per-packet output counts stay identical to the pre-fix converter and
//     no frame is ever held, dropped or deferred on this path.
//
// Retained source history is bounded by rate geometry, not by stream length:
// after each packet's emission at most ceil(S/(2T)) + 2 mapped frames are
// kept (the allowance covers the legacy double-precision index calculation).
//
// Transitions preserve the pre-fix cross-format contract: entering the
// interpolation path from integer decimation clears the integer history and
// remainder once (not once per packet), and entering integer decimation from
// interpolation discards the interpolation history and starts the integer
// filter cold. A DIFFERENT format pair on the same state starts a fresh,
// cold stream. A finalized stream accepts no more conversion input until
// reset() or a fresh state object.
class AudioDecimatorState {
public:
    void reset();
    size_t pendingFrames() const { return phase_; }

    // Used by the decimation path; not part of the caller's contract. `consume`
    // takes one source frame and writes `channels` filtered samples into `out`
    // on the frame that completes a group, which is the only frame that
    // survives the decimation.
    void prepare(UINT32 factor, UINT32 channels);
    bool consume(const double* frame, double* out);

    // --- Internal: the cross-packet interpolation state (issue #920 item 24) ---
    // Not part of the caller's contract. `prepareInterpolation` continues the
    // active stream when the format pair matches and cold-starts otherwise
    // (clearing integer history on the way in); it returns false only when the
    // state refuses input — a finalized stream, or checked counter arithmetic
    // that overflowed (fail-safe: no output until reset()).
    bool prepareInterpolation(const AudioInputFormat& source, const AudioInputFormat& target);
    // Called by the integer decimation branch so a state that was interpolating
    // begins decimation cold exactly once per transition.
    void beginIntegerDecimation();
    // Appends one source frame, already channel-mapped to `channels` target
    // channels and UNSCALED (gain is applied at the write, not here).
    void appendInterpolationFrame(const double* mappedFrame, UINT32 channels);

    bool interpolationActive() const { return mode_ == Mode::kInterpolation; }
    bool interpolationFinalized() const { return interpolationFinalized_; }
    uint64_t interpolationInputFrames() const { return interpolationInputFrames_; }
    uint64_t interpolationEmittedFrames() const { return interpolationEmittedFrames_; }
    // K(N): the stream's final output quota, max(1, round_half_up(N*T/S)).
    uint64_t interpolationTotalFrames() const { return interpolationTotalFrames_; }
    // C(N): frames emittable before finalization (== K(N) when S == T).
    uint64_t interpolationEmittableFrames() const { return interpolationEmittableFrames_; }
    // K(N) - C(N): the deferred-output count, bounded by ceil(T/S + 1/2).
    uint64_t interpolationPendingFrames() const {
        return interpolationTotalFrames_ >= interpolationEmittableFrames_
            ? interpolationTotalFrames_ - interpolationEmittableFrames_
            : 0;
    }
    size_t interpolationRetainedFrames() const;
    double interpolationRateRatio() const {
        return static_cast<double>(interpolationTargetRate_) /
            static_cast<double>(interpolationSourceRate_);
    }
    double interpolationRetainedSample(uint64_t absoluteFrame, UINT32 channel) const;
    void noteInterpolationEmitted(uint64_t throughFrameCount);
    void trimInterpolationHistory();
    void markInterpolationFinalized();
    // Mixer-boundary discontinuity hook (a starved source resuming): abandons
    // ONLY the cross-packet interpolation stream — retained history, quotas,
    // flags and recorded formats — so no later output frame can interpolate
    // across the real-time gap. Integer decimation state and every
    // non-interpolating state are untouched (no-op); the next conversion
    // cold-starts the stream, exactly as a fresh state would. That cold start
    // is deliberate even for a finalized or overflow-parked stream: the
    // discontinuity revives it fresh (production mixers never finalize, and
    // counter overflow is unreachable in practice, so this only matters to
    // state-machine completeness).
    void abandonInterpolation();

private:
    enum class Mode {
        kNone,
        kInteger,
        kInterpolation,
    };

    std::vector<double> taps_;
    std::vector<double> history_;
    size_t position_ = 0;
    size_t phase_ = 0;
    UINT32 factor_ = 0;
    UINT32 channels_ = 0;

    Mode mode_ = Mode::kNone;
    bool interpolationFinalized_ = false;
    // Set when checked counter arithmetic overflows; the state then refuses
    // input (empty output) until reset() rather than wrapping the geometry.
    bool interpolationOverflow_ = false;
    GUID interpolationSourceSubtype_{};
    GUID interpolationTargetSubtype_{};
    UINT32 interpolationSourceRate_ = 0;
    UINT32 interpolationTargetRate_ = 0;
    UINT32 interpolationSourceChannels_ = 0;
    UINT32 interpolationTargetChannels_ = 0;
    UINT32 interpolationSourceBits_ = 0;
    UINT32 interpolationTargetBits_ = 0;
    // Cumulative input frames N, output frames emitted, and the quotas K(N)
    // and C(N) for the current stream prefix.
    uint64_t interpolationInputFrames_ = 0;
    uint64_t interpolationEmittedFrames_ = 0;
    uint64_t interpolationTotalFrames_ = 0;
    uint64_t interpolationEmittableFrames_ = 0;
    // Absolute source-frame index of retained_[0]; the retained frames are
    // channel-mapped, unscaled doubles, bounded per the class comment.
    uint64_t interpolationHistoryBase_ = 0;
    std::vector<double> interpolationRetained_;
};

void convertAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& sourceFormat,
    const AudioInputFormat& targetFormat,
    double gain,
    std::vector<BYTE>& destination,
    AudioDecimatorState& decimator);
// Emits the deferred tail of a non-integer conversion stream: the output
// frames between what convertAudioWithGain has already emitted and the
// stream's globally rounded quota K(N), computed with the same whole-stream
// endpoint clamping and interpolation arithmetic the pre-fix one-shot
// conversion used. The bytes are APPENDED to `destination`; finalization
// never re-emits earlier output.
//
// Contract:
//   * Repeated finalization returns no additional bytes.
//   * Finalizing an empty stream returns no bytes.
//   * A finalized stream accepts no more conversion input until reset() or a
//     fresh state (convertAudioWithGain refuses with empty output).
//   * No-op for integer and same-format conversion; it must not alter their
//     remainder/history behavior.
//   * Retained samples stay unscaled; `gain` is applied at the write, and the
//     target format must be the one the stream was converted to.
//   * Precondition: `destination` must be empty or contain a whole number of
//     `targetFormat` frames — its size must be a multiple of
//     `targetFormat.blockAlign`. The tail is appended after the last whole
//     frame with frame-aligned typed stores; a caller-supplied trailing
//     partial frame is outside this contract and is not preserved.
void finalizeAudioConversion(
    const AudioInputFormat& targetFormat,
    double gain,
    std::vector<BYTE>& destination,
    AudioDecimatorState& decimator);
// Mixes `source` into `destination`, scaling the source by `sourceGain` first.
// The gain rides in the double-domain sum and the result is clamped exactly
// once, at the write: a source whose scaled samples exceed full scale must
// saturate against the OTHER sources too (sum-then-clamp), not arrive
// pre-flattened by its own conversion (clamp-then-sum, which distorts twice
// and loses whatever headroom the opposite polarity of the mix had).
void mixAudioInPlace(
    std::vector<BYTE>& destination,
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format,
    double sourceGain = 1.0);

class AudioMixer {
public:
    using OutputCallback = std::function<bool(const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns)>;

    AudioMixer(
        const AudioInputFormat& format,
        const AudioInputFormat& systemFormat,
        const AudioInputFormat& microphoneFormat,
        bool includeSystem,
        bool includeMicrophone,
        double microphoneGain,
        double systemGain,
        OutputCallback output);
    ~AudioMixer();

    AudioMixer(const AudioMixer&) = delete;
    AudioMixer& operator=(const AudioMixer&) = delete;

    bool start();
    void beginTimeline();
    void setPaused(bool paused);
    void stop();
    void pushSystem(const BYTE* data, DWORD byteCount);
    void pushMicrophone(const BYTE* data, DWORD byteCount);

private:
    void append(
        std::vector<BYTE>& queue,
        bool& starved,
        const BYTE* data,
        DWORD byteCount,
        const AudioInputFormat& sourceFormat,
        double gain,
        AudioDecimatorState& decimator);
    bool pop(std::vector<BYTE>& queue, bool& starved, std::vector<BYTE>& chunk, size_t byteCount);
    void resetSources();
    void mixLoop();

    AudioInputFormat format_{};
    AudioInputFormat systemFormat_{};
    AudioInputFormat microphoneFormat_{};
    bool includeSystem_ = false;
    bool includeMicrophone_ = false;
    double microphoneGain_ = 1.0;
    double systemGain_ = 1.0;
    OutputCallback output_;
    std::mutex mutex_;
    std::condition_variable cv_;
    std::vector<BYTE> systemQueue_;
    std::vector<BYTE> microphoneQueue_;
    AudioDecimatorState systemDecimator_;
    AudioDecimatorState microphoneDecimator_;
    // Set when pop() runs a source dry, cleared by its next packet (see append).
    bool systemStarved_ = false;
    bool microphoneStarved_ = false;
    std::vector<BYTE> gainBuffer_;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    bool timelineStarted_ = false;
    bool paused_ = false;
    std::chrono::steady_clock::time_point pausedAt_{};
    // Set by mixLoop once it has written the cushion up to `pausedAt_`; a resume
    // waits for it, or it would clear audio that belongs before the pause.
    bool pauseFlushed_ = true;
    // mixLoop's clock, shared so a source coming back after running dry can be
    // placed at real time (see append). Written by mixLoop under `mutex_`.
    std::chrono::steady_clock::time_point clockStart_{};
    bool clockAnchored_ = false;
    // Test-only line of sight into the queues (defined in the test translation
    // unit); adds no production queue API.
    friend struct AudioMixerTestAccess;
    // Frames mixLoop has taken from the queues so far, under `mutex_`.
    uint64_t mixedFrames_ = 0;
    uint64_t emittedFrames_ = 0;
};
