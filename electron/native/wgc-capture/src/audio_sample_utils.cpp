#include "audio_sample_utils.h"

#include <mfapi.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <numeric>
#include <cstddef>
#include <cstring>
#include <limits>

namespace {

bool isFloatFormat(const AudioInputFormat& format) {
    return format.subtype == MFAudioFormat_Float && format.bitsPerSample == 32;
}

bool isPcmFormat(const AudioInputFormat& format, UINT32 bitsPerSample) {
    return format.subtype == MFAudioFormat_PCM && format.bitsPerSample == bitsPerSample;
}

template <typename T>
T clampTo(double value) {
    const double minValue = static_cast<double>(std::numeric_limits<T>::min());
    const double maxValue = static_cast<double>(std::numeric_limits<T>::max());
    return static_cast<T>(std::clamp(std::round(value), minValue, maxValue));
}

size_t bytesPerSample(const AudioInputFormat& format) {
    return format.bitsPerSample / 8;
}

double readSampleAsDouble(const BYTE* source, const AudioInputFormat& format, size_t frameIndex, UINT32 channelIndex) {
    if (!source || format.blockAlign == 0 || channelIndex >= format.channels) {
        return 0.0;
    }

    const size_t offset = frameIndex * format.blockAlign + channelIndex * bytesPerSample(format);
    if (isFloatFormat(format)) {
        return static_cast<double>(*reinterpret_cast<const float*>(source + offset));
    }
    if (isPcmFormat(format, 16)) {
        return static_cast<double>(*reinterpret_cast<const int16_t*>(source + offset)) / 32768.0;
    }
    if (isPcmFormat(format, 32)) {
        return static_cast<double>(*reinterpret_cast<const int32_t*>(source + offset)) / 2147483648.0;
    }
    return 0.0;
}

void writeSampleFromDouble(BYTE* destination, const AudioInputFormat& format, size_t frameIndex, UINT32 channelIndex, double value) {
    if (!destination || format.blockAlign == 0 || channelIndex >= format.channels) {
        return;
    }

    const double clamped = std::clamp(value, -1.0, 1.0);
    const size_t offset = frameIndex * format.blockAlign + channelIndex * bytesPerSample(format);
    if (isFloatFormat(format)) {
        *reinterpret_cast<float*>(destination + offset) = static_cast<float>(clamped);
        return;
    }
    if (isPcmFormat(format, 16)) {
        *reinterpret_cast<int16_t*>(destination + offset) = clampTo<int16_t>(clamped * 32767.0);
        return;
    }
    if (isPcmFormat(format, 32)) {
        *reinterpret_cast<int32_t*>(destination + offset) = clampTo<int32_t>(clamped * 2147483647.0);
    }
}

double readMappedChannel(const BYTE* source, const AudioInputFormat& format, size_t frameIndex, UINT32 targetChannel, UINT32 targetChannels) {
    if (format.channels == 0) {
        return 0.0;
    }
    if (format.channels == targetChannels && targetChannel < format.channels) {
        return readSampleAsDouble(source, format, frameIndex, targetChannel);
    }
    if (format.channels == 1) {
        return readSampleAsDouble(source, format, frameIndex, 0);
    }
    if (targetChannels == 1) {
        double sum = 0.0;
        for (UINT32 channel = 0; channel < format.channels; ++channel) {
            sum += readSampleAsDouble(source, format, frameIndex, channel);
        }
        return sum / static_cast<double>(format.channels);
    }
    return readSampleAsDouble(source, format, frameIndex, std::min(targetChannel, format.channels - 1));
}

UINT32 aacCompatibleSampleRate(UINT32 sampleRate) {
    constexpr UINT32 kAacSampleRates[] = {
        8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
    };
    if (sampleRate == 0) {
        return 48000;
    }
    for (UINT32 rate : kAacSampleRates) {
        if (sampleRate == rate) {
            return rate;
        }
    }
    return 48000;
}

} // namespace

constexpr int64_t HnsPerSecond = 10'000'000;

bool sameAudioFormatForMixing(const AudioInputFormat& left, const AudioInputFormat& right) {
    return left.subtype == right.subtype &&
           left.sampleRate == right.sampleRate &&
           left.channels == right.channels &&
           left.bitsPerSample == right.bitsPerSample &&
           left.blockAlign == right.blockAlign &&
           left.avgBytesPerSec == right.avgBytesPerSec;
}

// Microsoft AAC encoder (MFAudioFormat_AAC) sample rates. WASAPI loopback
// often reports 96000 or 192000; those are legal PCM mix rates but not AAC
// input rates, and SetInputMediaType then fails with MF_E_INVALIDMEDIATYPE
// (0xc00d36b4). Keep legal rates as-is so a working 44100/48000 path is
// unchanged; snap everything else (including 0) to 48000. The mixer already
// resamples through convertAudioWithGain when the source rate differs.
AudioInputFormat makeAacCompatibleAudioFormat(const AudioInputFormat& source) {
    AudioInputFormat format{};
    format.subtype = MFAudioFormat_PCM;
    format.sampleRate = aacCompatibleSampleRate(source.sampleRate);
    format.channels = 2;
    format.bitsPerSample = 16;
    format.blockAlign = format.channels * (format.bitsPerSample / 8);
    format.avgBytesPerSec = format.sampleRate * format.blockAlign;
    return format;
}

namespace {

// Zeroth-order modified Bessel of the first kind, for the Kaiser window. The
// series converges fast for the beta this file uses; the loop bails once a term
// stops moving the sum at double precision.
constexpr double kPi = 3.14159265358979323846;

double besselI0(double x) {
    double sum = 1.0;
    double term = 1.0;
    for (int k = 1; k < 128; k += 1) {
        term *= (x * x / 4.0) / (static_cast<double>(k) * k);
        sum += term;
        if (term < sum * 1e-17) {
            break;
        }
    }
    return sum;
}

// The whole anti-alias filter is these three numbers, and two properties follow
// from them for EVERY decimation factor -- which is what keeps this path general
// instead of tuned for the two rates that happen to be common:
//
//   * the cutoff always lands at 11/12 = 0.9167 of the OUTPUT Nyquist, because
//     both it and the Nyquist scale as 1/factor. So the passband stays flat to
//     roughly 0.8 of the output Nyquist and the stop band is already deep by the
//     time anything can fold back;
//   * the group delay is always 80*factor/2 source frames. After the decimation
//     phase hands back (factor-1) of them, the net is 39 + 1/factor output
//     frames -- bounded in [39, 39.5] whatever the factor, about 0.82 ms at
//     48 kHz out.
//
// Depth: a 36 kHz tone leaves 96 kHz -> 48 kHz at about -117 dB, against roughly
// -8 dB for the box average this replaces. 80 taps per step is ~1.5x the Kaiser
// minimum for that transition and depth. The margin is affordable because the
// cost is set by the SOURCE rate rather than the factor: the tap count grows
// with factor exactly as fast as the output rate falls, so 192 kHz -> 48 kHz and
// 192 kHz -> 8 kHz cost the same.
constexpr size_t kTapsPerDecimationStep = 80;
constexpr double kCutoffFractionOfSourceRate = 11.0 / 24.0;
constexpr double kKaiserBeta = 8.6;

}  // namespace

void AudioDecimatorState::reset() {
    std::fill(history_.begin(), history_.end(), 0.0);
    position_ = 0;
    phase_ = 0;
}

void AudioDecimatorState::prepare(UINT32 factor, UINT32 channels) {
    if (factor_ == factor && channels_ == channels && !taps_.empty()) {
        return;
    }
    factor_ = factor;
    channels_ = channels;
    // Kaiser-windowed sinc. The three constants and what follows from them are
    // documented where they are defined; here it is enough that the cutoff is
    // expressed against the SOURCE rate, which is what makes every factor land
    // on the same fraction of its own output Nyquist.
    const size_t tapCount = kTapsPerDecimationStep * factor + 1;
    const double cutoff = kCutoffFractionOfSourceRate / static_cast<double>(factor);
    const double middle = static_cast<double>(tapCount - 1) / 2.0;
    const double norm = besselI0(kKaiserBeta);
    taps_.assign(tapCount, 0.0);
    for (size_t k = 0; k < tapCount; k += 1) {
        const double offset = static_cast<double>(k) - middle;
        const double sinc = std::abs(offset) < 1e-12
            ? 2.0 * cutoff
            : std::sin(2.0 * kPi * cutoff * offset) / (kPi * offset);
        const double ratio = offset / middle;
        taps_[k] =
            sinc * besselI0(kKaiserBeta * std::sqrt(std::max(0.0, 1.0 - ratio * ratio))) / norm;
    }
    // Unity at DC, so the passband keeps the level the caller handed us.
    const double dc = std::accumulate(taps_.begin(), taps_.end(), 0.0);
    if (dc != 0.0) {
        for (double& tap : taps_) {
            tap /= dc;
        }
    }
    history_.assign(tapCount * channels, 0.0);
    position_ = 0;
    phase_ = 0;
}

bool AudioDecimatorState::consume(const double* frame, double* out) {
    if (taps_.empty() || channels_ == 0) {
        return false;
    }
    for (UINT32 channel = 0; channel < channels_; channel += 1) {
        history_[position_ * channels_ + channel] = frame[channel];
    }
    bool produced = false;
    phase_ += 1;
    if (phase_ == factor_) {
        phase_ = 0;
        produced = true;
        const size_t tapCount = taps_.size();
        for (UINT32 channel = 0; channel < channels_; channel += 1) {
            double sum = 0.0;
            size_t read = position_;
            for (size_t k = 0; k < tapCount; k += 1) {
                sum += taps_[k] * history_[read * channels_ + channel];
                read = read != 0 ? read - 1 : tapCount - 1;
            }
            out[channel] = sum;
        }
    }
    position_ = (position_ + 1 == taps_.size()) ? 0 : position_ + 1;
    return produced;
}

void copyAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format,
    double gain,
    std::vector<BYTE>& destination) {
    destination.resize(byteCount);
    if (!source || byteCount == 0) {
        std::fill(destination.begin(), destination.end(), static_cast<BYTE>(0));
        return;
    }

    if (std::abs(gain - 1.0) < 0.0001) {
        std::memcpy(destination.data(), source, byteCount);
        return;
    }

    if (isFloatFormat(format)) {
        const auto* input = reinterpret_cast<const float*>(source);
        auto* output = reinterpret_cast<float*>(destination.data());
        const size_t sampleCount = byteCount / sizeof(float);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = static_cast<float>(std::clamp(input[index] * gain, -1.0, 1.0));
        }
        return;
    }

    if (isPcmFormat(format, 16)) {
        const auto* input = reinterpret_cast<const int16_t*>(source);
        auto* output = reinterpret_cast<int16_t*>(destination.data());
        const size_t sampleCount = byteCount / sizeof(int16_t);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = clampTo<int16_t>(static_cast<double>(input[index]) * gain);
        }
        return;
    }

    if (isPcmFormat(format, 32)) {
        const auto* input = reinterpret_cast<const int32_t*>(source);
        auto* output = reinterpret_cast<int32_t*>(destination.data());
        const size_t sampleCount = byteCount / sizeof(int32_t);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = clampTo<int32_t>(static_cast<double>(input[index]) * gain);
        }
        return;
    }

    std::memcpy(destination.data(), source, byteCount);
}

void convertAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& sourceFormat,
    const AudioInputFormat& targetFormat,
    double gain,
    std::vector<BYTE>& destination) {
    AudioDecimatorState discardedDecimator;
    convertAudioWithGain(
        source, byteCount, sourceFormat, targetFormat, gain, destination, discardedDecimator);
}

void convertAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& sourceFormat,
    const AudioInputFormat& targetFormat,
    double gain,
    std::vector<BYTE>& destination,
    AudioDecimatorState& decimator) {
    if (!source || byteCount == 0 || sourceFormat.blockAlign == 0 || targetFormat.blockAlign == 0 ||
        sourceFormat.sampleRate == 0 || targetFormat.sampleRate == 0 || sourceFormat.channels == 0 ||
        targetFormat.channels == 0) {
        destination.clear();
        return;
    }

    if (sameAudioFormatForMixing(sourceFormat, targetFormat)) {
        // The decimator belongs to the caller, not to this call, so a packet
        // that does not decimate has to hand it back empty rather than leave a
        // half-finished group waiting for frames that will never arrive.
        //
        // In this helper that is a contract, not a live path. The mix format is
        // read once per session (a single GetMixFormat in
        // WasapiLoopbackCapture) and resolveInputFormat passes its subtype
        // through unchanged, so what
        // arrives here is whatever the audio engine hands out -- which is
        // float32, while the encoder target is always PCM16. Subtype alone
        // therefore never matches, and this branch is unreachable in
        // production. The suite does reach it, by reusing one state across
        // formats -- which is the point of writing it.
        decimator.reset();
        copyAudioWithGain(source, byteCount, targetFormat, gain, destination);
        return;
    }

    const size_t packetFrames = byteCount / sourceFormat.blockAlign;
    if (packetFrames == 0) {
        destination.clear();
        return;
    }

    // A note on level, because this filter can do something the box average could
    // not: a decimated peak can exceed the largest input sample it came from. A
    // transition band this sharp needs negative taps, and negative taps make the
    // step response overshoot; the box average never overshoots only because its
    // taps are all positive, which is also why it rejects so little. HOW MUCH it
    // overshoots is this design's choice, set by the cutoff and the window. For
    // a near-full-scale 1 kHz square wave -- the Gibbs case -- it is +1.4 to
    // +1.5 dB depending on the factor; a square with a higher fundamental
    // overshoots more, up to about +3.8 dB in the cases measured. For arbitrary
    // bounded input the ceiling is the sum of |taps|, 2.22 to 2.23 depending on
    // the factor, or about +7 dB. writeSampleFromDouble clamps, so overshoot
    // saturates rather than wrapping; the suite checks that write sample by
    // sample, and pins the 1 kHz figure at every factor it tests.

    // Integer-factor downsample (96 kHz / 192 kHz -> 48 kHz). Dropping every
    // Nth frame is only safe once the content above the new Nyquist is gone, so
    // every frame runs through an anti-alias low-pass first and that filter's
    // history rides across packets inside `decimator`. A group a packet leaves
    // unfinished is no longer held back as bytes — its frames are already in the
    // filter — and `pendingFrames()` is what reports how many there were.
    if (sourceFormat.sampleRate > targetFormat.sampleRate &&
        sourceFormat.sampleRate % targetFormat.sampleRate == 0) {
        const UINT32 factor = sourceFormat.sampleRate / targetFormat.sampleRate;
        decimator.prepare(factor, targetFormat.channels);
        const size_t maxTargetFrames = (packetFrames + decimator.pendingFrames()) / factor;
        destination.assign(maxTargetFrames * targetFormat.blockAlign, 0);
        std::vector<double> frame(targetFormat.channels, 0.0);
        std::vector<double> filtered(targetFormat.channels, 0.0);
        size_t targetFrame = 0;
        for (size_t sourceFrame = 0; sourceFrame < packetFrames; ++sourceFrame) {
            for (UINT32 channel = 0; channel < targetFormat.channels; ++channel) {
                frame[channel] = readMappedChannel(
                    source, sourceFormat, sourceFrame, channel, targetFormat.channels);
            }
            if (!decimator.consume(frame.data(), filtered.data())) {
                continue;
            }
            for (UINT32 channel = 0; channel < targetFormat.channels; ++channel) {
                writeSampleFromDouble(
                    destination.data(),
                    targetFormat,
                    targetFrame,
                    channel,
                    filtered[channel] * gain);
            }
            targetFrame += 1;
        }
        destination.resize(targetFrame * targetFormat.blockAlign);
        return;
    }

    // Same ownership rule as the pass-through above, but unlike that one this
    // branch is hot. A 48 kHz microphone against a 48 kHz PCM16 target fails
    // sameAudioFormatForMixing on subtype alone -- WASAPI hands out float32 --
    // and `sourceRate > targetRate` is false, so on an ordinary machine every
    // microphone packet lands here and resets a decimator it never used.
    decimator.reset();
    const size_t sourceFrames = packetFrames;
    const double rateRatio = static_cast<double>(targetFormat.sampleRate) /
        static_cast<double>(sourceFormat.sampleRate);
    const size_t targetFrames = std::max<size_t>(1, static_cast<size_t>(std::llround(sourceFrames * rateRatio)));
    destination.assign(targetFrames * targetFormat.blockAlign, 0);

    for (size_t targetFrame = 0; targetFrame < targetFrames; ++targetFrame) {
        const double sourcePosition = static_cast<double>(targetFrame) / rateRatio;
        const size_t sourceFrame = std::min(sourceFrames - 1, static_cast<size_t>(sourcePosition));
        const size_t nextFrame = std::min(sourceFrames - 1, sourceFrame + 1);
        const double frac = sourcePosition - static_cast<double>(sourceFrame);
        for (UINT32 channel = 0; channel < targetFormat.channels; ++channel) {
            const double a = readMappedChannel(
                source, sourceFormat, sourceFrame, channel, targetFormat.channels);
            const double b = readMappedChannel(
                source, sourceFormat, nextFrame, channel, targetFormat.channels);
            writeSampleFromDouble(
                destination.data(),
                targetFormat,
                targetFrame,
                channel,
                (a + (b - a) * frac) * gain);
        }
    }
}

void mixAudioInPlace(
    std::vector<BYTE>& destination,
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format) {
    if (!source || byteCount == 0 || destination.empty()) {
        return;
    }

    const size_t mixByteCount = std::min(destination.size(), static_cast<size_t>(byteCount));

    if (isFloatFormat(format)) {
        auto* output = reinterpret_cast<float*>(destination.data());
        const auto* input = reinterpret_cast<const float*>(source);
        const size_t sampleCount = mixByteCount / sizeof(float);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = static_cast<float>(std::clamp(output[index] + input[index], -1.0f, 1.0f));
        }
        return;
    }

    if (isPcmFormat(format, 16)) {
        auto* output = reinterpret_cast<int16_t*>(destination.data());
        const auto* input = reinterpret_cast<const int16_t*>(source);
        const size_t sampleCount = mixByteCount / sizeof(int16_t);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = clampTo<int16_t>(
                static_cast<double>(output[index]) + static_cast<double>(input[index]));
        }
        return;
    }

    if (isPcmFormat(format, 32)) {
        auto* output = reinterpret_cast<int32_t*>(destination.data());
        const auto* input = reinterpret_cast<const int32_t*>(source);
        const size_t sampleCount = mixByteCount / sizeof(int32_t);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = clampTo<int32_t>(
                static_cast<double>(output[index]) + static_cast<double>(input[index]));
        }
    }
}

AudioMixer::AudioMixer(
    const AudioInputFormat& format,
    const AudioInputFormat& systemFormat,
    const AudioInputFormat& microphoneFormat,
    bool includeSystem,
    bool includeMicrophone,
    double microphoneGain,
    OutputCallback output)
    : format_(format),
      systemFormat_(systemFormat),
      microphoneFormat_(microphoneFormat),
      includeSystem_(includeSystem),
      includeMicrophone_(includeMicrophone),
      microphoneGain_(microphoneGain),
      output_(std::move(output)) {}

AudioMixer::~AudioMixer() {
    stop();
}

bool AudioMixer::start() {
    if (!output_ || format_.sampleRate == 0 || format_.blockAlign == 0) {
        return false;
    }

    stopRequested_ = false;
    emittedFrames_ = 0;
    timelineStarted_ = false;
    paused_ = false;
    systemDecimator_.reset();
    microphoneDecimator_.reset();
    thread_ = std::thread([this] {
        mixLoop();
    });
    return true;
}

void AudioMixer::beginTimeline() {
    {
        std::scoped_lock lock(mutex_);
        systemQueue_.clear();
        microphoneQueue_.clear();
        systemDecimator_.reset();
        microphoneDecimator_.reset();
        emittedFrames_ = 0;
        timelineStarted_ = true;
    }
    cv_.notify_all();
}

void AudioMixer::setPaused(bool paused) {
    {
        std::scoped_lock lock(mutex_);
        paused_ = paused;
        if (paused_) {
            systemQueue_.clear();
            microphoneQueue_.clear();
            systemDecimator_.reset();
            microphoneDecimator_.reset();
        }
    }
    cv_.notify_all();
}

void AudioMixer::stop() {
    stopRequested_ = true;
    cv_.notify_all();
    if (thread_.joinable()) {
        thread_.join();
    }
}

void AudioMixer::pushSystem(const BYTE* data, DWORD byteCount) {
    if (!includeSystem_ || stopRequested_) {
        return;
    }

    {
        std::scoped_lock lock(mutex_);
        if (paused_) {
            return;
        }
        append(systemQueue_, data, byteCount, systemFormat_, 1.0, systemDecimator_);
    }
    cv_.notify_all();
}

void AudioMixer::pushMicrophone(const BYTE* data, DWORD byteCount) {
    if (!includeMicrophone_ || stopRequested_) {
        return;
    }

    {
        std::scoped_lock lock(mutex_);
        if (paused_) {
            return;
        }
        append(
            microphoneQueue_,
            data,
            byteCount,
            microphoneFormat_,
            microphoneGain_,
            microphoneDecimator_);
    }
    cv_.notify_all();
}

void AudioMixer::append(
    std::vector<BYTE>& queue,
    const BYTE* data,
    DWORD byteCount,
    const AudioInputFormat& sourceFormat,
    double gain,
    AudioDecimatorState& decimator) {
    if (!data || byteCount == 0) {
        return;
    }

    convertAudioWithGain(data, byteCount, sourceFormat, format_, gain, gainBuffer_, decimator);
    queue.insert(queue.end(), gainBuffer_.begin(), gainBuffer_.end());
}

bool AudioMixer::pop(std::vector<BYTE>& queue, std::vector<BYTE>& chunk, size_t byteCount) {
    if (queue.empty()) {
        chunk.assign(byteCount, 0);
        return false;
    }

    chunk.assign(byteCount, 0);
    const size_t copiedBytes = std::min(byteCount, queue.size());
    std::memcpy(chunk.data(), queue.data(), copiedBytes);
    queue.erase(queue.begin(), queue.begin() + static_cast<std::ptrdiff_t>(copiedBytes));
    return copiedBytes > 0;
}

/**
 * Emits one mixed chunk every `chunkFrames`, for as long as the timeline runs.
 *
 * On the clock, and not on the data. Timestamps here are derived from
 * `emittedFrames_`, so the output timeline only means anything if a chunk goes
 * out for every chunk of real time -- and it used to `continue` whenever both
 * queues were empty, leaving `emittedFrames_` where it was. WASAPI loopback
 * delivers nothing at all while nothing is playing, so a recording that begins
 * in silence emitted nothing, and the first sound to play landed at timestamp
 * zero. Measured: a sound played four seconds in was heard from the start, and
 * the audio track came out two seconds shorter than the take.
 *
 * A working microphone hid this, because it streams continuously and kept the
 * queue non-empty -- which is why a microphone failing at the OS level appeared
 * to cause a system-audio desync it merely stopped concealing
 * (getopenscreen/openscreen#406).
 *
 * `audioClockStart` is anchored so that `emittedFrames_` always describes the
 * time elapsed since the timeline began; re-deriving it on resume is what lets a
 * pause interrupt the clock without shifting everything recorded after it.
 */
void AudioMixer::mixLoop() {
    const uint32_t chunkFrames = std::max<uint32_t>(1, format_.sampleRate / 100);
    const size_t chunkBytes = static_cast<size_t>(chunkFrames) * format_.blockAlign;
    std::vector<BYTE> mixedChunk;
    std::vector<BYTE> sourceChunk;
    std::chrono::steady_clock::time_point audioClockStart;
    bool audioClockAnchored = false;

    const auto framesToDuration = [&](uint64_t frames) {
        return std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::duration<double>(static_cast<double>(frames) / format_.sampleRate));
    };

    while (true) {
        {
            std::unique_lock lock(mutex_);
            cv_.wait_for(lock, std::chrono::milliseconds(20), [&] {
                return stopRequested_.load() || (timelineStarted_ && !paused_);
            });

            if (stopRequested_) {
                break;
            }
            if (!timelineStarted_ || paused_) {
                // A pause stops the clock rather than resetting it: the anchor is
                // re-derived from `emittedFrames_` on resume, so what follows keeps
                // the position it would have had.
                audioClockAnchored = false;
                continue;
            }
        }

        const auto now = std::chrono::steady_clock::now();
        if (!audioClockAnchored) {
            audioClockStart = now - framesToDuration(emittedFrames_);
            audioClockAnchored = true;
        }

        // How much of the timeline real time has covered. Emitting up to here --
        // from the queues where they have data, from silence where they do not --
        // is what keeps the audio clock pinned to the take rather than to whether
        // anything happened to be playing.
        const auto elapsed = std::chrono::duration<double>(now - audioClockStart).count();
        const uint64_t targetFrames = static_cast<uint64_t>(elapsed * format_.sampleRate);

        while (emittedFrames_ + chunkFrames <= targetFrames) {
            {
                std::scoped_lock lock(mutex_);
                if (stopRequested_ || !timelineStarted_ || paused_) {
                    break;
                }
                mixedChunk.assign(chunkBytes, 0);
                if (includeSystem_) {
                    pop(systemQueue_, sourceChunk, chunkBytes);
                    mixAudioInPlace(mixedChunk, sourceChunk.data(), static_cast<DWORD>(sourceChunk.size()), format_);
                }
                if (includeMicrophone_) {
                    pop(microphoneQueue_, sourceChunk, chunkBytes);
                    mixAudioInPlace(mixedChunk, sourceChunk.data(), static_cast<DWORD>(sourceChunk.size()), format_);
                }
            }

            const int64_t timestampHns =
                static_cast<int64_t>((emittedFrames_ * HnsPerSecond) / format_.sampleRate);
            const int64_t durationHns =
                static_cast<int64_t>((static_cast<uint64_t>(chunkFrames) * HnsPerSecond) / format_.sampleRate);
            if (!output_(mixedChunk.data(), static_cast<DWORD>(mixedChunk.size()), timestampHns, durationHns)) {
                stopRequested_ = true;
                break;
            }
            emittedFrames_ += chunkFrames;
        }

        if (stopRequested_) {
            break;
        }

        std::this_thread::sleep_until(audioClockStart + framesToDuration(emittedFrames_ + chunkFrames));
    }
}
