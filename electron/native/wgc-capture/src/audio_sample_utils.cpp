#include "audio_sample_utils.h"
#include "realtime_scheduling.h"

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

// --- Checked arithmetic for the interpolation stream's cumulative counters ---
// (issue #920, item 24). The API accepts arbitrary DWORD-sized packets and
// UINT32 rates, so the products below can in principle exceed 64 bits; a
// wrapped counter would silently corrupt the stream geometry, so overflow
// parks the state in a mode that emits nothing until reset() instead.

bool addChecked(uint64_t& out, uint64_t a, uint64_t b) {
    if (a > UINT64_MAX - b) {
        return false;
    }
    out = a + b;
    return true;
}

bool mulChecked(uint64_t& out, uint64_t a, uint64_t b) {
    if (a != 0 && b > UINT64_MAX / a) {
        return false;
    }
    out = a * b;
    return true;
}

// K(N) = max(1, round_half_up(N*T/S)), computed by decomposing N over S so the
// only products ever formed are (N mod S)*T and 2*(N mod S)*T — both checked,
// never an unchecked N*T.
bool interpolationQuota(uint64_t& out, uint64_t inputFrames, UINT32 sourceRate, UINT32 targetRate) {
    const uint64_t whole = inputFrames / sourceRate;
    const uint64_t rem = inputFrames % sourceRate;
    uint64_t wholeTargets = 0;
    if (!mulChecked(wholeTargets, whole, targetRate)) {
        return false;
    }
    uint64_t remTargets = 0;
    if (rem != 0) {
        uint64_t remTimesTarget = 0;
        if (!mulChecked(remTimesTarget, rem, targetRate)) {
            return false;
        }
        // round_half_up(p/S) = (2p + S) / (2S)
        uint64_t twiceP = 0;
        uint64_t numer = 0;
        if (!addChecked(twiceP, remTimesTarget, remTimesTarget) ||
            !addChecked(numer, twiceP, sourceRate)) {
            return false;
        }
        remTargets = numer / (2 * static_cast<uint64_t>(sourceRate));
    }
    uint64_t quota = 0;
    if (!addChecked(quota, wholeTargets, remTargets)) {
        return false;
    }
    out = quota < 1 ? 1 : quota;
    return true;
}

// C(N) = min(K(N), ceil((N-1)*T/S)) for T != S: the largest output count whose
// every interpolation window is complete. When the rates are equal every
// frame emits immediately (frac == 0 makes the clamped window exact), so C is
// the full quota and per-packet counts match the pre-fix converter.
bool interpolationEmittableCount(
    uint64_t& out,
    uint64_t inputFrames,
    uint64_t quota,
    UINT32 sourceRate,
    UINT32 targetRate) {
    if (sourceRate == targetRate) {
        out = quota;
        return true;
    }
    const uint64_t prior = inputFrames - 1;
    const uint64_t whole = prior / sourceRate;
    const uint64_t rem = prior % sourceRate;
    uint64_t wholeTargets = 0;
    if (!mulChecked(wholeTargets, whole, targetRate)) {
        return false;
    }
    uint64_t remCeil = 0;
    if (rem != 0) {
        uint64_t remTimesTarget = 0;
        uint64_t numer = 0;
        if (!mulChecked(remTimesTarget, rem, targetRate) ||
            !addChecked(numer, remTimesTarget, sourceRate - 1)) {
            return false;
        }
        remCeil = numer / sourceRate;
    }
    uint64_t emittable = 0;
    if (!addChecked(emittable, wholeTargets, remCeil)) {
        return false;
    }
    out = emittable < quota ? emittable : quota;
    return true;
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
    // The interpolation component resets cold with the integer one. A reset
    // drops any unfinalized resampling tail — at most ceil(T/S + 1/2) output
    // frames, nothing at all on the same-rate path (see the class comment).
    mode_ = Mode::kNone;
    interpolationFinalized_ = false;
    interpolationOverflow_ = false;
    interpolationSourceSubtype_ = {};
    interpolationTargetSubtype_ = {};
    interpolationSourceRate_ = 0;
    interpolationTargetRate_ = 0;
    interpolationSourceChannels_ = 0;
    interpolationTargetChannels_ = 0;
    interpolationSourceBits_ = 0;
    interpolationTargetBits_ = 0;
    interpolationInputFrames_ = 0;
    interpolationEmittedFrames_ = 0;
    interpolationTotalFrames_ = 0;
    interpolationEmittableFrames_ = 0;
    interpolationHistoryBase_ = 0;
    interpolationRetained_.clear();
    interpolationRetained_.shrink_to_fit();
}

void AudioDecimatorState::abandonInterpolation() {
    // A starvation resume is a real-time discontinuity: drop exactly the
    // interpolation component reset() drops (see its comment for the bounded
    // tail this discards) and nothing else — the integer decimation fields
    // (taps_/history_/position_/phase_/factor_/channels_) keep their
    // pre-existing cross-gap behavior, matching the pre-fix mixer.
    if (mode_ != Mode::kInterpolation) {
        return;
    }
    mode_ = Mode::kNone;
    interpolationFinalized_ = false;
    interpolationOverflow_ = false;
    interpolationSourceSubtype_ = {};
    interpolationTargetSubtype_ = {};
    interpolationSourceRate_ = 0;
    interpolationTargetRate_ = 0;
    interpolationSourceChannels_ = 0;
    interpolationTargetChannels_ = 0;
    interpolationSourceBits_ = 0;
    interpolationTargetBits_ = 0;
    interpolationInputFrames_ = 0;
    interpolationEmittedFrames_ = 0;
    interpolationTotalFrames_ = 0;
    interpolationEmittableFrames_ = 0;
    interpolationHistoryBase_ = 0;
    interpolationRetained_.clear();
    interpolationRetained_.shrink_to_fit();
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

bool AudioDecimatorState::prepareInterpolation(
    const AudioInputFormat& source,
    const AudioInputFormat& target) {
    if (interpolationFinalized_ || interpolationOverflow_) {
        // Contract: a finalized (or overflow-parked) stream accepts no more
        // input until reset() or a fresh state object.
        return false;
    }
    if (mode_ == Mode::kInterpolation &&
        source.sampleRate == interpolationSourceRate_ &&
        target.sampleRate == interpolationTargetRate_ &&
        source.channels == interpolationSourceChannels_ &&
        target.channels == interpolationTargetChannels_ &&
        source.bitsPerSample == interpolationSourceBits_ &&
        target.bitsPerSample == interpolationTargetBits_ &&
        IsEqualGUID(source.subtype, interpolationSourceSubtype_) &&
        IsEqualGUID(target.subtype, interpolationTargetSubtype_)) {
        return true;  // the same stream continues across the packet boundary
    }
    if (mode_ == Mode::kInteger) {
        // Entering interpolation from integer decimation clears the integer
        // history and remainder ONCE per transition (the pre-fix code reset
        // per packet; the cross-format cold-start contract is what stays).
        std::fill(history_.begin(), history_.end(), 0.0);
        position_ = 0;
        phase_ = 0;
    }
    mode_ = Mode::kInterpolation;
    interpolationSourceSubtype_ = source.subtype;
    interpolationTargetSubtype_ = target.subtype;
    interpolationSourceRate_ = source.sampleRate;
    interpolationTargetRate_ = target.sampleRate;
    interpolationSourceChannels_ = source.channels;
    interpolationTargetChannels_ = target.channels;
    interpolationSourceBits_ = source.bitsPerSample;
    interpolationTargetBits_ = target.bitsPerSample;
    interpolationInputFrames_ = 0;
    interpolationEmittedFrames_ = 0;
    interpolationTotalFrames_ = 0;
    interpolationEmittableFrames_ = 0;
    interpolationHistoryBase_ = 0;
    interpolationRetained_.clear();
    return true;
}

void AudioDecimatorState::beginIntegerDecimation() {
    if (mode_ == Mode::kInteger) {
        return;
    }
    if (mode_ == Mode::kInterpolation) {
        // Entering integer decimation from interpolation discards the
        // interpolation history and starts the integer filter cold, preserving
        // the cross-format reset contract the suite pins.
        std::fill(history_.begin(), history_.end(), 0.0);
        position_ = 0;
        phase_ = 0;
        interpolationFinalized_ = false;
        interpolationOverflow_ = false;
        interpolationInputFrames_ = 0;
        interpolationEmittedFrames_ = 0;
        interpolationTotalFrames_ = 0;
        interpolationEmittableFrames_ = 0;
        interpolationHistoryBase_ = 0;
        interpolationRetained_.clear();
        interpolationRetained_.shrink_to_fit();
    }
    mode_ = Mode::kInteger;
}

void AudioDecimatorState::appendInterpolationFrame(const double* mappedFrame, UINT32 channels) {
    interpolationRetained_.insert(interpolationRetained_.end(), mappedFrame, mappedFrame + channels);
    interpolationInputFrames_ += 1;
    uint64_t quota = 0;
    if (!interpolationQuota(quota, interpolationInputFrames_, interpolationSourceRate_, interpolationTargetRate_)) {
        interpolationOverflow_ = true;
        return;
    }
    interpolationTotalFrames_ = quota;
    uint64_t emittable = 0;
    if (!interpolationEmittableCount(
            emittable, interpolationInputFrames_, quota, interpolationSourceRate_,
            interpolationTargetRate_)) {
        interpolationOverflow_ = true;
        return;
    }
    interpolationEmittableFrames_ = emittable;
}

size_t AudioDecimatorState::interpolationRetainedFrames() const {
    const UINT32 channels = interpolationTargetChannels_ == 0 ? 1 : interpolationTargetChannels_;
    return interpolationRetained_.size() / channels;
}

double AudioDecimatorState::interpolationRetainedSample(uint64_t absoluteFrame, UINT32 channel) const {
    if (absoluteFrame < interpolationHistoryBase_ || channel >= interpolationTargetChannels_) {
        return 0.0;
    }
    const uint64_t offset =
        (absoluteFrame - interpolationHistoryBase_) * interpolationTargetChannels_ + channel;
    if (offset >= interpolationRetained_.size()) {
        return 0.0;
    }
    return interpolationRetained_[static_cast<size_t>(offset)];
}

void AudioDecimatorState::noteInterpolationEmitted(uint64_t throughFrameCount) {
    if (throughFrameCount > interpolationEmittedFrames_) {
        interpolationEmittedFrames_ = throughFrameCount;
    }
}

void AudioDecimatorState::trimInterpolationHistory() {
    if (mode_ != Mode::kInterpolation || interpolationInputFrames_ == 0) {
        return;
    }
    // The next output the stream owes is `interpolationEmittedFrames_`. The
    // earliest source frame ANY future output can read is
    // floor(next * S / T) (exact rational), minus one frame of allowance for
    // the legacy double-precision index calculation; everything before that is
    // dead. What remains after this trim is bounded by ceil(S/(2T)) + 2 frames
    // (see the class comment) — never by stream length or packet count.
    const uint64_t next = interpolationEmittedFrames_;
    const uint64_t last = interpolationInputFrames_ - 1;
    uint64_t floorPos = 0;
    {
        // floor(next*S/T) via the same decomposition as the quota: the only
        // products formed are (next div T)*S and (next mod T)*S.
        const uint64_t whole = next / interpolationTargetRate_;
        const uint64_t rem = next % interpolationTargetRate_;
        uint64_t wholeTimesSource = 0;
        uint64_t remTimesSource = 0;
        if (!mulChecked(wholeTimesSource, whole, interpolationSourceRate_) ||
            !mulChecked(remTimesSource, rem, interpolationSourceRate_)) {
            return;  // cannot bound safely; stay correct and retain instead
        }
        floorPos = wholeTimesSource + remTimesSource / interpolationTargetRate_;
    }
    if (floorPos > last) {
        floorPos = last;
    }
    const uint64_t keepFrom = floorPos > 0 ? floorPos - 1 : 0;
    if (keepFrom <= interpolationHistoryBase_) {
        return;
    }
    const uint64_t drop = keepFrom - interpolationHistoryBase_;
    const UINT32 channels = interpolationTargetChannels_;
    interpolationRetained_.erase(
        interpolationRetained_.begin(),
        interpolationRetained_.begin() + static_cast<std::ptrdiff_t>(drop * channels));
    interpolationHistoryBase_ = keepFrom;
}

void AudioDecimatorState::markInterpolationFinalized() {
    interpolationFinalized_ = true;
    interpolationRetained_.clear();
    interpolationRetained_.shrink_to_fit();
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
    // One-shot semantics: everything the stream owes, including the deferred
    // tail, in the pre-fix endpoint-clamped order.
    finalizeAudioConversion(targetFormat, gain, destination, discardedDecimator);
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
        // A state that was interpolating starts decimation cold exactly once
        // per transition; a state already decimating keeps its history.
        decimator.beginIntegerDecimation();
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

    // Non-integer (and same-rate cross-subtype) conversion. This branch used
    // to reset `decimator` and restart its phase at every packet, so its output
    // depended on where the packet boundaries fell — 100-frame packets at
    // 48 kHz -> 44.1 kHz turned a 14700-frame stream into 14720 frames, and
    // every sample after the first packet sat at a drifting position (issue
    // #920, item 24). The state now carries the stream: output frame j always
    // uses the ABSOLUTE stream position j / rateRatio with the interpolation
    // arithmetic below unchanged, frames whose window is incomplete are
    // deferred (bounded by ceil(T/S + 1/2)), and finalizeAudioConversion()
    // flushes the tail with the old whole-stream endpoint clamping.
    //
    // Same-rate (T == S) conversion — every ordinary microphone packet, WASAPI
    // float32 against a PCM16 target — emits each frame immediately instead:
    // frac == 0 makes the clamped window exact, so per-packet output counts
    // stay identical to the pre-fix converter and nothing is held back. For
    // every OTHER ratio the uniform deferral applies; an unfinalized tail of
    // at most ceil(T/S + 1/2) frames is dropped by reset() — and therefore by a
    // mixer resume or the end of a take — unless the stream is finalized.
    if (!decimator.prepareInterpolation(sourceFormat, targetFormat)) {
        // Either the active stream was finalized (it accepts no more input
        // until reset() or a fresh state) or its counters overflowed checked
        // arithmetic. Refuse rather than corrupt the stream geometry.
        destination.clear();
        return;
    }
    const UINT32 targetChannels = targetFormat.channels;
    const double rateRatio = static_cast<double>(targetFormat.sampleRate) /
        static_cast<double>(sourceFormat.sampleRate);
    std::vector<double> mapped(targetChannels, 0.0);
    for (size_t sourceFrame = 0; sourceFrame < packetFrames; ++sourceFrame) {
        for (UINT32 channel = 0; channel < targetChannels; ++channel) {
            mapped[channel] = readMappedChannel(
                source, sourceFormat, sourceFrame, channel, targetChannels);
        }
        decimator.appendInterpolationFrame(mapped.data(), targetChannels);
    }
    const uint64_t emittedBefore = decimator.interpolationEmittedFrames();
    const uint64_t emittableNow = decimator.interpolationEmittableFrames();
    if (emittableNow < emittedBefore ||
        emittableNow - emittedBefore > static_cast<uint64_t>(SIZE_MAX) / targetFormat.blockAlign) {
        destination.clear();
        return;
    }
    const size_t newFrames = static_cast<size_t>(emittableNow - emittedBefore);
    destination.assign(newFrames * targetFormat.blockAlign, 0);
    // The old loop, verbatim except that j is the ABSOLUTE stream output index
    // and a/b come from the state's retained (channel-mapped, unscaled) frames
    // instead of a packet-local buffer.
    const size_t lastSourceFrame = static_cast<size_t>(decimator.interpolationInputFrames() - 1);
    for (uint64_t targetFrame = emittedBefore; targetFrame < emittableNow; ++targetFrame) {
        const double sourcePosition = static_cast<double>(targetFrame) / rateRatio;
        const size_t sourceFrame = std::min(lastSourceFrame, static_cast<size_t>(sourcePosition));
        const size_t nextFrame = std::min(lastSourceFrame, sourceFrame + 1);
        const double frac = sourcePosition - static_cast<double>(sourceFrame);
        for (UINT32 channel = 0; channel < targetChannels; ++channel) {
            const double a = decimator.interpolationRetainedSample(sourceFrame, channel);
            const double b = decimator.interpolationRetainedSample(nextFrame, channel);
            writeSampleFromDouble(
                destination.data(),
                targetFormat,
                static_cast<size_t>(targetFrame - emittedBefore),
                channel,
                (a + (b - a) * frac) * gain);
        }
    }
    decimator.noteInterpolationEmitted(emittableNow);
    decimator.trimInterpolationHistory();
}

void finalizeAudioConversion(
    const AudioInputFormat& targetFormat,
    double gain,
    std::vector<BYTE>& destination,
    AudioDecimatorState& decimator) {
    // Only the non-integer interpolation stream has a deferred tail. Same-rate
    // conversion emitted everything immediately and the integer/same-format
    // paths keep their own accounting, so for those this is a no-op that must
    // not touch their remainder/history behavior.
    if (!decimator.interpolationActive() || decimator.interpolationFinalized()) {
        return;
    }
    const uint64_t inputFrames = decimator.interpolationInputFrames();
    const uint64_t totalFrames = decimator.interpolationTotalFrames();
    const uint64_t emittedFrames = decimator.interpolationEmittedFrames();
    if (inputFrames == 0 || totalFrames <= emittedFrames) {
        // An empty stream (or one that owes nothing) finalizes to no bytes.
        decimator.markInterpolationFinalized();
        return;
    }
    if (targetFormat.blockAlign == 0 || targetFormat.channels == 0 ||
        totalFrames - emittedFrames > static_cast<uint64_t>(SIZE_MAX) / targetFormat.blockAlign) {
        decimator.markInterpolationFinalized();
        return;
    }
    const size_t tailFrames = static_cast<size_t>(totalFrames - emittedFrames);
    const size_t tailBytes = tailFrames * targetFormat.blockAlign;
    const size_t existingBytes = destination.size();
    const size_t existingFrames = existingBytes / targetFormat.blockAlign;
    destination.resize(existingBytes + tailBytes, 0);
    // The pre-fix whole-stream computation, verbatim: absolute j, endpoint
    // clamp at the stream's last input frame, the same interpolation
    // expression and operation order as the old one-shot conversion.
    const size_t lastSourceFrame = static_cast<size_t>(inputFrames - 1);
    const double rateRatio = decimator.interpolationRateRatio();
    for (uint64_t targetFrame = emittedFrames; targetFrame < totalFrames; ++targetFrame) {
        const double sourcePosition = static_cast<double>(targetFrame) / rateRatio;
        const size_t sourceFrame = std::min(lastSourceFrame, static_cast<size_t>(sourcePosition));
        const size_t nextFrame = std::min(lastSourceFrame, sourceFrame + 1);
        const double frac = sourcePosition - static_cast<double>(sourceFrame);
        for (UINT32 channel = 0; channel < targetFormat.channels; ++channel) {
            const double a = decimator.interpolationRetainedSample(sourceFrame, channel);
            const double b = decimator.interpolationRetainedSample(nextFrame, channel);
            writeSampleFromDouble(
                destination.data(),
                targetFormat,
                existingFrames + static_cast<size_t>(targetFrame - emittedFrames),
                channel,
                (a + (b - a) * frac) * gain);
        }
    }
    decimator.noteInterpolationEmitted(totalFrames);
    decimator.markInterpolationFinalized();
}

void mixAudioInPlace(
    std::vector<BYTE>& destination,
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format,
    double sourceGain) {
    if (!source || byteCount == 0 || destination.empty()) {
        return;
    }

    const size_t mixByteCount = std::min(destination.size(), static_cast<size_t>(byteCount));

    if (isFloatFormat(format)) {
        auto* output = reinterpret_cast<float*>(destination.data());
        const auto* input = reinterpret_cast<const float*>(source);
        const size_t sampleCount = mixByteCount / sizeof(float);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = static_cast<float>(
                std::clamp(static_cast<double>(output[index]) + static_cast<double>(input[index]) * sourceGain, -1.0, 1.0));
        }
        return;
    }

    if (isPcmFormat(format, 16)) {
        auto* output = reinterpret_cast<int16_t*>(destination.data());
        const auto* input = reinterpret_cast<const int16_t*>(source);
        const size_t sampleCount = mixByteCount / sizeof(int16_t);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = clampTo<int16_t>(
                static_cast<double>(output[index]) + static_cast<double>(input[index]) * sourceGain);
        }
        return;
    }

    if (isPcmFormat(format, 32)) {
        auto* output = reinterpret_cast<int32_t*>(destination.data());
        const auto* input = reinterpret_cast<const int32_t*>(source);
        const size_t sampleCount = mixByteCount / sizeof(int32_t);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = clampTo<int32_t>(
                static_cast<double>(output[index]) + static_cast<double>(input[index]) * sourceGain);
        }
    }
}

namespace {

// How far behind real time AudioMixer writes; see mixLoop. Wider than the capture
// threads' poll jitter with room for a stall, and harmless beyond that: the
// output timeline does not move with it.
// ponytail: absorbs jitter, not clock drift. A device slower than the steady clock
// spends the cushion over a long take, then leaves one gap as it re-anchors;
// resampling each source to the mixer clock is the upgrade if that is ever heard.
constexpr uint32_t MixerCushionMs = 100;

} // namespace

AudioMixer::AudioMixer(
    const AudioInputFormat& format,
    const AudioInputFormat& systemFormat,
    const AudioInputFormat& microphoneFormat,
    bool includeSystem,
    bool includeMicrophone,
    double microphoneGain,
    double systemGain,
    OutputCallback output)
    : format_(format),
      systemFormat_(systemFormat),
      microphoneFormat_(microphoneFormat),
      includeSystem_(includeSystem),
      includeMicrophone_(includeMicrophone),
      microphoneGain_(microphoneGain),
      systemGain_(systemGain),
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
        const MmcssThread mmcss(L"Pro Audio");
        mixLoop();
    });
    return true;
}

void AudioMixer::resetSources() {
    systemQueue_.clear();
    microphoneQueue_.clear();
    systemDecimator_.reset();
    microphoneDecimator_.reset();
    systemStarved_ = false;
    microphoneStarved_ = false;
}

void AudioMixer::beginTimeline() {
    {
        std::scoped_lock lock(mutex_);
        resetSources();
        emittedFrames_ = 0;
        mixedFrames_ = 0;
        timelineStarted_ = true;
        // Here, not when mixLoop next wakes: the video's T0 is taken right after
        // this call, and every millisecond the mixer took to wake would have
        // placed the whole track that much early -- tens of them on a busy machine.
        clockStart_ = std::chrono::steady_clock::now();
        clockAnchored_ = true;
    }
    cv_.notify_all();
}

void AudioMixer::setPaused(bool paused) {
    {
        std::unique_lock lock(mutex_);
        if (paused && !paused_) {
            // The queues still hold what the cushion kept back; mixLoop writes it
            // up to this instant, and the resume clears whatever is left.
            pausedAt_ = std::chrono::steady_clock::now();
            pauseFlushed_ = !timelineStarted_;
        } else if (!paused && paused_) {
            // A resume right behind the pause would otherwise clear the cushion
            // before mixLoop has written it: the last 100 ms of voice before the
            // pause, gone (measured, 80 to 90 ms).
            cv_.wait(lock, [this] { return pauseFlushed_ || stopRequested_.load(); });
            resetSources();
            // Resumed at this instant, where the pause left off: the flush has
            // run, so `emittedFrames_` is the pause point and mixLoop is idle.
            clockStart_ = std::chrono::steady_clock::now() -
                std::chrono::duration_cast<std::chrono::steady_clock::duration>(std::chrono::duration<double>(
                    static_cast<double>(emittedFrames_) / format_.sampleRate));
            clockAnchored_ = true;
        }
        paused_ = paused;
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
        append(systemQueue_, systemStarved_, data, byteCount, systemFormat_, 1.0, systemDecimator_);
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
        // The microphone is stored at unity and `microphoneGain_` is applied by
        // mixLoop inside the sum. Applying it here instead would clamp a hot
        // boosted mic to the rails in PCM16 BEFORE the system stream is mixed
        // in: the queue would hold a flat-topped signal and the mix would add
        // further distortion on top of it, with whatever headroom the opposite
        // polarity of the system stream offered already destroyed.
        append(
            microphoneQueue_, microphoneStarved_, data, byteCount, microphoneFormat_, 1.0,
            microphoneDecimator_);
    }
    cv_.notify_all();
}

void AudioMixer::append(
    std::vector<BYTE>& queue,
    bool& starved,
    const BYTE* data,
    DWORD byteCount,
    const AudioInputFormat& sourceFormat,
    double gain,
    AudioDecimatorState& decimator) {
    if (!data || byteCount == 0) {
        return;
    }

    // A starved source resuming is a real-time discontinuity: the starved
    // branch below re-anchors its packet at now, after padding silence. The
    // cross-packet interpolation stream must not complete deferred windows
    // across the gap with retained pre-gap samples. Integer decimation and
    // every non-interpolating state keep their pre-existing cross-gap
    // behavior; abandonInterpolation() is a no-op there.
    if (starved) {
        decimator.abandonInterpolation();
    }

    convertAudioWithGain(data, byteCount, sourceFormat, format_, gain, gainBuffer_, decimator);
    // A source that ran dry is coming back: loopback after a silence, or a device
    // that stalled for longer than the cushion. Its packet belongs at now, which
    // is as far ahead of what mixLoop has taken as real time is -- the cushion
    // plus however late mixLoop is running, which on a loaded machine is tens of
    // milliseconds. Queued at the front, it would land that much early.
    if (starved) {
        uint64_t lagFrames = 0;
        if (clockAnchored_) {
            const double elapsed =
                std::chrono::duration<double>(std::chrono::steady_clock::now() - clockStart_).count();
            const auto nowFrames = static_cast<uint64_t>(std::max(0.0, elapsed) * format_.sampleRate);
            lagFrames = nowFrames > mixedFrames_ ? nowFrames - mixedFrames_ : 0;
        }
        queue.assign(static_cast<size_t>(lagFrames) * format_.blockAlign, 0);
        starved = false;
    }
    queue.insert(queue.end(), gainBuffer_.begin(), gainBuffer_.end());
}

bool AudioMixer::pop(
    std::vector<BYTE>& queue, bool& starved, std::vector<BYTE>& chunk, size_t byteCount) {
    chunk.assign(byteCount, 0);
    if (queue.size() < byteCount) {
        starved = true;
    }
    if (queue.empty()) {
        return false;
    }

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
 * A cushion behind real time (getopenscreen/openscreen#911). The capture threads
 * poll WASAPI and push whatever has piled up -- every 15.6 ms at the default
 * timer resolution, and later than that on a busy machine -- so a packet can
 * reach its queue after the chunk it belongs to is due. Mixing at real time
 * zero-filled that chunk and the packet played one chunk late: a hole of up to
 * 10 ms in the middle of a continuous voice, heard as crackle. Measured on real
 * takes: ten or more such holes in 25 s. Writing `MixerCushionMs` behind real time
 * gives a late packet that long to arrive. The timestamps do not move -- they
 * still come from `emittedFrames_` -- so the cushion only delays the writing,
 * and a pause or a stop writes what it still holds up to that instant.
 *
 * `clockStart_` is anchored so that `emittedFrames_` always describes the
 * time elapsed since the timeline began; re-deriving it on resume is what lets a
 * pause interrupt the clock without shifting everything recorded after it.
 */
void AudioMixer::mixLoop() {
    const uint32_t chunkFrames = std::max<uint32_t>(1, format_.sampleRate / 100);
    const size_t chunkBytes = static_cast<size_t>(chunkFrames) * format_.blockAlign;
    const uint64_t cushionFrames = static_cast<uint64_t>(format_.sampleRate) * MixerCushionMs / 1000;
    std::vector<BYTE> mixedChunk;
    std::vector<BYTE> sourceChunk;
    // This loop's copy of `clockStart_`, taken under the lock at the top of each
    // pass: beginTimeline and a resume move it from other threads.
    std::chrono::steady_clock::time_point clockStart;

    const auto framesToDuration = [&](uint64_t frames) {
        return std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::duration<double>(static_cast<double>(frames) / format_.sampleRate));
    };
    const auto framesAt = [&](std::chrono::steady_clock::time_point time) {
        const double elapsed = std::chrono::duration<double>(time - clockStart).count();
        return static_cast<uint64_t>(std::max(0.0, elapsed) * format_.sampleRate);
    };

    // Writes every chunk that ends by `targetFrames` -- from the queues where they
    // have data, from silence where they do not, which is what keeps the audio
    // clock pinned to the take rather than to whether anything happened to be
    // playing. False once the output refuses a chunk.
    const auto emitUntil = [&](uint64_t targetFrames) {
        while (emittedFrames_ + chunkFrames <= targetFrames) {
            {
                std::scoped_lock lock(mutex_);
                mixedChunk.assign(chunkBytes, 0);
                if (includeSystem_) {
                    pop(systemQueue_, systemStarved_, sourceChunk, chunkBytes);
                    mixAudioInPlace(
                        mixedChunk, sourceChunk.data(), static_cast<DWORD>(sourceChunk.size()), format_,
                        systemGain_);
                }
                if (includeMicrophone_) {
                    pop(microphoneQueue_, microphoneStarved_, sourceChunk, chunkBytes);
                    mixAudioInPlace(
                        mixedChunk, sourceChunk.data(), static_cast<DWORD>(sourceChunk.size()), format_,
                        microphoneGain_);
                }
                mixedFrames_ = emittedFrames_ + chunkFrames;
            }

            const int64_t timestampHns =
                static_cast<int64_t>((emittedFrames_ * HnsPerSecond) / format_.sampleRate);
            const int64_t durationHns =
                static_cast<int64_t>((static_cast<uint64_t>(chunkFrames) * HnsPerSecond) / format_.sampleRate);
            if (!output_(mixedChunk.data(), static_cast<DWORD>(mixedChunk.size()), timestampHns, durationHns)) {
                stopRequested_ = true;
                return false;
            }
            emittedFrames_ += chunkFrames;
        }
        return true;
    };

    while (true) {
        bool stopping = false;
        bool running = false;
        bool flush = false;
        std::chrono::steady_clock::time_point pausedAt;
        {
            std::unique_lock lock(mutex_);
            cv_.wait_for(lock, std::chrono::milliseconds(20), [&] {
                return stopRequested_.load() || (timelineStarted_ && !paused_);
            });
            stopping = stopRequested_;
            running = timelineStarted_ && !paused_;
            pausedAt = pausedAt_;
            clockStart = clockStart_;
            if (stopping || !running) {
                flush = clockAnchored_;
                clockAnchored_ = false;
            }
        }

        if (stopping || !running) {
            // A pause stops the clock rather than resetting it: the anchor is
            // re-derived from `emittedFrames_` on resume, so what follows keeps
            // the position it would have had -- once the cushion is written up to
            // the pause, which is where that position is. A stop writes it up to
            // now, unless it lands on a pause this loop has not handled yet: the
            // paused span is out of the video, so it stays out of the audio.
            const bool written =
                !flush || emitUntil(framesAt(running ? std::chrono::steady_clock::now() : pausedAt));
            {
                std::scoped_lock lock(mutex_);
                pauseFlushed_ = true;
            }
            cv_.notify_all();
            if (!written || stopping) {
                break;
            }
            continue;
        }

        const uint64_t realFrames = framesAt(std::chrono::steady_clock::now());
        if (!emitUntil(realFrames > cushionFrames ? realFrames - cushionFrames : 0)) {
            break;
        }

        // Woken early by a pause or a stop, so that one writes the cushion out at once.
        std::unique_lock lock(mutex_);
        cv_.wait_until(
            lock, clockStart + framesToDuration(emittedFrames_ + chunkFrames + cushionFrames),
            [&] { return stopRequested_.load() || paused_; });
    }
    // Whatever ended the loop, a resume waiting on the pause flush must not wait
    // for a loop that is gone. Set under the lock, so the wakeup cannot slip
    // between the waiter's check and its sleep.
    {
        std::scoped_lock lock(mutex_);
        pauseFlushed_ = true;
    }
    cv_.notify_all();
}
