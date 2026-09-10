#pragma once

#include "mf_encoder.h"

#include <Windows.h>

#include <atomic>
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

private:
    std::vector<double> taps_;
    std::vector<double> history_;
    size_t position_ = 0;
    size_t phase_ = 0;
    UINT32 factor_ = 0;
    UINT32 channels_ = 0;
};

void convertAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& sourceFormat,
    const AudioInputFormat& targetFormat,
    double gain,
    std::vector<BYTE>& destination,
    AudioDecimatorState& decimator);
void mixAudioInPlace(
    std::vector<BYTE>& destination,
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format);

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
        const BYTE* data,
        DWORD byteCount,
        const AudioInputFormat& sourceFormat,
        double gain,
        AudioDecimatorState& decimator);
    bool pop(std::vector<BYTE>& queue, std::vector<BYTE>& chunk, size_t byteCount);
    void mixLoop();

    AudioInputFormat format_{};
    AudioInputFormat systemFormat_{};
    AudioInputFormat microphoneFormat_{};
    bool includeSystem_ = false;
    bool includeMicrophone_ = false;
    double microphoneGain_ = 1.0;
    OutputCallback output_;
    std::mutex mutex_;
    std::condition_variable cv_;
    std::vector<BYTE> systemQueue_;
    std::vector<BYTE> microphoneQueue_;
    AudioDecimatorState systemDecimator_;
    AudioDecimatorState microphoneDecimator_;
    std::vector<BYTE> gainBuffer_;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    bool timelineStarted_ = false;
    bool paused_ = false;
    uint64_t emittedFrames_ = 0;
};
