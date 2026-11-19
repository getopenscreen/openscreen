#include "audio_sample_utils.h"
#include "realtime_scheduling.h"

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifndef OS920_PRISTINE_REGRESSION
// Test-only line of sight into AudioMixer's queues, via the narrow friendship
// declared in the fixed header (which names ::AudioMixerTestAccess, hence the
// global scope). Defined only in this translation unit; no production API.
struct AudioMixerTestAccess {
    static const std::vector<BYTE>& systemQueue(const AudioMixer& mixer) {
        return mixer.systemQueue_;
    }
    static const std::vector<BYTE>& microphoneQueue(const AudioMixer& mixer) {
        return mixer.microphoneQueue_;
    }
    // P2 starvation-resume tests: put the mixer into exactly the state pop()
    // leaves it in when a source queue runs dry in production, without
    // driving the threaded mixLoop. Read path only for the queues; these
    // setters are the one deliberate state injection.
    static void setSystemStarved(AudioMixer& mixer, bool starved) {
        mixer.systemStarved_ = starved;
    }
    static void setMicrophoneStarved(AudioMixer& mixer, bool starved) {
        mixer.microphoneStarved_ = starved;
    }
};
#endif  // !OS920_PRISTINE_REGRESSION

namespace {

int g_ran = 0;
int g_failed = 0;

constexpr double kTestPi = 3.14159265358979323846;

AudioInputFormat makeFormat(
    GUID subtype,
    UINT32 sampleRate,
    UINT32 channels,
    UINT32 bitsPerSample) {
    AudioInputFormat format{};
    format.subtype = subtype;
    format.sampleRate = sampleRate;
    format.channels = channels;
    format.bitsPerSample = bitsPerSample;
    format.blockAlign = channels * (bitsPerSample / 8);
    format.avgBytesPerSec = sampleRate * format.blockAlign;
    return format;
}

void expect(const char* name, bool ok, const std::string& detail) {
    g_ran += 1;
    if (ok) {
        std::cout << "PASS " << name << "\n";
        return;
    }
    g_failed += 1;
    std::cout << "FAIL " << name << " " << detail << "\n";
}

void skip(const char* name, const std::string& reason) {
    std::cout << "SKIP " << name << " " << reason << "\n";
}

struct TempMp4 {
    std::wstring path;
    explicit TempMp4(std::wstring p) : path(std::move(p)) {
        DeleteFileW(path.c_str());
    }
    ~TempMp4() {
        DeleteFileW(path.c_str());
    }
    TempMp4(const TempMp4&) = delete;
    TempMp4& operator=(const TempMp4&) = delete;
};

std::string describe(const AudioInputFormat& format) {
    return "sampleRate=" + std::to_string(format.sampleRate) +
        " channels=" + std::to_string(format.channels) +
        " bits=" + std::to_string(format.bitsPerSample);
}

std::wstring tempMp4Path() {
    wchar_t dir[MAX_PATH]{};
    GetTempPathW(MAX_PATH, dir);
    return std::wstring(dir) + L"openscreen-mf-aac-probe-" +
        std::to_wstring(GetCurrentProcessId()) + L".mp4";
}

HRESULT trySetAacPcmRate(UINT32 sampleRate, IMFAttributes* attributes = nullptr) {
    TempMp4 tmp(tempMp4Path());

    Microsoft::WRL::ComPtr<IMFSinkWriter> writer;
    HRESULT hr = MFCreateSinkWriterFromURL(tmp.path.c_str(), nullptr, attributes, &writer);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> outputType;
    hr = MFCreateMediaType(&outputType);
    if (FAILED(hr)) {
        return hr;
    }
    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    outputType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
    outputType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
    outputType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
    outputType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    outputType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000);
    outputType->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE, 0);

    DWORD streamIndex = 0;
    hr = writer->AddStream(outputType.Get(), &streamIndex);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> inputType;
    hr = MFCreateMediaType(&inputType);
    if (FAILED(hr)) {
        return hr;
    }
    inputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    inputType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
    inputType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
    inputType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
    inputType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    inputType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 4);
    inputType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, sampleRate * 4);
    inputType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);

    hr = writer->SetInputMediaType(streamIndex, inputType.Get(), nullptr);
    writer.Reset();
    return hr;
}

// Same rates as trySetAacPcmRate, but with an H.264 stream first — the helper's
// topology. Distinguishes "96 kHz AAC is illegal" from "audio-only MP4 sink
// writer refuses this type".
HRESULT trySetAacPcmRateWithVideo(UINT32 sampleRate) {
    TempMp4 tmp(tempMp4Path());

    Microsoft::WRL::ComPtr<IMFSinkWriter> writer;
    HRESULT hr = MFCreateSinkWriterFromURL(tmp.path.c_str(), nullptr, nullptr, &writer);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> videoOut;
    hr = MFCreateMediaType(&videoOut);
    if (FAILED(hr)) {
        return hr;
    }
    videoOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    videoOut->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    videoOut->SetUINT32(MF_MT_AVG_BITRATE, 1'000'000);
    videoOut->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    MFSetAttributeSize(videoOut.Get(), MF_MT_FRAME_SIZE, 320, 240);
    MFSetAttributeRatio(videoOut.Get(), MF_MT_FRAME_RATE, 30, 1);
    MFSetAttributeRatio(videoOut.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);

    DWORD videoIndex = 0;
    hr = writer->AddStream(videoOut.Get(), &videoIndex);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> audioOut;
    hr = MFCreateMediaType(&audioOut);
    if (FAILED(hr)) {
        return hr;
    }
    audioOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    audioOut->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
    audioOut->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
    audioOut->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
    audioOut->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    audioOut->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000);
    audioOut->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE, 0);

    DWORD audioIndex = 0;
    hr = writer->AddStream(audioOut.Get(), &audioIndex);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> videoIn;
    hr = MFCreateMediaType(&videoIn);
    if (FAILED(hr)) {
        return hr;
    }
    videoIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    videoIn->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    videoIn->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    videoIn->SetUINT32(MF_MT_DEFAULT_STRIDE, 320 * 4);
    MFSetAttributeSize(videoIn.Get(), MF_MT_FRAME_SIZE, 320, 240);
    MFSetAttributeRatio(videoIn.Get(), MF_MT_FRAME_RATE, 30, 1);
    MFSetAttributeRatio(videoIn.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    hr = writer->SetInputMediaType(videoIndex, videoIn.Get(), nullptr);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> audioIn;
    hr = MFCreateMediaType(&audioIn);
    if (FAILED(hr)) {
        return hr;
    }
    audioIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    audioIn->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
    audioIn->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
    audioIn->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
    audioIn->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    audioIn->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 4);
    audioIn->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, sampleRate * 4);
    audioIn->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    hr = writer->SetInputMediaType(audioIndex, audioIn.Get(), nullptr);
    writer.Reset();
    return hr;
}

// --- issue #920, item 24: packet-boundary continuity of non-integer resampling
//
// The non-integer branch of convertAudioWithGain used to reset its state and
// restart its phase at every packet, so the same signal produced different
// output depending on where the packet boundaries fell (14720 vs 14700 frames
// for a 16000-frame 48 kHz -> 44.1 kHz stream in 100-frame packets). These
// tests pin the fixed contract:
//
//   * identical input prefixes produce identical output prefixes regardless
//     of the partition, and a finalized stream equals the one-shot conversion
//     byte for byte at the globally rounded frame count;
//   * exact-multiple geometry (160/480-frame packets at 48 kHz -> 44.1 kHz)
//     keeps its old bytes: packetized output equals both the one-shot
//     conversion and a test-only reference that replicates the pre-fix
//     whole-stream arithmetic;
//   * the deferral ahead of finalization is bounded (<= 2 output frames for
//     48 kHz <-> 44.1 kHz; the general bound is ceil(T/S + 1/2));
//   * same-rate cross-subtype conversion (the production microphone shape)
//     emits every frame immediately, so per-packet output counts match the old
//     converter and nothing is held back;
//   * the mixer keeps independent per-stream resampler state across
//     pause/resume.
//
// Under OS920_PRISTINE_REGRESSION this file is compiled beside the PRISTINE
// (pre-fix) header and implementation: everything that needs the fixed header
// -- finalizeAudioConversion, the interpolation-state accessors and the
// AudioMixerTestAccess mixer tests -- is compiled out, and what remains fails
// the old code by assertion (build exit 0, test exit 1) while the exact-
// multiple (B/C) and same-rate controls still pass on it.

std::vector<BYTE> monoFloatSine(UINT32 rate, double freq, double amplitude, size_t frames) {
    std::vector<BYTE> bytes(frames * 4, 0);
    auto* samples = reinterpret_cast<float*>(bytes.data());
    for (size_t i = 0; i < frames; i += 1) {
        samples[i] = static_cast<float>(
            amplitude * std::sin(2.0 * kTestPi * freq * static_cast<double>(i) / rate));
    }
    return bytes;
}

// A different frequency per channel, so a channel-mapping or gain-order
// regression cannot hide behind identical channels.
std::vector<BYTE> stereoFloatDualSine(
    UINT32 rate, double leftHz, double rightHz, double amplitude, size_t frames) {
    std::vector<BYTE> bytes(frames * 8, 0);
    auto* samples = reinterpret_cast<float*>(bytes.data());
    for (size_t i = 0; i < frames; i += 1) {
        const double t = static_cast<double>(i) / rate;
        samples[i * 2] = static_cast<float>(amplitude * std::sin(2.0 * kTestPi * leftHz * t));
        samples[i * 2 + 1] = static_cast<float>(amplitude * std::sin(2.0 * kTestPi * rightHz * t));
    }
    return bytes;
}

// Abrupt level changes and zero stretches: a smooth sine lets a boundary
// error hide inside interpolation error, an abrupt change cannot.
std::vector<BYTE> monoFloatAbrupt(UINT32 rate, size_t frames) {
    std::vector<BYTE> bytes(frames * 4, 0);
    auto* samples = reinterpret_cast<float*>(bytes.data());
    for (size_t i = 0; i < frames; i += 1) {
        const size_t phase = i % 1000;
        double v = 0.0;
        if (phase < 250) {
            v = 0.9;
        } else if (phase < 500) {
            v = 0.0;
        } else if (phase < 750) {
            v = -0.8;
        } else {
            v = 0.4 * std::sin(2.0 * kTestPi * 3000.0 * static_cast<double>(i) / rate);
        }
        samples[i] = static_cast<float>(v);
    }
    return bytes;
}

// Test-only reference: the PRE-FIX whole-stream (one-shot) conversion,
// replicated here so expected bytes come from the documented old arithmetic --
// per-stream llround frame count, endpoint clamp at the last source frame,
// linear interpolation with the old operation order, the old PCM16/float
// quantization and clamping -- and never from the converter under test.
// Sources are float32 (mono or stereo); targets PCM16 or float32, mono or
// stereo.
namespace legacy {

double readSample(const BYTE* src, const AudioInputFormat& f, size_t frame, UINT32 ch) {
    const size_t offset = frame * f.blockAlign + ch * (f.bitsPerSample / 8);
    return static_cast<double>(*reinterpret_cast<const float*>(src + offset));
}

double mappedChannel(
    const BYTE* src, const AudioInputFormat& f, size_t frame, UINT32 targetCh, UINT32 targetChannels) {
    if (f.channels == 0) {
        return 0.0;
    }
    if (f.channels == targetChannels && targetCh < f.channels) {
        return readSample(src, f, frame, targetCh);
    }
    if (f.channels == 1) {
        return readSample(src, f, frame, 0);
    }
    if (targetChannels == 1) {
        double sum = 0.0;
        for (UINT32 ch = 0; ch < f.channels; ++ch) {
            sum += readSample(src, f, frame, ch);
        }
        return sum / f.channels;
    }
    return readSample(src, f, frame, std::min(targetCh, f.channels - 1));
}

void writeSample(BYTE* dst, const AudioInputFormat& f, size_t frame, UINT32 ch, double value) {
    const double clamped = std::clamp(value, -1.0, 1.0);
    const size_t offset = frame * f.blockAlign + ch * (f.bitsPerSample / 8);
    if (f.subtype == MFAudioFormat_Float && f.bitsPerSample == 32) {
        *reinterpret_cast<float*>(dst + offset) = static_cast<float>(clamped);
        return;
    }
    *reinterpret_cast<int16_t*>(dst + offset) = static_cast<int16_t>(
        std::clamp(std::round(clamped * 32767.0), -32768.0, 32767.0));
}

std::vector<BYTE> oneShot(
    const std::vector<BYTE>& input,
    const AudioInputFormat& src,
    const AudioInputFormat& dst,
    double gain) {
    const size_t sourceFrames = input.size() / src.blockAlign;
    if (sourceFrames == 0) {
        return {};
    }
    const double rateRatio = static_cast<double>(dst.sampleRate) / static_cast<double>(src.sampleRate);
    const size_t targetFrames = std::max<size_t>(
        1, static_cast<size_t>(std::llround(static_cast<double>(sourceFrames) * rateRatio)));
    std::vector<BYTE> out(targetFrames * dst.blockAlign, 0);
    for (size_t j = 0; j < targetFrames; ++j) {
        const double sourcePosition = static_cast<double>(j) / rateRatio;
        const size_t sourceFrame = std::min(sourceFrames - 1, static_cast<size_t>(sourcePosition));
        const size_t nextFrame = std::min(sourceFrames - 1, sourceFrame + 1);
        const double frac = sourcePosition - static_cast<double>(sourceFrame);
        for (UINT32 ch = 0; ch < dst.channels; ++ch) {
            const double a = mappedChannel(input.data(), src, sourceFrame, ch, dst.channels);
            const double b = mappedChannel(input.data(), src, nextFrame, ch, dst.channels);
            writeSample(out.data(), dst, j, ch, (a + (b - a) * frac) * gain);
        }
    }
    return out;
}

}  // namespace legacy

// Expected global counts, computed test-side with plain 64-bit integer
// arithmetic (fixture magnitudes sit far below any overflow):
// K(N) = max(1, round_half_up(N*T/S)) and C(N) = min(K(N), ceil((N-1)*T/S)),
// with C(N) = K(N) when the rates are equal (immediate emission). These are
// the documented quota definitions, applied independently of the converter.
uint64_t ratioRoundHalfUp(uint64_t n, uint64_t t, uint64_t s) {
    return (2 * n * t + s) / (2 * s);
}

uint64_t ratioCeil(uint64_t m, uint64_t t, uint64_t s) {
    return (m * t + s - 1) / s;
}

uint64_t expectedQuota(uint64_t inputFrames, UINT32 sourceRate, UINT32 targetRate) {
    const uint64_t k = ratioRoundHalfUp(inputFrames, targetRate, sourceRate);
    return k < 1 ? 1 : k;
}

uint64_t expectedEmittable(uint64_t inputFrames, UINT32 sourceRate, UINT32 targetRate) {
    const uint64_t k = expectedQuota(inputFrames, sourceRate, targetRate);
    if (sourceRate == targetRate) {
        return k;
    }
    const uint64_t c = ratioCeil(inputFrames - 1, targetRate, sourceRate);
    return c < k ? c : k;
}

// ceil(T/S + 1/2): the general deferral bound for a rate pair.
size_t pendingBoundFor(UINT32 sourceRate, UINT32 targetRate) {
    return static_cast<size_t>((2 * uint64_t(targetRate) + sourceRate + 2 * uint64_t(sourceRate) - 1) /
        (2 * uint64_t(sourceRate)));
}

// ceil(S/(2T)) + 2: the conservative retained-history bound once a packet's
// emission has settled (one frame of the allowance is for the legacy
// double-precision index calculation).
size_t retainedBoundFor(UINT32 sourceRate, UINT32 targetRate) {
    return static_cast<size_t>((uint64_t(sourceRate) + 2 * targetRate - 1) / (2 * uint64_t(targetRate))) + 2;
}

struct PartitionRun {
    std::vector<BYTE> output;
    std::vector<size_t> perPacketFrames;
};

// Feeds `input` through the STATEFUL converter in packets whose sizes cycle
// through `sizes` (the last packet may be partial). With finalizeAtEnd the
// deferred tail is flushed through finalizeAudioConversion (fixed builds
// only; the pristine build has no finalizer and its packetized output is
// already its full output).
PartitionRun runPartitioned(
    const std::vector<BYTE>& input,
    const AudioInputFormat& src,
    const AudioInputFormat& dst,
    double gain,
    const std::vector<size_t>& sizes,
    size_t totalFrames,
    bool finalizeAtEnd) {
    PartitionRun run;
    AudioDecimatorState state;
    std::vector<BYTE> piece;
    size_t cursor = 0;
    size_t index = 0;
    while (cursor < totalFrames) {
        const size_t frames = std::min(sizes[index % sizes.size()], totalFrames - cursor);
        index += 1;
        convertAudioWithGain(
            input.data() + cursor * src.blockAlign,
            static_cast<DWORD>(frames * src.blockAlign),
            src,
            dst,
            gain,
            piece,
            state);
        run.perPacketFrames.push_back(dst.blockAlign == 0 ? 0 : piece.size() / dst.blockAlign);
        run.output.insert(run.output.end(), piece.begin(), piece.end());
        cursor += frames;
    }
#ifndef OS920_PRISTINE_REGRESSION
    if (finalizeAtEnd) {
        piece.clear();
        finalizeAudioConversion(dst, gain, piece, state);
        if (!piece.empty()) {
            run.perPacketFrames.back() += dst.blockAlign == 0 ? 0 : piece.size() / dst.blockAlign;
            run.output.insert(run.output.end(), piece.begin(), piece.end());
        }
    }
#else
    (void)finalizeAtEnd;
#endif
    return run;
}

bool isBytePrefix(const std::vector<BYTE>& prefix, const std::vector<BYTE>& whole) {
    return prefix.size() <= whole.size() &&
        std::equal(prefix.begin(), prefix.end(), whole.begin());
}

std::string frameCountOf(const std::vector<BYTE>& bytes, const AudioInputFormat& f) {
    return std::to_string(f.blockAlign == 0 ? 0 : bytes.size() / f.blockAlign);
}

void runResampleContinuityCoreTests() {
    const AudioInputFormat src48f = makeFormat(MFAudioFormat_Float, 48000, 1, 32);
    const AudioInputFormat dst44p = makeFormat(MFAudioFormat_PCM, 44100, 1, 16);
    const AudioInputFormat src44f = makeFormat(MFAudioFormat_Float, 44100, 1, 32);
    const AudioInputFormat dst48p = makeFormat(MFAudioFormat_PCM, 48000, 1, 16);
    const std::vector<size_t> raggedSizes = {1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 100, 159, 160, 480};

    const std::vector<BYTE> signalA = monoFloatSine(48000, 997.0, 0.5, 16000);
    const std::vector<BYTE> signalD = monoFloatSine(44100, 997.0, 0.5, 14700);
    std::vector<BYTE> oneA;
    convertAudioWithGain(
        signalA.data(), static_cast<DWORD>(signalA.size()), src48f, dst44p, 1.0, oneA);
    std::vector<BYTE> oneD;
    convertAudioWithGain(
        signalD.data(), static_cast<DWORD>(signalD.size()), src44f, dst48p, 1.0, oneD);

    // The one-shot conversions must keep their old bytes, checked against the
    // test-only legacy reference -- never against a packetized path.
    expect(
        "os920-a-one-shot-matches-legacy-reference",
        oneA == legacy::oneShot(signalA, src48f, dst44p, 1.0),
        "frames=" + frameCountOf(oneA, dst44p));
    expect(
        "os920-d-one-shot-matches-legacy-reference",
        oneD == legacy::oneShot(signalD, src44f, dst48p, 1.0),
        "frames=" + frameCountOf(oneD, dst48p));

    // A: 48 kHz -> 44.1 kHz in 100-frame packets (91.875 expected frames per
    // packet; the old per-packet llround made 92, +0.125 frames/packet).
    {
        const PartitionRun run = runPartitioned(signalA, src48f, dst44p, 1.0, {100}, 16000, false);
        expect(
            "os920-a-packetized-prefix-matches-one-shot",
            isBytePrefix(run.output, oneA),
            "frames=" + frameCountOf(run.output, dst44p) + " of " + frameCountOf(oneA, dst44p));
        expect(
            "os920-a-packetized-frame-count",
            run.output.size() / dst44p.blockAlign == 14700,
            "frames=" + frameCountOf(run.output, dst44p));
    }

    // Controls B/C: exact-multiple geometry keeps the old bytes, packetized
    // equal to one-shot AND to the legacy reference.
    {
        const PartitionRun b = runPartitioned(signalA, src48f, dst44p, 1.0, {160}, 16000, false);
        expect(
            "os920-b-160-frame-packets-equal-one-shot",
            b.output == oneA,
            "frames=" + frameCountOf(b.output, dst44p));
        expect(
            "os920-b-160-frame-packets-match-legacy-reference",
            b.output == legacy::oneShot(signalA, src48f, dst44p, 1.0),
            "frames=" + frameCountOf(b.output, dst44p));
        const PartitionRun c = runPartitioned(signalA, src48f, dst44p, 1.0, {480}, 16000, false);
        expect(
            "os920-c-480-frame-packets-equal-one-shot",
            c.output == oneA,
            "frames=" + frameCountOf(c.output, dst44p));
        expect(
            "os920-c-480-frame-packets-match-legacy-reference",
            c.output == legacy::oneShot(signalA, src48f, dst44p, 1.0),
            "frames=" + frameCountOf(c.output, dst44p));
    }

    // D: 44.1 kHz -> 48 kHz upsample in 100-frame packets (108.844 expected
    // frames per packet; the old rounding error here is ~0.1565 frames/packet,
    // a different geometry from A's).
    {
        const PartitionRun d = runPartitioned(signalD, src44f, dst48p, 1.0, {100}, 14700, false);
        expect(
            "os920-d-packetized-prefix-matches-one-shot",
            isBytePrefix(d.output, oneD),
            "frames=" + frameCountOf(d.output, dst48p) + " of " + frameCountOf(oneD, dst48p));
    }

    // Ragged streams in both directions over a deliberately non-ratio-aligned
    // total, with abrupt changes and zero stretches so boundary errors cannot
    // hide in a smooth sine.
    {
        const std::vector<BYTE> rag48 = monoFloatAbrupt(48000, 7777);
        const std::vector<BYTE> rag44 = monoFloatAbrupt(44100, 7777);
        std::vector<BYTE> oneR48;
        convertAudioWithGain(
            rag48.data(), static_cast<DWORD>(rag48.size()), src48f, dst44p, 1.0, oneR48);
        std::vector<BYTE> oneR44;
        convertAudioWithGain(
            rag44.data(), static_cast<DWORD>(rag44.size()), src44f, dst48p, 1.0, oneR44);
        const PartitionRun r1 = runPartitioned(rag48, src48f, dst44p, 1.0, raggedSizes, 7777, false);
        expect(
            "os920-ragged-48-to-44-prefix-matches-one-shot",
            isBytePrefix(r1.output, oneR48),
            "frames=" + frameCountOf(r1.output, dst44p) + " of " + frameCountOf(oneR48, dst44p));
        const PartitionRun r2 = runPartitioned(rag44, src44f, dst48p, 1.0, raggedSizes, 7777, false);
        expect(
            "os920-ragged-44-to-48-prefix-matches-one-shot",
            isBytePrefix(r2.output, oneR44),
            "frames=" + frameCountOf(r2.output, dst48p) + " of " + frameCountOf(oneR44, dst48p));
    }

    // Rounding and endpoint totals: one-frame packets across totals that
    // bracket the rounding boundaries. The old per-packet minimum of one frame
    // accumulated (80 one-frame packets at 48 kHz -> 44.1 kHz produced 80
    // frames for a 74-frame stream); the fixed converter owes only the global
    // quota, and every emitted frame must sit at its absolute stream position.
    {
        const size_t totals[] = {1, 2, 3, 79, 80, 81, 99, 100, 101, 159, 160, 161};
        const std::vector<BYTE> master48 = monoFloatSine(48000, 997.0, 0.5, 161);
        const std::vector<BYTE> master44 = monoFloatSine(44100, 997.0, 0.5, 161);
        bool ok48 = true;
        bool ok44 = true;
        std::string detail48;
        std::string detail44;
        for (size_t n : totals) {
            std::vector<BYTE> in48(
                master48.begin(), master48.begin() + static_cast<std::ptrdiff_t>(n) * src48f.blockAlign);
            std::vector<BYTE> one;
            convertAudioWithGain(
                in48.data(), static_cast<DWORD>(in48.size()), src48f, dst44p, 1.0, one);
            const PartitionRun run = runPartitioned(in48, src48f, dst44p, 1.0, {1}, n, false);
            if (!isBytePrefix(run.output, one)) {
                ok48 = false;
                detail48 += "n" + std::to_string(n) + ":" + frameCountOf(run.output, dst44p) +
                    "/" + frameCountOf(one, dst44p) + " ";
            }
            std::vector<BYTE> in44(
                master44.begin(), master44.begin() + static_cast<std::ptrdiff_t>(n) * src44f.blockAlign);
            std::vector<BYTE> oneUp;
            convertAudioWithGain(
                in44.data(), static_cast<DWORD>(in44.size()), src44f, dst48p, 1.0, oneUp);
            const PartitionRun runUp = runPartitioned(in44, src44f, dst48p, 1.0, {1}, n, false);
            if (!isBytePrefix(runUp.output, oneUp)) {
                ok44 = false;
                detail44 += "n" + std::to_string(n) + ":" + frameCountOf(runUp.output, dst48p) +
                    "/" + frameCountOf(oneUp, dst48p) + " ";
            }
        }
        expect("os920-rounding-totals-1-frame-packets-prefix-48-to-44", ok48, detail48);
        expect("os920-rounding-totals-1-frame-packets-prefix-44-to-48", ok44, detail44);
    }

    // Formats and gain: distinct-channel float32 input, PCM16 and float32
    // targets, fixed gains 1.0 and 0.5, stereo->stereo, stereo->mono downmix
    // and mono->stereo upmix, all through ragged packets of a non-integer
    // ratio. Partition equality must hold without altered mapping, gain order
    // or clipping.
    {
        const AudioInputFormat src44stereo = makeFormat(MFAudioFormat_Float, 44100, 2, 32);
        const std::vector<BYTE> stereo = stereoFloatDualSine(44100, 997.0, 501.0, 0.5, 3000);
        struct FormatCase {
            const char* name;
            AudioInputFormat dst;
            double gain;
        };
        const FormatCase cases[] = {
            {"pcm16-stereo", makeFormat(MFAudioFormat_PCM, 48000, 2, 16), 1.0},
            {"pcm16-stereo-half-gain", makeFormat(MFAudioFormat_PCM, 48000, 2, 16), 0.5},
            {"float32-stereo", makeFormat(MFAudioFormat_Float, 48000, 2, 32), 1.0},
            {"pcm16-mono-downmix", makeFormat(MFAudioFormat_PCM, 48000, 1, 16), 1.0},
            {"pcm16-mono-downmix-half-gain", makeFormat(MFAudioFormat_PCM, 48000, 1, 16), 0.5},
        };
        bool allPrefix = true;
        bool allRef = true;
        std::string detail;
        for (const FormatCase& c : cases) {
            std::vector<BYTE> one;
            convertAudioWithGain(
                stereo.data(), static_cast<DWORD>(stereo.size()), src44stereo, c.dst, c.gain, one);
            const PartitionRun run =
                runPartitioned(stereo, src44stereo, c.dst, c.gain, raggedSizes, 3000, false);
            if (!isBytePrefix(run.output, one)) {
                allPrefix = false;
                detail += std::string(c.name) + ":" + frameCountOf(run.output, c.dst) + "/" +
                    frameCountOf(one, c.dst) + " ";
            }
            if (one != legacy::oneShot(stereo, src44stereo, c.dst, c.gain)) {
                allRef = false;
                detail += std::string(c.name) + ":ref ";
            }
        }
        expect("os920-formats-gain-ragged-prefix-matches-one-shot", allPrefix, detail);
        expect("os920-formats-gain-one-shot-matches-legacy-reference", allRef, detail);

        const std::vector<BYTE> mono = monoFloatSine(44100, 777.0, 0.5, 2500);
        const AudioInputFormat dstStereoUp = makeFormat(MFAudioFormat_PCM, 48000, 2, 16);
        std::vector<BYTE> oneUp;
        convertAudioWithGain(
            mono.data(), static_cast<DWORD>(mono.size()), src44f, dstStereoUp, 1.0, oneUp);
        const PartitionRun runUp =
            runPartitioned(mono, src44f, dstStereoUp, 1.0, raggedSizes, 2500, false);
        expect(
            "os920-mono-to-stereo-ragged-prefix-matches-one-shot",
            isBytePrefix(runUp.output, oneUp),
            "frames=" + frameCountOf(runUp.output, dstStereoUp) + " of " +
                frameCountOf(oneUp, dstStereoUp));
        expect(
            "os920-mono-to-stereo-one-shot-matches-legacy-reference",
            oneUp == legacy::oneShot(mono, src44f, dstStereoUp, 1.0),
            "frames=" + frameCountOf(oneUp, dstStereoUp));
    }

    // Same-rate cross-subtype conversion (the production microphone shape:
    // WASAPI float32 against a PCM16 target fails sameAudioFormatForMixing on
    // subtype alone). The packetized stream equals the one-shot conversion
    // byte for byte -- on the fixed build because same-rate frames emit
    // immediately, and on the old build because each packet's local phase
    // restart is exact here (frac == 0). Per-packet counts must equal the old
    // converter's own (480 frames out per 480 in, on both builds).
    {
        const AudioInputFormat src48stereo = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        const AudioInputFormat dst48pcm = makeFormat(MFAudioFormat_PCM, 48000, 2, 16);
        const std::vector<BYTE> mic = stereoFloatDualSine(48000, 997.0, 503.0, 0.5, 5000);
        std::vector<BYTE> one;
        convertAudioWithGain(
            mic.data(), static_cast<DWORD>(mic.size()), src48stereo, dst48pcm, 1.0, one);
        const PartitionRun rag =
            runPartitioned(mic, src48stereo, dst48pcm, 1.0, raggedSizes, 5000, false);
        expect(
            "os920-same-rate-packetized-equals-one-shot",
            rag.output == one,
            "frames=" + frameCountOf(rag.output, dst48pcm));
        expect(
            "os920-same-rate-one-shot-matches-legacy-reference",
            one == legacy::oneShot(mic, src48stereo, dst48pcm, 1.0),
            "frames=" + frameCountOf(one, dst48pcm));
        const PartitionRun p480 = runPartitioned(mic, src48stereo, dst48pcm, 1.0, {480}, 5000, false);
        bool countsOk = p480.perPacketFrames.size() == 11;
        for (size_t i = 0; countsOk && i < p480.perPacketFrames.size(); i += 1) {
            countsOk = p480.perPacketFrames[i] == (i < 10 ? 480 : 200);
        }
        expect(
            "os920-same-rate-per-packet-counts-match-old-converter",
            countsOk,
            "packets=" + std::to_string(p480.perPacketFrames.size()));
    }
}

#ifndef OS920_PRISTINE_REGRESSION
void runResampleContinuityFixedTests() {
    const AudioInputFormat src48f = makeFormat(MFAudioFormat_Float, 48000, 1, 32);
    const AudioInputFormat dst44p = makeFormat(MFAudioFormat_PCM, 44100, 1, 16);
    const AudioInputFormat src44f = makeFormat(MFAudioFormat_Float, 44100, 1, 32);
    const AudioInputFormat dst48p = makeFormat(MFAudioFormat_PCM, 48000, 1, 16);
    const std::vector<size_t> raggedSizes = {1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 100, 159, 160, 480};

    const std::vector<BYTE> signalA = monoFloatSine(48000, 997.0, 0.5, 16000);
    const std::vector<BYTE> signalD = monoFloatSine(44100, 997.0, 0.5, 14700);
    std::vector<BYTE> oneA;
    convertAudioWithGain(
        signalA.data(), static_cast<DWORD>(signalA.size()), src48f, dst44p, 1.0, oneA);
    std::vector<BYTE> oneD;
    convertAudioWithGain(
        signalD.data(), static_cast<DWORD>(signalD.size()), src44f, dst48p, 1.0, oneD);

    // A: intermediate-prefix accounting and the bounds after EVERY packet, not
    // just at stream end; then byte equality with the one-shot conversion
    // (case A has no tail: C(16000) == K(16000) == 14700).
    {
        const UINT32 S = 48000;
        const UINT32 T = 44100;
        const size_t pendingBound = pendingBoundFor(S, T);
        const size_t retainedBound = retainedBoundFor(S, T);
        AudioDecimatorState state;
        std::vector<BYTE> piece;
        std::vector<BYTE> all;
        size_t cumulative = 0;
        bool okCounts = true;
        bool okPending = true;
        bool okRetained = true;
        uint64_t worstPending = 0;
        std::string detail;
        for (size_t packet = 0; packet < 160; packet += 1) {
            convertAudioWithGain(
                signalA.data() + packet * 100 * src48f.blockAlign,
                static_cast<DWORD>(100 * src48f.blockAlign),
                src48f,
                dst44p,
                1.0,
                piece,
                state);
            cumulative += piece.size() / dst44p.blockAlign;
            all.insert(all.end(), piece.begin(), piece.end());
            const uint64_t n = static_cast<uint64_t>(packet + 1) * 100;
            const uint64_t wantC = expectedEmittable(n, S, T);
            if (cumulative != wantC) {
                okCounts = false;
                detail += "n" + std::to_string(n) + " got " + std::to_string(cumulative) + " want " +
                    std::to_string(wantC) + " ";
            }
            worstPending = std::max(worstPending, state.interpolationPendingFrames());
            okPending = okPending && state.interpolationPendingFrames() <= pendingBound;
            okRetained = okRetained && state.interpolationRetainedFrames() <= retainedBound;
        }
        detail += "worstPending=" + std::to_string(worstPending);
        expect("os920-a-intermediate-prefix-accounting", okCounts, detail);
        expect("os920-a-pending-output-bound", okPending, detail);
        expect("os920-a-retained-history-bound", okRetained, detail);
        std::vector<BYTE> tail;
        finalizeAudioConversion(dst44p, 1.0, tail, state);
        all.insert(all.end(), tail.begin(), tail.end());
        expect(
            "os920-a-unfinalized-14700-and-finalize-empty-equals-one-shot",
            cumulative == 14700 && tail.empty() && all == oneA,
            "cumulative=" + std::to_string(cumulative) + " tail=" + std::to_string(tail.size()));
    }

    // D: the same walk; the documented 15999-frame unfinalized prefix and the
    // 16000-frame finalized equality, plus the finalization lifecycle.
    {
        const UINT32 S = 44100;
        const UINT32 T = 48000;
        const size_t pendingBound = pendingBoundFor(S, T);
        const size_t retainedBound = retainedBoundFor(S, T);
        AudioDecimatorState state;
        std::vector<BYTE> piece;
        std::vector<BYTE> all;
        size_t cumulative = 0;
        bool okCounts = true;
        bool okPending = true;
        bool okRetained = true;
        std::string detail;
        for (size_t packet = 0; packet < 147; packet += 1) {
            convertAudioWithGain(
                signalD.data() + packet * 100 * src44f.blockAlign,
                static_cast<DWORD>(100 * src44f.blockAlign),
                src44f,
                dst48p,
                1.0,
                piece,
                state);
            cumulative += piece.size() / dst48p.blockAlign;
            all.insert(all.end(), piece.begin(), piece.end());
            const uint64_t n = static_cast<uint64_t>(packet + 1) * 100;
            const uint64_t wantC = expectedEmittable(n, S, T);
            if (cumulative != wantC) {
                okCounts = false;
                detail += "n" + std::to_string(n) + " got " + std::to_string(cumulative) + " want " +
                    std::to_string(wantC) + " ";
            }
            okPending = okPending && state.interpolationPendingFrames() <= pendingBound;
            okRetained = okRetained && state.interpolationRetainedFrames() <= retainedBound;
        }
        expect("os920-d-intermediate-prefix-accounting", okCounts, detail);
        expect("os920-d-pending-output-bound", okPending, detail);
        expect("os920-d-retained-history-bound", okRetained, detail);
        expect(
            "os920-d-unfinalized-prefix-is-15999",
            cumulative == 15999,
            "cumulative=" + std::to_string(cumulative));
        piece.clear();
        finalizeAudioConversion(dst48p, 1.0, piece, state);
        all.insert(all.end(), piece.begin(), piece.end());
        expect(
            "os920-d-finalized-equals-one-shot-16000",
            piece.size() / dst48p.blockAlign == 1 && all.size() / dst48p.blockAlign == 16000 &&
                all == oneD,
            "tail=" + std::to_string(piece.size() / dst48p.blockAlign) + " total=" +
                std::to_string(all.size() / dst48p.blockAlign));
        // Repeated finalization returns no additional bytes.
        std::vector<BYTE> again;
        finalizeAudioConversion(dst48p, 1.0, again, state);
        expect("os920-d-repeat-finalize-is-empty", again.empty(), "bytes=" + std::to_string(again.size()));
        // A finalized stream refuses more input until reset() (or a fresh state).
        std::vector<BYTE> more;
        convertAudioWithGain(
            signalD.data(), static_cast<DWORD>(300 * src44f.blockAlign), src44f, dst48p, 1.0, more,
            state);
        expect(
            "os920-d-finalized-refuses-input",
            more.empty(),
            "bytes=" + std::to_string(more.size()));
        // reset() re-enables a fresh stream, equal to a cold state's conversion
        // of the same packets.
        state.reset();
        std::vector<BYTE> afterReset;
        size_t cursor = 0;
        for (int i = 0; i < 3; i += 1) {
            convertAudioWithGain(
                signalD.data() + cursor * src44f.blockAlign,
                static_cast<DWORD>(100 * src44f.blockAlign),
                src44f,
                dst48p,
                1.0,
                piece,
                state);
            afterReset.insert(afterReset.end(), piece.begin(), piece.end());
            cursor += 100;
        }
        AudioDecimatorState cold;
        std::vector<BYTE> fromCold;
        cursor = 0;
        for (int i = 0; i < 3; i += 1) {
            convertAudioWithGain(
                signalD.data() + cursor * src44f.blockAlign,
                static_cast<DWORD>(100 * src44f.blockAlign),
                src44f,
                dst48p,
                1.0,
                piece,
                cold);
            fromCold.insert(fromCold.end(), piece.begin(), piece.end());
            cursor += 100;
        }
        expect(
            "os920-d-reset-enables-fresh-stream",
            afterReset == fromCold && !afterReset.empty(),
            "reset=" + std::to_string(afterReset.size()) + " cold=" + std::to_string(fromCold.size()));
    }

    // Finalized equality across the remaining matrix: ragged streams in both
    // directions, all rounding totals with one-frame packets, and every
    // formats/gain case.
    {
        const std::vector<BYTE> rag48 = monoFloatAbrupt(48000, 7777);
        const std::vector<BYTE> rag44 = monoFloatAbrupt(44100, 7777);
        std::vector<BYTE> oneR48;
        convertAudioWithGain(
            rag48.data(), static_cast<DWORD>(rag48.size()), src48f, dst44p, 1.0, oneR48);
        std::vector<BYTE> oneR44;
        convertAudioWithGain(
            rag44.data(), static_cast<DWORD>(rag44.size()), src44f, dst48p, 1.0, oneR44);
        const PartitionRun r1 = runPartitioned(rag48, src48f, dst44p, 1.0, raggedSizes, 7777, true);
        expect(
            "os920-ragged-48-to-44-finalized-equals-one-shot",
            r1.output == oneR48 &&
                r1.output.size() / dst44p.blockAlign == expectedQuota(7777, 48000, 44100),
            "frames=" + frameCountOf(r1.output, dst44p));
        const PartitionRun r2 = runPartitioned(rag44, src44f, dst48p, 1.0, raggedSizes, 7777, true);
        expect(
            "os920-ragged-44-to-48-finalized-equals-one-shot",
            r2.output == oneR44 &&
                r2.output.size() / dst48p.blockAlign == expectedQuota(7777, 44100, 48000),
            "frames=" + frameCountOf(r2.output, dst48p));

        const size_t totals[] = {1, 2, 3, 79, 80, 81, 99, 100, 101, 159, 160, 161};
        const std::vector<BYTE> master48 = monoFloatSine(48000, 997.0, 0.5, 161);
        const std::vector<BYTE> master44 = monoFloatSine(44100, 997.0, 0.5, 161);
        bool ok48 = true;
        bool ok44 = true;
        std::string detail;
        for (size_t n : totals) {
            std::vector<BYTE> in48(
                master48.begin(), master48.begin() + static_cast<std::ptrdiff_t>(n) * src48f.blockAlign);
            std::vector<BYTE> one;
            convertAudioWithGain(
                in48.data(), static_cast<DWORD>(in48.size()), src48f, dst44p, 1.0, one);
            const PartitionRun run = runPartitioned(in48, src48f, dst44p, 1.0, {1}, n, true);
            if (run.output != one || run.output.size() / dst44p.blockAlign != expectedQuota(n, 48000, 44100)) {
                ok48 = false;
                detail += "n" + std::to_string(n) + ":" + frameCountOf(run.output, dst44p) + "/" +
                    frameCountOf(one, dst44p) + " ";
            }
            std::vector<BYTE> in44(
                master44.begin(), master44.begin() + static_cast<std::ptrdiff_t>(n) * src44f.blockAlign);
            std::vector<BYTE> oneUp;
            convertAudioWithGain(
                in44.data(), static_cast<DWORD>(in44.size()), src44f, dst48p, 1.0, oneUp);
            const PartitionRun runUp = runPartitioned(in44, src44f, dst48p, 1.0, {1}, n, true);
            if (runUp.output != oneUp || runUp.output.size() / dst48p.blockAlign != expectedQuota(n, 44100, 48000)) {
                ok44 = false;
                detail += "n" + std::to_string(n) + ":" + frameCountOf(runUp.output, dst48p) + "/" +
                    frameCountOf(oneUp, dst48p) + " ";
            }
        }
        expect("os920-rounding-totals-finalized-equal-one-shot-48-to-44", ok48, detail);
        expect("os920-rounding-totals-finalized-equal-one-shot-44-to-48", ok44, detail);

        const AudioInputFormat src44stereo = makeFormat(MFAudioFormat_Float, 44100, 2, 32);
        const std::vector<BYTE> stereo = stereoFloatDualSine(44100, 997.0, 501.0, 0.5, 3000);
        struct FormatCase {
            const char* name;
            AudioInputFormat dst;
            double gain;
        };
        const FormatCase cases[] = {
            {"pcm16-stereo", makeFormat(MFAudioFormat_PCM, 48000, 2, 16), 1.0},
            {"pcm16-stereo-half-gain", makeFormat(MFAudioFormat_PCM, 48000, 2, 16), 0.5},
            {"float32-stereo", makeFormat(MFAudioFormat_Float, 48000, 2, 32), 1.0},
            {"pcm16-mono-downmix", makeFormat(MFAudioFormat_PCM, 48000, 1, 16), 1.0},
            {"pcm16-mono-downmix-half-gain", makeFormat(MFAudioFormat_PCM, 48000, 1, 16), 0.5},
        };
        bool allFinal = true;
        std::string fmtDetail;
        for (const FormatCase& c : cases) {
            std::vector<BYTE> one;
            convertAudioWithGain(
                stereo.data(), static_cast<DWORD>(stereo.size()), src44stereo, c.dst, c.gain, one);
            const PartitionRun run =
                runPartitioned(stereo, src44stereo, c.dst, c.gain, raggedSizes, 3000, true);
            if (run.output != one) {
                allFinal = false;
                fmtDetail += std::string(c.name) + " ";
            }
        }
        expect("os920-formats-gain-finalized-equals-one-shot", allFinal, fmtDetail);
    }

    // Generic deferral bound at a higher upsampling ratio (8 kHz -> 44.1 kHz):
    // the bound is rate-geometric -- ceil(T/S + 1/2) = 7 here -- NOT a
    // universal two frames. One-frame packets and ragged packets both.
    {
        const AudioInputFormat src8k = makeFormat(MFAudioFormat_Float, 8000, 1, 32);
        const AudioInputFormat dst44k = makeFormat(MFAudioFormat_PCM, 44100, 1, 16);
        const std::vector<BYTE> sig = monoFloatSine(8000, 997.0, 0.5, 4000);
        const UINT32 S = 8000;
        const UINT32 T = 44100;
        const size_t pendingBound = pendingBoundFor(S, T);
        const size_t retainedBound = retainedBoundFor(S, T);
        bool okPending = pendingBound == 7;
        bool okRetained = true;
        std::string detail = "bound=" + std::to_string(pendingBound);
        bool okFinal = true;
        std::vector<BYTE> one8k;
        convertAudioWithGain(
            sig.data(), static_cast<DWORD>(sig.size()), src8k, dst44k, 1.0, one8k);
        for (const std::vector<size_t>& sizes : std::vector<std::vector<size_t>>{{size_t{1}}, raggedSizes}) {
            AudioDecimatorState state;
            std::vector<BYTE> piece;
            std::vector<BYTE> all;
            size_t cursor = 0;
            size_t index = 0;
            while (cursor < 4000) {
                const size_t frames = std::min(sizes[index % sizes.size()], 4000 - cursor);
                index += 1;
                convertAudioWithGain(
                    sig.data() + cursor * src8k.blockAlign,
                    static_cast<DWORD>(frames * src8k.blockAlign),
                    src8k,
                    dst44k,
                    1.0,
                    piece,
                    state);
                all.insert(all.end(), piece.begin(), piece.end());
                cursor += frames;
                okPending = okPending && state.interpolationPendingFrames() <= pendingBound;
                okRetained = okRetained && state.interpolationRetainedFrames() <= retainedBound;
            }
            piece.clear();
            finalizeAudioConversion(dst44k, 1.0, piece, state);
            all.insert(all.end(), piece.begin(), piece.end());
            okFinal = okFinal && all == one8k &&
                all.size() / dst44k.blockAlign == expectedQuota(4000, 8000, 44100);
        }
        expect("os920-generic-8k-to-44k-pending-bound-7", okPending, detail);
        expect("os920-generic-8k-to-44k-retained-bound", okRetained, detail);
        expect(
            "os920-generic-8k-to-44k-finalized-equals-one-shot",
            okFinal,
            "frames=" + std::to_string(one8k.size() / dst44k.blockAlign));
    }

    // Same-rate (T == S) pin: same-rate
    // cross-subtype conversion emits every frame immediately -- frac == 0
    // makes the clamped window exact -- so the held count is 0 (never above
    // the <= 1 a uniform deferral would give), per-packet emission counts
    // equal the old converter's, and finalization adds nothing. The held
    // frame is NOT dropped at reset/resume/end-of-take because there is none.
    {
        const AudioInputFormat src48stereo = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        const AudioInputFormat dst48pcm = makeFormat(MFAudioFormat_PCM, 48000, 2, 16);
        const std::vector<BYTE> mic = stereoFloatDualSine(48000, 997.0, 503.0, 0.5, 5000);
        std::vector<BYTE> one;
        convertAudioWithGain(
            mic.data(), static_cast<DWORD>(mic.size()), src48stereo, dst48pcm, 1.0, one);
        const std::vector<size_t> sizes = {479, 480, 1, 160, 3};
        AudioDecimatorState state;
        std::vector<BYTE> piece;
        std::vector<BYTE> all;
        bool heldOk = true;
        bool countsOk = true;
        size_t cursor = 0;
        size_t index = 0;
        while (cursor < 5000) {
            const size_t frames = std::min(sizes[index % sizes.size()], 5000 - cursor);
            index += 1;
            convertAudioWithGain(
                mic.data() + cursor * src48stereo.blockAlign,
                static_cast<DWORD>(frames * src48stereo.blockAlign),
                src48stereo,
                dst48pcm,
                1.0,
                piece,
                state);
            countsOk = countsOk && piece.size() / dst48pcm.blockAlign == frames;
            all.insert(all.end(), piece.begin(), piece.end());
            cursor += frames;
            heldOk = heldOk && state.interpolationPendingFrames() == 0;
        }
        std::string detail =
            "lastPacket=" + std::to_string(piece.size() / dst48pcm.blockAlign);
        expect(
            "os920-same-rate-held-count-never-exceeds-one",
            heldOk,
            detail + " (0 held: immediate emission; bound is <= 1)");
        expect("os920-same-rate-per-packet-emission-immediate", countsOk, detail);
        piece.clear();
        finalizeAudioConversion(dst48pcm, 1.0, piece, state);
        expect(
            "os920-same-rate-finalize-adds-nothing",
            piece.empty() && all == one,
            "tail=" + std::to_string(piece.size()) + " frames=" +
                std::to_string(all.size() / dst48pcm.blockAlign));
    }

    // Lifecycle: reset equals a cold start on the interpolation stream itself.
    {
        const std::vector<BYTE> warm = monoFloatAbrupt(48000, 777);
        const std::vector<BYTE> tail = monoFloatAbrupt(48000, 1723);
        AudioDecimatorState used;
        std::vector<BYTE> scratch;
        size_t cursor = 0;
        size_t index = 0;
        while (cursor < 777) {
            const size_t frames = std::min(raggedSizes[index % raggedSizes.size()], 777 - cursor);
            index += 1;
            convertAudioWithGain(
                warm.data() + cursor * src48f.blockAlign,
                static_cast<DWORD>(frames * src48f.blockAlign),
                src48f,
                dst44p,
                1.0,
                scratch,
                used);
            cursor += frames;
        }
        used.reset();
        std::vector<BYTE> afterReset;
        cursor = 0;
        index = 0;
        while (cursor < 1723) {
            const size_t frames = std::min(raggedSizes[index % raggedSizes.size()], 1723 - cursor);
            index += 1;
            convertAudioWithGain(
                tail.data() + cursor * src48f.blockAlign,
                static_cast<DWORD>(frames * src48f.blockAlign),
                src48f,
                dst44p,
                1.0,
                scratch,
                used);
            afterReset.insert(afterReset.end(), scratch.begin(), scratch.end());
            cursor += frames;
        }
        AudioDecimatorState fresh;
        std::vector<BYTE> fromCold;
        cursor = 0;
        index = 0;
        while (cursor < 1723) {
            const size_t frames = std::min(raggedSizes[index % raggedSizes.size()], 1723 - cursor);
            index += 1;
            convertAudioWithGain(
                tail.data() + cursor * src48f.blockAlign,
                static_cast<DWORD>(frames * src48f.blockAlign),
                src48f,
                dst44p,
                1.0,
                scratch,
                fresh);
            fromCold.insert(fromCold.end(), scratch.begin(), scratch.end());
            cursor += frames;
        }
        expect(
            "os920-interp-reset-equals-cold-start",
            afterReset == fromCold && !afterReset.empty(),
            "reset=" + std::to_string(afterReset.size()) + " cold=" +
                std::to_string(fromCold.size()));
    }

    // interpolation -> same-rate -> interpolation on ONE state: the cross-format
    // contract keeps pendingFrames() at zero through the same-rate hop, and the
    // interpolation stream restarts cold (equal to a fresh state).
    {
        const AudioInputFormat src48stereo = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        const AudioInputFormat dst48pcm = makeFormat(MFAudioFormat_PCM, 48000, 2, 16);
        const std::vector<BYTE> interpPart = monoFloatAbrupt(48000, 200);
        const std::vector<BYTE> sameRatePart = stereoFloatDualSine(48000, 800.0, 300.0, 0.5, 100);
        AudioDecimatorState reused;
        std::vector<BYTE> scratch;
        convertAudioWithGain(
            interpPart.data(), static_cast<DWORD>(interpPart.size()), src48f, dst44p, 1.0, scratch,
            reused);
        const bool pendingBefore = reused.pendingFrames() == 0;
        convertAudioWithGain(
            sameRatePart.data(), static_cast<DWORD>(sameRatePart.size()), src48stereo, dst48pcm,
            1.0, scratch, reused);
        const bool pendingAfterSameRate = reused.pendingFrames() == 0;
        std::vector<BYTE> afterReturn;
        convertAudioWithGain(
            interpPart.data(), static_cast<DWORD>(interpPart.size()), src48f, dst44p, 1.0,
            afterReturn, reused);
        AudioDecimatorState fresh;
        std::vector<BYTE> fromCold;
        convertAudioWithGain(
            interpPart.data(), static_cast<DWORD>(interpPart.size()), src48f, dst44p, 1.0,
            fromCold, fresh);
        expect(
            "os920-interp-via-same-rate-restarts-cold",
            pendingBefore && pendingAfterSameRate && afterReturn == fromCold && !afterReturn.empty(),
            "before=" + std::to_string(pendingBefore) + " sameRate=" +
                std::to_string(pendingAfterSameRate) + " match=" +
                std::to_string(afterReturn == fromCold));
    }

    // interpolation -> integer: the integer filter starts cold and its
    // remainder/history contract is intact after the transition.
    {
        const AudioInputFormat src96k = makeFormat(MFAudioFormat_PCM, 96000, 2, 16);
        const AudioInputFormat dst48k = makeAacCompatibleAudioFormat(src96k);
        const size_t integerFrames = 501;  // odd: leaves exactly one frame pending
        std::vector<BYTE> integerPacket(integerFrames * src96k.blockAlign, 0);
        auto* samples = reinterpret_cast<int16_t*>(integerPacket.data());
        for (size_t i = 0; i < integerFrames; i += 1) {
            const double phase =
                2.0 * kTestPi * 4000.0 * static_cast<double>(i) / src96k.sampleRate;
            const auto v = static_cast<int16_t>(std::lround(7000.0 * std::sin(phase)));
            samples[i * 2] = v;
            samples[i * 2 + 1] = v;
        }
        AudioDecimatorState reused;
        std::vector<BYTE> scratch;
        convertAudioWithGain(
            signalD.data(), static_cast<DWORD>(93 * src44f.blockAlign), src44f, dst48p, 1.0,
            scratch, reused);
        std::vector<BYTE> afterInterp;
        convertAudioWithGain(
            integerPacket.data(), static_cast<DWORD>(integerPacket.size()), src96k, dst48k, 1.0,
            afterInterp, reused);
        AudioDecimatorState fresh;
        std::vector<BYTE> fromCold;
        convertAudioWithGain(
            integerPacket.data(), static_cast<DWORD>(integerPacket.size()), src96k, dst48k, 1.0,
            fromCold, fresh);
        expect(
            "os920-interp-to-integer-starts-cold",
            afterInterp == fromCold && !afterInterp.empty() &&
                reused.pendingFrames() == fresh.pendingFrames(),
            "match=" + std::to_string(afterInterp == fromCold) + " pending=" +
                std::to_string(reused.pendingFrames()));
    }

    // Finalizing an empty stream returns no bytes (and touches nothing else).
    {
        AudioDecimatorState fresh;
        std::vector<BYTE> dest(7, 0xAB);
        finalizeAudioConversion(dst44p, 1.0, dest, fresh);
        expect(
            "os920-finalize-empty-stream-no-bytes",
            dest.size() == 7 && dest[0] == 0xAB,
            "bytes=" + std::to_string(dest.size()));
    }

    // finalizeAudioConversion appends after the last WHOLE frame of the
    // target format; the documented precondition is an empty or
    // frame-aligned `destination` (header contract). The PCM writers store
    // through typed pointers, so the append point is frame-aligned by
    // construction and a caller-supplied trailing partial frame is outside
    // the contract. This pins the supported case: a frame-aligned prefill
    // stays byte-identical, the tail lands strictly after it, sized exactly
    // to the pending-frame count, in whole frames.
    {
        const AudioInputFormat finSrc = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        std::vector<BYTE> finSignal(200 * finSrc.blockAlign, 0);
        auto* finSamples = reinterpret_cast<float*>(finSignal.data());
        for (size_t i = 0; i < 400; i += 1) {
            finSamples[i] = 0.25f;
        }
        AudioDecimatorState finState;
        std::vector<BYTE> streamed;
        convertAudioWithGain(
            finSignal.data(), static_cast<DWORD>(finSignal.size()), finSrc, dst44p, 1.0,
            streamed, finState);
        const uint64_t pending = finState.interpolationPendingFrames();
        const uint64_t emittedBefore = finState.interpolationEmittedFrames();
        std::vector<BYTE> dest(dst44p.blockAlign * 3, 0x5A);
        const std::vector<BYTE> prefill = dest;
        const size_t before = dest.size();
        finalizeAudioConversion(dst44p, 1.0, dest, finState);
        expect(
            "os920-finalize-appends-after-whole-frames",
            pending > 0 &&
                dest.size() == before + static_cast<size_t>(pending) * dst44p.blockAlign &&
                dest.size() % dst44p.blockAlign == 0 &&
                std::equal(prefill.begin(), prefill.end(), dest.begin()) &&
                finState.interpolationFinalized() &&
                finState.interpolationEmittedFrames() == emittedBefore + pending,
            "pending=" + std::to_string(pending) + " bytes=" +
                std::to_string(dest.size()) + " want=" +
                std::to_string(before + static_cast<size_t>(pending) * dst44p.blockAlign));
    }

    // Deterministic mixer coverage, at queue level: the mixer is constructed
    // but its thread is never started and its timeline never begun, so pushes
    // are plain sequential calls and the pause handshake resolves at once
    // (pauseFlushed_ is true while the timeline has not started). The threaded
    // tests above remain responsible for the live cushion flush and resume
    // synchronization.
    {
        const AudioInputFormat mixFmt = makeFormat(MFAudioFormat_PCM, 48000, 2, 16);
        const AudioInputFormat sysFmt = makeFormat(MFAudioFormat_Float, 44100, 2, 32);
        const AudioInputFormat micFmt = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        AudioMixer mixer(
            mixFmt, sysFmt, micFmt, true, true, 1.0, 1.0,
            [](const BYTE*, DWORD, int64_t, int64_t) { return true; });

        const std::vector<BYTE> sysSignal = stereoFloatDualSine(44100, 997.0, 501.0, 0.5, 4321);
        const std::vector<BYTE> micSignal = stereoFloatDualSine(48000, 701.0, 303.0, 0.5, 4800);
        const std::vector<size_t> sysSizes = {160, 1, 480, 7, 99};
        const std::vector<size_t> micSizes = {480, 3, 479, 1, 100};
        AudioDecimatorState sysDirect;
        AudioDecimatorState micDirect;
        std::vector<BYTE> sysExpect;
        std::vector<BYTE> micExpect;
        std::vector<BYTE> piece;
        size_t sysCursor = 0;
        size_t micCursor = 0;
        size_t step = 0;
        while (sysCursor < 4321) {
            const size_t frames = std::min(sysSizes[step % sysSizes.size()], 4321 - sysCursor);
            mixer.pushSystem(
                sysSignal.data() + sysCursor * sysFmt.blockAlign,
                static_cast<DWORD>(frames * sysFmt.blockAlign));
            convertAudioWithGain(
                sysSignal.data() + sysCursor * sysFmt.blockAlign,
                static_cast<DWORD>(frames * sysFmt.blockAlign),
                sysFmt,
                mixFmt,
                1.0,
                piece,
                sysDirect);
            sysExpect.insert(sysExpect.end(), piece.begin(), piece.end());
            sysCursor += frames;
            const size_t micFrames = std::min(micSizes[step % micSizes.size()], 4800 - micCursor);
            if (micFrames > 0) {
                mixer.pushMicrophone(
                    micSignal.data() + micCursor * micFmt.blockAlign,
                    static_cast<DWORD>(micFrames * micFmt.blockAlign));
                convertAudioWithGain(
                    micSignal.data() + micCursor * micFmt.blockAlign,
                    static_cast<DWORD>(micFrames * micFmt.blockAlign),
                    micFmt,
                    mixFmt,
                    1.0,
                    piece,
                    micDirect);
                micExpect.insert(micExpect.end(), piece.begin(), piece.end());
                micCursor += micFrames;
            }
            step += 1;
        }
        while (micCursor < 4800) {
            const size_t micFrames = std::min(micSizes[step % micSizes.size()], 4800 - micCursor);
            mixer.pushMicrophone(
                micSignal.data() + micCursor * micFmt.blockAlign,
                static_cast<DWORD>(micFrames * micFmt.blockAlign));
            convertAudioWithGain(
                micSignal.data() + micCursor * micFmt.blockAlign,
                static_cast<DWORD>(micFrames * micFmt.blockAlign),
                micFmt,
                mixFmt,
                1.0,
                piece,
                micDirect);
            micExpect.insert(micExpect.end(), piece.begin(), piece.end());
            micCursor += micFrames;
            step += 1;
        }
        expect(
            "os920-mixer-streams-keep-independent-resampler-state",
            AudioMixerTestAccess::systemQueue(mixer) == sysExpect &&
                AudioMixerTestAccess::microphoneQueue(mixer) == micExpect,
            "sys=" + std::to_string(AudioMixerTestAccess::systemQueue(mixer).size()) + " want " +
                std::to_string(sysExpect.size()) + " mic=" +
                std::to_string(AudioMixerTestAccess::microphoneQueue(mixer).size()) + " want " +
                std::to_string(micExpect.size()));

        // setPaused(true) preserves both queues and ignores pushes.
        mixer.setPaused(true);
        const std::vector<BYTE> sysBefore = AudioMixerTestAccess::systemQueue(mixer);
        const std::vector<BYTE> micBefore = AudioMixerTestAccess::microphoneQueue(mixer);
        std::vector<BYTE> distinctive(100 * micFmt.blockAlign, 0);
        auto* distinctiveSamples = reinterpret_cast<float*>(distinctive.data());
        for (size_t i = 0; i < 200; i += 1) {
            distinctiveSamples[i] = 0.75f;
        }
        mixer.pushSystem(distinctive.data(), static_cast<DWORD>(distinctive.size()));
        mixer.pushMicrophone(distinctive.data(), static_cast<DWORD>(distinctive.size()));
        expect(
            "os920-mixer-paused-pushes-ignored",
            AudioMixerTestAccess::systemQueue(mixer) == sysBefore &&
                AudioMixerTestAccess::microphoneQueue(mixer) == micBefore,
            "sys=" + std::to_string(AudioMixerTestAccess::systemQueue(mixer).size()) + " mic=" +
                std::to_string(AudioMixerTestAccess::microphoneQueue(mixer).size()));

        // The resume clears both queues (and cold-resets both states).
        mixer.setPaused(false);
        expect(
            "os920-mixer-resume-clears-queues",
            AudioMixerTestAccess::systemQueue(mixer).empty() &&
                AudioMixerTestAccess::microphoneQueue(mixer).empty(),
            "sys=" + std::to_string(AudioMixerTestAccess::systemQueue(mixer).size()) + " mic=" +
                std::to_string(AudioMixerTestAccess::microphoneQueue(mixer).size()));

        // Post-resume pushes convert as a cold start: no pre-pause sample or
        // phase contamination. (This also pins the accepted behavior change:
        // the resume drops the bounded unfinalized tail of the pre-pause
        // streams along with the queued bytes.)
        const std::vector<BYTE> sysPost = stereoFloatDualSine(44100, 1234.0, 432.0, 0.4, 1234);
        const std::vector<BYTE> micPost = stereoFloatDualSine(48000, 888.0, 222.0, 0.4, 960);
        AudioDecimatorState sysCold;
        AudioDecimatorState micCold;
        std::vector<BYTE> sysColdExpect;
        std::vector<BYTE> micColdExpect;
        sysCursor = 0;
        micCursor = 0;
        step = 0;
        while (sysCursor < 1234 || micCursor < 960) {
            if (sysCursor < 1234) {
                const size_t frames = std::min(sysSizes[step % sysSizes.size()], 1234 - sysCursor);
                mixer.pushSystem(
                    sysPost.data() + sysCursor * sysFmt.blockAlign,
                    static_cast<DWORD>(frames * sysFmt.blockAlign));
                convertAudioWithGain(
                    sysPost.data() + sysCursor * sysFmt.blockAlign,
                    static_cast<DWORD>(frames * sysFmt.blockAlign),
                    sysFmt,
                    mixFmt,
                    1.0,
                    piece,
                    sysCold);
                sysColdExpect.insert(sysColdExpect.end(), piece.begin(), piece.end());
                sysCursor += frames;
            }
            if (micCursor < 960) {
                const size_t frames = std::min(micSizes[step % micSizes.size()], 960 - micCursor);
                mixer.pushMicrophone(
                    micPost.data() + micCursor * micFmt.blockAlign,
                    static_cast<DWORD>(frames * micFmt.blockAlign));
                convertAudioWithGain(
                    micPost.data() + micCursor * micFmt.blockAlign,
                    static_cast<DWORD>(frames * micFmt.blockAlign),
                    micFmt,
                    mixFmt,
                    1.0,
                    piece,
                    micCold);
                micColdExpect.insert(micColdExpect.end(), piece.begin(), piece.end());
                micCursor += frames;
            }
            step += 1;
        }
        expect(
            "os920-mixer-resume-cold-resets-resampler-state",
            AudioMixerTestAccess::systemQueue(mixer) == sysColdExpect &&
                AudioMixerTestAccess::microphoneQueue(mixer) == micColdExpect,
            "sys=" + std::to_string(AudioMixerTestAccess::systemQueue(mixer).size()) + " want " +
                std::to_string(sysColdExpect.size()) + " mic=" +
                std::to_string(AudioMixerTestAccess::microphoneQueue(mixer).size()) + " want " +
                std::to_string(micColdExpect.size()));
    }

    // Starvation resume: a source that ran dry
    // and came back is a real-time discontinuity — the starved branch pads
    // silence and re-anchors the packet at now. The resumed packet must
    // convert as a COLD stream: no pre-gap sample may reach the resumed
    // output. The pre-fix stateless converter never interpolated across a
    // gap either, because it held no state at all. The starved branch's
    // queue.assign replaces whatever the queue held (lag is zero while the
    // timeline is not anchored, as in an unstarted mixer), so the queue after
    // the resumed push is EXACTLY the resumed conversion — pinned byte for
    // byte, frame count for frame count, against a fresh-state conversion.
    // On the unfixed tree this fails twice over: the continued stream emits
    // one extra frame (92 vs 91) and its first frame blends the pre-gap
    // constant into the resumed segment (-12594 vs +16384 at 48k->44.1k).
    {
        const AudioInputFormat mixFmt = makeFormat(MFAudioFormat_PCM, 44100, 2, 16);
        const AudioInputFormat sysFmt = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        AudioMixer mixer(
            mixFmt, sysFmt, sysFmt, true, false, 1.0, 1.0,
            [](const BYTE*, DWORD, int64_t, int64_t) { return true; });

        std::vector<BYTE> preGap(150 * sysFmt.blockAlign, 0);
        auto* preSamples = reinterpret_cast<float*>(preGap.data());
        for (size_t i = 0; i < 300; i += 1) {
            preSamples[i] = -0.5f;
        }
        for (size_t off = 0; off < 150; off += 50) {
            mixer.pushSystem(
                preGap.data() + off * sysFmt.blockAlign,
                static_cast<DWORD>(50 * sysFmt.blockAlign));
        }
        std::vector<BYTE> resumed(100 * sysFmt.blockAlign, 0);
        auto* resumedSamples = reinterpret_cast<float*>(resumed.data());
        for (size_t i = 0; i < 200; i += 1) {
            resumedSamples[i] = 0.5f;
        }
        AudioMixerTestAccess::setSystemStarved(mixer, true);
        mixer.pushSystem(resumed.data(), static_cast<DWORD>(resumed.size()));

        std::vector<BYTE> coldExpect;
        AudioDecimatorState coldState;
        convertAudioWithGain(
            resumed.data(), static_cast<DWORD>(resumed.size()), sysFmt, mixFmt, 1.0,
            coldExpect, coldState);
        const std::vector<BYTE>& starveQueue = AudioMixerTestAccess::systemQueue(mixer);
        expect(
            "os920-mixer-starvation-resume-no-cross-gap-blend",
            starveQueue == coldExpect,
            "queue=" + std::to_string(starveQueue.size()) + " cold=" +
                std::to_string(coldExpect.size()) + " q0=" +
                std::to_string(starveQueue.size() >= 2
                    ? *reinterpret_cast<const short*>(starveQueue.data())
                    : 0));

        // Control: integer decimation keeps its pre-existing cross-gap
        // behavior — the fix must not reset it. A resumed 96k->48k packet
        // converts on the CONTINUING integer state, byte-identical to a
        // direct conversion that never saw the abandonment hook.
        const AudioInputFormat intMixFmt = makeFormat(MFAudioFormat_PCM, 48000, 2, 16);
        const AudioInputFormat intSrcFmt = makeFormat(MFAudioFormat_Float, 96000, 2, 32);
        AudioMixer intMixer(
            intMixFmt, intSrcFmt, intSrcFmt, true, false, 1.0, 1.0,
            [](const BYTE*, DWORD, int64_t, int64_t) { return true; });
        AudioDecimatorState intContinuing;
        std::vector<BYTE> intPiece;
        for (size_t off = 0; off < 150; off += 50) {
            intMixer.pushSystem(
                preGap.data() + off * intSrcFmt.blockAlign,
                static_cast<DWORD>(50 * intSrcFmt.blockAlign));
            convertAudioWithGain(
                preGap.data() + off * intSrcFmt.blockAlign,
                static_cast<DWORD>(50 * intSrcFmt.blockAlign), intSrcFmt, intMixFmt, 1.0,
                intPiece, intContinuing);
        }
        AudioMixerTestAccess::setSystemStarved(intMixer, true);
        intMixer.pushSystem(resumed.data(), static_cast<DWORD>(resumed.size()));
        std::vector<BYTE> intResumedExpect;
        convertAudioWithGain(
            resumed.data(), static_cast<DWORD>(resumed.size()), intSrcFmt, intMixFmt, 1.0,
            intResumedExpect, intContinuing);
        const std::vector<BYTE>& intQueue = AudioMixerTestAccess::systemQueue(intMixer);
        expect(
            "os920-mixer-starvation-resume-integer-continues",
            intQueue == intResumedExpect,
            "queue=" + std::to_string(intQueue.size()) + " expect=" +
                std::to_string(intResumedExpect.size()));

        // Control: same-rate (T==S) resume output is identical cold or
        // continued — nothing is deferred or retained on that path, before
        // and after the fix alike.
        const AudioInputFormat sameMixFmt = makeFormat(MFAudioFormat_PCM, 48000, 2, 16);
        const AudioInputFormat sameSrcFmt = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        AudioMixer sameMixer(
            sameMixFmt, sameSrcFmt, sameSrcFmt, true, false, 1.0, 1.0,
            [](const BYTE*, DWORD, int64_t, int64_t) { return true; });
        sameMixer.pushSystem(preGap.data(), static_cast<DWORD>(preGap.size()));
        AudioMixerTestAccess::setSystemStarved(sameMixer, true);
        sameMixer.pushSystem(resumed.data(), static_cast<DWORD>(resumed.size()));
        std::vector<BYTE> sameColdExpect;
        AudioDecimatorState sameCold;
        convertAudioWithGain(
            resumed.data(), static_cast<DWORD>(resumed.size()), sameSrcFmt, sameMixFmt, 1.0,
            sameColdExpect, sameCold);
        const std::vector<BYTE>& sameQueue = AudioMixerTestAccess::systemQueue(sameMixer);
        expect(
            "os920-mixer-starvation-resume-same-rate-identical",
            sameQueue == sameColdExpect,
            "queue=" + std::to_string(sameQueue.size()) + " cold=" +
                std::to_string(sameColdExpect.size()));
    }
}
#endif  // !OS920_PRISTINE_REGRESSION

void runResampleContinuityTests() {
    runResampleContinuityCoreTests();
#ifndef OS920_PRISTINE_REGRESSION
    runResampleContinuityFixedTests();
#endif
}

} // namespace

int main(int argc, char** argv) {
    const bool continuityOnly =
        argc > 1 && argv[1] == std::string("--resample-continuity-only");
    if (continuityOnly) {
        runResampleContinuityTests();
        std::cout << "ran " << g_ran << " tests\n";
        if (g_failed != 0) {
            std::cout << g_failed << " failed\n";
            return 1;
        }
        return 0;
    }

    // --- Timer resolution (getopenscreen/openscreen#921) ----------------------
    //
    // First, before anything in this process could have raised it: a 5 ms sleep
    // is what the WASAPI poll asks for, and at the default 15.625 ms tick it
    // lasts a whole tick. Median of 20, so one preempted sleep cannot decide it.
    {
        const auto medianSleepMs = [] {
            std::vector<double> samples;
            for (int i = 0; i < 20; i += 1) {
                const auto start = std::chrono::steady_clock::now();
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
                samples.push_back(
                    std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count());
            }
            std::sort(samples.begin(), samples.end());
            return samples[samples.size() / 2];
        };
        const double before = medianSleepMs();
        const HighResolutionTiming timing;
        // Load only ever lengthens a sleep, so a median under 8 ms cannot be
        // faked by a busy host, and at the default tick it cannot happen at all.
        // A failing round is retried, so a transient load does not fail the build.
        double after = medianSleepMs();
        for (int retry = 0; retry < 2 && after >= 8.0; retry += 1) {
            after = std::min(after, medianSleepMs());
        }
        char detail[96]{};
        sprintf_s(detail, "5 ms sleep: median %.2f ms before, %.2f ms after", before, after);
        std::cout << "TIMER_RAW " << detail << std::endl;
        expect("timer-5ms-sleep-lasts-about-5ms", after < 8.0, detail);
    }

    // --- issue #920, item 24: non-integer resampling continuity --------------
    runResampleContinuityTests();

    const AudioInputFormat diagnostic = makeFormat(MFAudioFormat_Float, 96000, 8, 32);
    const AudioInputFormat snapped = makeAacCompatibleAudioFormat(diagnostic);
    expect(
        "diag-96000-8ch",
        snapped.sampleRate == 48000 && snapped.channels == 2 && snapped.bitsPerSample == 16 &&
            snapped.subtype == MFAudioFormat_PCM,
        describe(snapped));

    const AudioInputFormat keep48000 =
        makeAacCompatibleAudioFormat(makeFormat(MFAudioFormat_PCM, 48000, 2, 16));
    expect("keep-48000", keep48000.sampleRate == 48000, describe(keep48000));

    const AudioInputFormat keep44100 =
        makeAacCompatibleAudioFormat(makeFormat(MFAudioFormat_PCM, 44100, 2, 16));
    expect("keep-44100", keep44100.sampleRate == 44100, describe(keep44100));

    const AudioInputFormat zeroRate =
        makeAacCompatibleAudioFormat(makeFormat(MFAudioFormat_PCM, 0, 2, 16));
    expect("zero-rate", zeroRate.sampleRate == 48000, describe(zeroRate));

    const AudioInputFormat keep32000 =
        makeAacCompatibleAudioFormat(makeFormat(MFAudioFormat_PCM, 32000, 2, 16));
    expect("keep-32000", keep32000.sampleRate == 32000, describe(keep32000));

    const AudioInputFormat source96k = makeFormat(MFAudioFormat_PCM, 96000, 2, 16);
    const AudioInputFormat target48k = makeAacCompatibleAudioFormat(source96k);
    const UINT32 sourceFrames = 96000;
    std::vector<BYTE> source(static_cast<size_t>(sourceFrames) * source96k.blockAlign, 0);
    auto* samples = reinterpret_cast<int16_t*>(source.data());
    for (UINT32 frame = 0; frame < sourceFrames; frame += 1) {
        samples[frame * 2] = static_cast<int16_t>(frame % 32767);
        samples[frame * 2 + 1] = static_cast<int16_t>((frame * 3) % 32767);
    }
    std::vector<BYTE> converted;
    convertAudioWithGain(
        source.data(),
        static_cast<DWORD>(source.size()),
        source96k,
        target48k,
        1.0,
        converted);
    const size_t convertedFrames =
        target48k.blockAlign == 0 ? 0 : converted.size() / target48k.blockAlign;
    const bool frameCountOk =
        convertedFrames == 48000 || convertedFrames == 47999 || convertedFrames == 48001;
    expect(
        "resample-frame-count",
        target48k.sampleRate == 48000 && frameCountOk,
        "frames=" + std::to_string(convertedFrames) + " " + describe(target48k));

    // 96 kHz Nyquist square (+/- full scale) must not survive 2:1 as a tone.
    std::vector<BYTE> nyquist(8 * source96k.blockAlign, 0);
    auto* nyquistSamples = reinterpret_cast<int16_t*>(nyquist.data());
    for (size_t frame = 0; frame < 8; frame += 1) {
        const int16_t v = (frame % 2 == 0) ? 32767 : -32767;
        nyquistSamples[frame * 2] = v;
        nyquistSamples[frame * 2 + 1] = v;
    }
    std::vector<BYTE> nyquistOut;
    convertAudioWithGain(nyquist.data(), static_cast<DWORD>(nyquist.size()), source96k, target48k, 1.0, nyquistOut);
    const auto* down = reinterpret_cast<const int16_t*>(nyquistOut.data());
    const size_t downFrames = nyquistOut.size() / target48k.blockAlign;
    bool folded = downFrames == 4;
    for (size_t i = 0; folded && i < downFrames * 2; i += 1) {
        folded = std::abs(static_cast<int>(down[i])) <= 1;
    }
    expect("resample-96k-nyquist-rejected", folded, "frames=" + std::to_string(downFrames));

    // --- Layer 1: the filter itself, measured in floating point -------------
    //
    // These read the anti-alias filter's own response, which is a different
    // question from "what reaches the encoder" (layer 2, below) and has to be
    // reported separately. Both the source and the target are float32 here, for
    // two reasons: WASAPI mix formats ARE float32, so this is the production
    // shape; and it removes both quantization floors. Measured through PCM16 the
    // same stopband reads -300 dB (the output quantizer) or -98 dB (the input
    // quantizer) -- neither of which says anything about the filter.
    //
    // Tone frequencies are multiples of 10 Hz and the analysis window is exactly
    // 4800 output frames = 0.1 s, so every tone is periodic in the window and
    // Goertzel scalloping cannot bias the reading. That matters: the cutoff
    // assertion below has a +/-0.3 dB window, which scalloping alone could break.
    constexpr size_t kResponseWindow = 4800;  // 0.1 s at 48 kHz -> 10 Hz bins
    constexpr size_t kResponseSkip = 256;     // past the cold-filter ramp
    const auto responseDb = [&](UINT32 factor, double toneHz) -> double {
        const UINT32 outRate = 48000;
        const AudioInputFormat src = makeFormat(MFAudioFormat_Float, outRate * factor, 2, 32);
        const AudioInputFormat dst = makeFormat(MFAudioFormat_Float, outRate, 2, 32);
        const size_t outFrames = kResponseWindow + kResponseSkip;
        const size_t srcFrames = outFrames * factor;
        const double amplitude = 0.5;
        std::vector<BYTE> in(srcFrames * src.blockAlign, 0);
        auto* inSamples = reinterpret_cast<float*>(in.data());
        for (size_t i = 0; i < srcFrames; i += 1) {
            const double v = amplitude *
                std::sin(2.0 * kTestPi * toneHz * static_cast<double>(i) / src.sampleRate);
            inSamples[i * 2] = static_cast<float>(v);
            inSamples[i * 2 + 1] = static_cast<float>(v);
        }
        std::vector<BYTE> out;
        convertAudioWithGain(in.data(), static_cast<DWORD>(in.size()), src, dst, 1.0, out);
        const size_t produced = out.size() / dst.blockAlign;
        if (produced < kResponseSkip + kResponseWindow) {
            return 300.0;  // deliberately out of budget: too short to judge
        }
        // Where the tone lands after decimation. Below the output Nyquist it
        // stays put; above it, it folds -- which is the whole point.
        double folded = std::fmod(toneHz, static_cast<double>(outRate));
        if (folded > outRate / 2.0) {
            folded = outRate - folded;
        }
        const auto* outSamples = reinterpret_cast<const float*>(out.data());
        const double w = 2.0 * kTestPi * folded / static_cast<double>(outRate);
        const double c = 2.0 * std::cos(w);
        double s1 = 0.0;
        double s2 = 0.0;
        for (size_t i = 0; i < kResponseWindow; i += 1) {
            const double v = static_cast<double>(outSamples[(kResponseSkip + i) * 2]);
            const double s0 = v + c * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        const double mag = 2.0 * std::sqrt(std::max(0.0, s1 * s1 + s2 * s2 - c * s1 * s2)) /
            static_cast<double>(kResponseWindow);
        return mag <= 0.0 ? -300.0 : 20.0 * std::log10(mag / amplitude);
    };

    for (UINT32 factor : {2u, 3u, 4u, 6u, 12u, 24u}) {
        const double outNyquist = 24000.0;  // the target is 48 kHz
        const std::string tag = "-f" + std::to_string(factor);
        const double passband = responseDb(factor, 0.8 * outNyquist);        // 19200 Hz
        const double cutoff = responseDb(factor, 11.0 / 12.0 * outNyquist);  // 22000 Hz
        // Just above the Nyquist rather than exactly on it: a tone at exactly
        // 24000 Hz sits on the output's Nyquist bin, where the measured
        // magnitude depends on sampling phase rather than on the filter.
        const double stopEntry = responseDb(factor, outNyquist + 10.0);
        // Sweep the WHOLE band that can fold, starting at the stop band edge.
        // Starting further in would miss the worst case entirely: for a Kaiser
        // design the largest surviving lobe sits immediately above the edge, and
        // an interior-only sweep reads ~6 dB better than the truth. The coarse
        // pass covers the band; the dense pass is what actually lands on that
        // first lobe (about 24.03 kHz), since the coarse points are hundreds of
        // Hz apart and step straight over it, reading up to 0.2 dB optimistic.
        double worst = -300.0;
        double worstAt = 0.0;
        const double top = outNyquist * static_cast<double>(factor);  // source Nyquist
        const auto consider = [&](double hz) {
            const double db = responseDb(factor, hz);
            if (db > worst) {
                worst = db;
                worstAt = hz;
            }
        };
        for (int step = 0; step <= 32; step += 1) {
            consider(std::round(
                (outNyquist + 10.0 + (top - outNyquist - 10.0) * step / 32.0) / 10.0) * 10.0);
        }
        for (double hz = outNyquist + 20.0; hz <= outNyquist + 300.0; hz += 10.0) {
            consider(hz);
        }
        char detail[192]{};
        sprintf_s(
            detail, "pb19200=%.3f cutoff22000=%.3f stop24010=%.2f worst=%.2f@%.0fHz",
            passband, cutoff, stopEntry, worst, worstAt);
        std::cout << "RESP_RAW factor" << factor << " " << detail << std::endl;
        expect(("filter-response-passband-flat" + tag).c_str(), passband >= -0.05, detail);
        expect(
            ("filter-response-cutoff-minus6db" + tag).c_str(),
            std::abs(cutoff + 6.03) <= 0.3, detail);
        expect(("filter-response-stopband-entry" + tag).c_str(), stopEntry <= -80.0, detail);
        expect(("filter-response-alias-band-worst" + tag).c_str(), worst <= -80.0, detail);
    }

    // --- Layer 2: what the encoder actually receives, in PCM16 --------------
    //
    // A tone between the new Nyquist (24 kHz) and the old one aliases on the way
    // down: 36 kHz folds to 12 kHz at 48 kHz, so the decimator's low-pass has to
    // remove it BEFORE frames are dropped — a box average leaves it at roughly
    // 38%. Goertzel reads the 12 kHz bin out of the output; the leading frames
    // are skipped because the filter starts cold.
    const auto measureTone = [&](const AudioInputFormat& sourceFormat,
                                 unsigned toneHz,
                                 unsigned readHz) -> double {
        const double amplitude = 16384.0;
        const size_t toneFrames = static_cast<size_t>(sourceFormat.sampleRate) / 4;
        std::vector<BYTE> toneBytes(toneFrames * sourceFormat.blockAlign, 0);
        auto* toneSamples = reinterpret_cast<int16_t*>(toneBytes.data());
        for (size_t frame = 0; frame < toneFrames; frame += 1) {
            const double phase = 2.0 * 3.14159265358979323846 * static_cast<double>(toneHz) *
                static_cast<double>(frame) / static_cast<double>(sourceFormat.sampleRate);
            const auto value = static_cast<int16_t>(std::lround(amplitude * std::sin(phase)));
            toneSamples[frame * 2] = value;
            toneSamples[frame * 2 + 1] = value;
        }
        std::vector<BYTE> toneOut;
        convertAudioWithGain(
            toneBytes.data(), static_cast<DWORD>(toneBytes.size()), sourceFormat, target48k, 1.0, toneOut);
        const size_t outFrames = toneOut.size() / target48k.blockAlign;
        const auto* outSamples = reinterpret_cast<const int16_t*>(toneOut.data());
        const size_t skip = std::min<size_t>(2400, outFrames / 4);
        double s1 = 0.0;
        double s2 = 0.0;
        const double omega = 2.0 * 3.14159265358979323846 * static_cast<double>(readHz) /
            static_cast<double>(target48k.sampleRate);
        const double coeff = 2.0 * std::cos(omega);
        size_t counted = 0;
        for (size_t frame = skip; frame < outFrames; frame += 1) {
            const double sample = static_cast<double>(outSamples[frame * 2]);
            const double s0 = sample + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
            counted += 1;
        }
        const double magnitude = counted == 0
            ? 0.0
            : 2.0 * std::sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / static_cast<double>(counted);
        return magnitude <= 0.0 ? -300.0 : 20.0 * std::log10(magnitude / amplitude);
    };
    const auto expectTone = [&](const AudioInputFormat& sourceFormat,
                                unsigned toneHz,
                                unsigned readHz,
                                bool below,
                                double limitDb,
                                const char* name) {
        const double db = measureTone(sourceFormat, toneHz, readHz);
        char detail[112]{};
        sprintf_s(detail, "%u Hz in, %u Hz out = %.2f dB", toneHz, readHz, db);
        std::cout << "TONE_RAW " << name << " " << detail << std::endl;
        expect(name, below ? db < limitDb : db > limitDb, detail);
    };
    const AudioInputFormat source192k = makeFormat(MFAudioFormat_PCM, 192000, 2, 16);
    // Everything above the 24 kHz output Nyquist folds somewhere into the band,
    // so one example is not coverage. Each of these names where it lands:
    // f mod 48000, reflected about 24000.
    expectTone(source96k, 25000, 23000, true, -60.0, "resample-96k-25k-alias");
    expectTone(source96k, 30000, 18000, true, -60.0, "resample-96k-30k-alias");
    expectTone(source96k, 36000, 12000, true, -60.0, "resample-96k-36k-alias-below-minus60db");
    // 47 kHz folds to exactly 1 kHz, which is where the passband control sits.
    // It therefore does double duty: if the control were ever reading an alias
    // rather than the real passband, this case would expose it.
    expectTone(source96k, 47000, 1000, true, -60.0, "resample-96k-47k-alias-onto-passband");
    expectTone(source192k, 25000, 23000, true, -60.0, "resample-192k-25k-alias");
    expectTone(source192k, 36000, 12000, true, -60.0, "resample-192k-36k-alias-below-minus60db");
    expectTone(source192k, 50000, 2000, true, -60.0, "resample-192k-50k-alias");
    expectTone(source192k, 70000, 22000, true, -60.0, "resample-192k-70k-alias");
    expectTone(source192k, 90000, 6000, true, -60.0, "resample-192k-90k-alias");
    // The alias assertions above are satisfied by silence, so the passband is
    // asserted alongside them: these tones have to come through at their level.
    expectTone(source96k, 1000, 1000, false, -0.5, "resample-96k-1k-passband-intact");
    expectTone(source192k, 1000, 1000, false, -0.5, "resample-192k-1k-passband-intact");
    expectTone(source96k, 15000, 15000, false, -0.5, "resample-96k-15k-passband-intact");
    expectTone(source192k, 15000, 15000, false, -0.5, "resample-192k-15k-passband-intact");

    // The filter reaches back further than one packet, so the same stream cut
    // into ragged packets has to come out bit-identical to one long call, with
    // the same number of frames still pending. This is what "stateful" has to
    // mean at a packet boundary, and it is checked for every factor rather than
    // for the one that happens to be commonest: a partition bug that only shows
    // up when the group is longer than two frames would hide at factor 2.
    const auto expectPartitionIdentical = [&](const AudioInputFormat& sourceFormat,
                                              const char* name) {
        const size_t streamFrames = 9600;
        std::vector<BYTE> stream(streamFrames * sourceFormat.blockAlign, 0);
        auto* streamSamples = reinterpret_cast<int16_t*>(stream.data());
        for (size_t frame = 0; frame < streamFrames; frame += 1) {
            const double phase = 2.0 * kTestPi * 7000.0 *
                static_cast<double>(frame) / static_cast<double>(sourceFormat.sampleRate);
            const auto value = static_cast<int16_t>(std::lround(12000.0 * std::sin(phase)));
            streamSamples[frame * 2] = value;
            streamSamples[frame * 2 + 1] = static_cast<int16_t>(-value);
        }
        AudioDecimatorState whole;
        std::vector<BYTE> wholeOut;
        convertAudioWithGain(
            stream.data(), static_cast<DWORD>(stream.size()), sourceFormat, target48k, 1.0,
            wholeOut, whole);

        AudioDecimatorState split;
        std::vector<BYTE> splitOut;
        std::vector<BYTE> piece;
        const size_t chunks[] = {1, 2, 3, 5, 8, 13, 21, 34, 55, 89};
        size_t cursor = 0;
        size_t index = 0;
        while (cursor < streamFrames) {
            const size_t frames = std::min(chunks[index % 10], streamFrames - cursor);
            index += 1;
            convertAudioWithGain(
                stream.data() + cursor * sourceFormat.blockAlign,
                static_cast<DWORD>(frames * sourceFormat.blockAlign),
                sourceFormat,
                target48k,
                1.0,
                piece,
                split);
            splitOut.insert(splitOut.end(), piece.begin(), piece.end());
            cursor += frames;
        }
        // Frame accounting is the other half: however the stream was cut, the
        // decimator must have produced exactly floor(total/factor) frames and be
        // holding exactly total%factor.
        const UINT32 factor = sourceFormat.sampleRate / target48k.sampleRate;
        const size_t expectedOut = streamFrames / factor;
        const size_t expectedPending = streamFrames % factor;
        expect(
            name,
            wholeOut == splitOut && whole.pendingFrames() == split.pendingFrames() &&
                splitOut.size() / target48k.blockAlign == expectedOut &&
                split.pendingFrames() == expectedPending,
            "whole=" + std::to_string(wholeOut.size()) + " split=" + std::to_string(splitOut.size()) +
                " frames=" + std::to_string(splitOut.size() / target48k.blockAlign) +
                " want=" + std::to_string(expectedOut) +
                " pending=" + std::to_string(split.pendingFrames()) +
                " wantPending=" + std::to_string(expectedPending));
    };

    // 144 kHz and 288 kHz are not rates a sound card is likely to report; they
    // are here because the entry point is generic in `factor` and must be shown
    // to be, rather than tuned for the two ratios real hardware reaches.
    const AudioInputFormat source144k = makeFormat(MFAudioFormat_PCM, 144000, 2, 16);
    const AudioInputFormat source288k = makeFormat(MFAudioFormat_PCM, 288000, 2, 16);
    expectPartitionIdentical(source96k, "resample-96k-packet-partition-bit-identical");
    expectPartitionIdentical(source144k, "resample-144k-f3-packet-partition-bit-identical");
    expectPartitionIdentical(source192k, "resample-192k-f4-packet-partition-bit-identical");
    expectPartitionIdentical(source288k, "resample-288k-f6-packet-partition-bit-identical");

    // Alias and passband at the two non-{2,4} factors, for the same reason.
    expectTone(source144k, 36000, 12000, true, -60.0, "resample-144k-f3-36k-alias");
    expectTone(source288k, 36000, 12000, true, -60.0, "resample-288k-f6-36k-alias");
    expectTone(source144k, 1000, 1000, false, -0.5, "resample-144k-f3-1k-passband-intact");
    expectTone(source288k, 1000, 1000, false, -0.5, "resample-288k-f6-1k-passband-intact");

    // --- The state machine, independent of the filter's quality -------------

    // A group is only complete once all `factor` of its frames have arrived, and
    // at factor 4 there are three ways to be part-way through. Factor 2 has only
    // one, so exercising it alone leaves the interesting arithmetic untested.
    {
        AudioDecimatorState state;
        std::vector<BYTE> one(source192k.blockAlign, 0);
        auto* s = reinterpret_cast<int16_t*>(one.data());
        s[0] = 4000;
        s[1] = -4000;
        std::vector<BYTE> out;
        bool ok = true;
        std::string detail;
        for (size_t pending = 1; pending <= 3; pending += 1) {
            convertAudioWithGain(
                one.data(), static_cast<DWORD>(one.size()), source192k, target48k, 1.0, out, state);
            ok = ok && out.empty() && state.pendingFrames() == pending;
            detail += " after" + std::to_string(pending) + "=" +
                std::to_string(state.pendingFrames());
        }
        convertAudioWithGain(
            one.data(), static_cast<DWORD>(one.size()), source192k, target48k, 1.0, out, state);
        ok = ok && out.size() == target48k.blockAlign && state.pendingFrames() == 0;
        expect(
            "resample-192k-f4-pending-counts-1-2-3", ok,
            detail + " after4=" + std::to_string(state.pendingFrames()) + " out=" +
                std::to_string(out.size()));
    }

    // reset() has to mean cold, not nearly cold. start() and beginTimeline()
    // call it, and a resume reaches it through resetSources(); setPaused(true)
    // deliberately does NOT -- it preserves the queued audio and both
    // resampler states so the cushion flush can write them (the resume clears
    // both). Anything reset() left behind would be audible in the first
    // frames after a pause.
    {
        const size_t warmFrames = 512;
        const size_t tailFrames = 2048;
        std::vector<BYTE> stream((warmFrames + tailFrames) * source96k.blockAlign, 0);
        auto* s = reinterpret_cast<int16_t*>(stream.data());
        for (size_t i = 0; i < warmFrames + tailFrames; i += 1) {
            const double phase =
                2.0 * kTestPi * 5000.0 * static_cast<double>(i) / source96k.sampleRate;
            const auto v = static_cast<int16_t>(std::lround(9000.0 * std::sin(phase)));
            s[i * 2] = v;
            s[i * 2 + 1] = v;
        }
        const BYTE* tail = stream.data() + warmFrames * source96k.blockAlign;
        const DWORD tailBytes = static_cast<DWORD>(tailFrames * source96k.blockAlign);

        AudioDecimatorState used;
        std::vector<BYTE> scratch;
        convertAudioWithGain(
            stream.data(), static_cast<DWORD>(warmFrames * source96k.blockAlign), source96k,
            target48k, 1.0, scratch, used);
        used.reset();
        std::vector<BYTE> afterReset;
        convertAudioWithGain(tail, tailBytes, source96k, target48k, 1.0, afterReset, used);

        AudioDecimatorState fresh;
        std::vector<BYTE> fromCold;
        convertAudioWithGain(tail, tailBytes, source96k, target48k, 1.0, fromCold, fresh);

        expect(
            "resample-96k-reset-equals-cold-start",
            afterReset == fromCold && !afterReset.empty(),
            "reset=" + std::to_string(afterReset.size()) + " cold=" +
                std::to_string(fromCold.size()));
    }

    // WASAPI delivers no packets while a loopback source is silent; the capture
    // layer synthesizes zero frames and pushes them through the SAME callback
    // (emitSilenceFrames in wasapi_loopback_capture.cpp). Those frames have to be
    // CONSUMED rather than skipped: skipping them would slide the decimation
    // phase and shorten the take. Ragged packets, two silent stretches, and a
    // total that is deliberately not a multiple of the factor.
    {
        const size_t totalFrames = 7777;
        std::vector<BYTE> stream(totalFrames * source96k.blockAlign, 0);
        auto* s = reinterpret_cast<int16_t*>(stream.data());
        for (size_t i = 0; i < totalFrames; i += 1) {
            const bool silent = (i > 1500 && i < 3000) || (i > 5000 && i < 5100);
            if (silent) {
                continue;
            }
            const double phase =
                2.0 * kTestPi * 3000.0 * static_cast<double>(i) / source96k.sampleRate;
            const auto v = static_cast<int16_t>(std::lround(8000.0 * std::sin(phase)));
            s[i * 2] = v;
            s[i * 2 + 1] = v;
        }
        AudioDecimatorState state;
        std::vector<BYTE> piece;
        size_t produced = 0;
        const size_t chunks[] = {480, 1, 960, 2, 4800, 3, 1, 1};
        size_t cursor = 0;
        size_t index = 0;
        while (cursor < totalFrames) {
            const size_t frames = std::min(chunks[index % 8], totalFrames - cursor);
            index += 1;
            convertAudioWithGain(
                stream.data() + cursor * source96k.blockAlign,
                static_cast<DWORD>(frames * source96k.blockAlign),
                source96k, target48k, 1.0, piece, state);
            produced += piece.size() / target48k.blockAlign;
            cursor += frames;
        }
        expect(
            "resample-96k-gap-silence-frames-are-counted",
            produced == totalFrames / 2 && state.pendingFrames() == totalFrames % 2,
            "produced=" + std::to_string(produced) + " want=" +
                std::to_string(totalFrames / 2) + " pending=" +
                std::to_string(state.pendingFrames()));
    }

    // One state handed packets of different shapes. The decimating branch is not
    // the only one that touches it: the pass-through and interpolation branches
    // reset it, which is the contract that stops a half-finished group bleeding
    // across a format boundary. In this helper the format is fixed for the
    // session so production never switches, but the entry point is shared, so
    // the contract is checked here rather than assumed.
    {
        const size_t frames = 1024;
        std::vector<BYTE> hi(frames * source96k.blockAlign, 0);
        auto* h = reinterpret_cast<int16_t*>(hi.data());
        for (size_t i = 0; i < frames; i += 1) {
            const double phase =
                2.0 * kTestPi * 4000.0 * static_cast<double>(i) / source96k.sampleRate;
            const auto v = static_cast<int16_t>(std::lround(7000.0 * std::sin(phase)));
            h[i * 2] = v;
            h[i * 2 + 1] = v;
        }
        // An odd frame count leaves exactly one frame pending, so a missing reset
        // shows up as a shifted phase instead of needing luck to detect.
        const DWORD oddBytes = static_cast<DWORD>((frames - 1) * source96k.blockAlign);
        std::vector<BYTE> passthrough(64 * target48k.blockAlign, 0);
        const AudioInputFormat source44k = makeFormat(MFAudioFormat_PCM, 44100, 2, 16);
        std::vector<BYTE> odd(64 * source44k.blockAlign, 0);

        AudioDecimatorState reused;
        std::vector<BYTE> scratch;
        convertAudioWithGain(hi.data(), oddBytes, source96k, target48k, 1.0, scratch, reused);
        const bool pendingBefore = reused.pendingFrames() == 1;
        convertAudioWithGain(
            passthrough.data(), static_cast<DWORD>(passthrough.size()), target48k, target48k, 1.0,
            scratch, reused);
        const bool clearedByPassthrough = reused.pendingFrames() == 0;
        convertAudioWithGain(hi.data(), oddBytes, source96k, target48k, 1.0, scratch, reused);
        convertAudioWithGain(
            odd.data(), static_cast<DWORD>(odd.size()), source44k, target48k, 1.0, scratch, reused);
        const bool clearedByInterpolation = reused.pendingFrames() == 0;

        std::vector<BYTE> afterMix;
        convertAudioWithGain(
            hi.data(), static_cast<DWORD>(hi.size()), source96k, target48k, 1.0, afterMix, reused);
        AudioDecimatorState fresh;
        std::vector<BYTE> fromCold;
        convertAudioWithGain(
            hi.data(), static_cast<DWORD>(hi.size()), source96k, target48k, 1.0, fromCold, fresh);

        expect(
            "resample-state-reused-across-formats",
            pendingBefore && clearedByPassthrough && clearedByInterpolation &&
                afterMix == fromCold && !afterMix.empty(),
            "pendingBefore=" + std::to_string(pendingBefore) + " passthrough=" +
                std::to_string(clearedByPassthrough) + " interp=" +
                std::to_string(clearedByInterpolation) + " match=" +
                std::to_string(afterMix == fromCold));
    }

    auto fillStereoFrame = [](std::vector<BYTE>& packet, int16_t left, int16_t right) {
        auto* samples = reinterpret_cast<int16_t*>(packet.data());
        samples[0] = left;
        samples[1] = right;
    };
    const auto destFrames = [&](const std::vector<BYTE>& out) -> size_t {
        return target48k.blockAlign == 0 ? 0 : out.size() / target48k.blockAlign;
    };
    // The frames a packet leaves in an unfinished group are inside the filter
    // now rather than parked as bytes, so the accounting is read off the state.
    AudioDecimatorState decimator;
    std::vector<BYTE> shortPkt(source96k.blockAlign, 0);
    fillStereoFrame(shortPkt, 12345, -12345);
    std::vector<BYTE> shortOut;
    convertAudioWithGain(
        shortPkt.data(),
        static_cast<DWORD>(shortPkt.size()),
        source96k,
        target48k,
        1.0,
        shortOut,
        decimator);
    expect(
        "resample-96k-short-packet",
        shortOut.empty() && decimator.pendingFrames() == 1,
        "dest=" + std::to_string(shortOut.size()) + " pending=" + std::to_string(decimator.pendingFrames()));

    decimator.reset();
    std::vector<BYTE> oneA(source96k.blockAlign, 0);
    std::vector<BYTE> oneB(source96k.blockAlign, 0);
    fillStereoFrame(oneA, 1000, 2000);
    fillStereoFrame(oneB, 3000, 4000);
    std::vector<BYTE> outA;
    std::vector<BYTE> outB;
    convertAudioWithGain(oneA.data(), static_cast<DWORD>(oneA.size()), source96k, target48k, 1.0, outA, decimator);
    convertAudioWithGain(oneB.data(), static_cast<DWORD>(oneB.size()), source96k, target48k, 1.0, outB, decimator);
    expect(
        "resample-96k-one-frame-packets",
        destFrames(outA) == 0 && destFrames(outB) == 1 && decimator.pendingFrames() == 0,
        "a=" + std::to_string(destFrames(outA)) + " b=" + std::to_string(destFrames(outB)) +
            " pending=" + std::to_string(decimator.pendingFrames()));

    decimator.reset();
    std::vector<BYTE> threePkt(3 * source96k.blockAlign, 0);
    std::vector<BYTE> onePkt(source96k.blockAlign, 0);
    fillStereoFrame(onePkt, 5000, 6000);
    std::vector<BYTE> threeOut;
    std::vector<BYTE> oneOut;
    convertAudioWithGain(
        threePkt.data(), static_cast<DWORD>(threePkt.size()), source96k, target48k, 1.0, threeOut, decimator);
    convertAudioWithGain(
        onePkt.data(), static_cast<DWORD>(onePkt.size()), source96k, target48k, 1.0, oneOut, decimator);
    expect(
        "resample-96k-remainder-three-then-one",
        destFrames(threeOut) == 1 && destFrames(oneOut) == 1 && decimator.pendingFrames() == 0,
        "three=" + std::to_string(destFrames(threeOut)) + " one=" + std::to_string(destFrames(oneOut)) +
            " pending=" + std::to_string(decimator.pendingFrames()));

    decimator.reset();
    std::vector<BYTE> remainderFullOut;
    convertAudioWithGain(
        source.data(),
        static_cast<DWORD>(source.size()),
        source96k,
        target48k,
        1.0,
        remainderFullOut,
        decimator);
    const size_t remainderFullFrames = destFrames(remainderFullOut);
    const bool remainderFullOk =
        remainderFullFrames == 48000 || remainderFullFrames == 47999 || remainderFullFrames == 48001;
    expect(
        "resample-96k-remainder-full",
        remainderFullOk && decimator.pendingFrames() == 0,
        "frames=" + std::to_string(remainderFullFrames) + " pending=" + std::to_string(decimator.pendingFrames()));

    // --- Channel mapping and gain, ON the decimation branch ------------------
    //
    // Everything above this point drives the decimator with both channels
    // carrying identical content and a gain of 1.0, so neither the channel
    // mapping nor the gain multiply is actually pinned on this branch. Two
    // deliberate mutations -- forcing readMappedChannel's target channel to 0,
    // and dropping the `* gain` from the write -- passed the entire suite. The
    // contract names both as things that must not regress, so they get an
    // assertion here rather than an assumption.
    //
    // Distinct per-channel frequencies are the point: identical channels cannot
    // distinguish "mapped correctly" from "left copied into both".
    {
        constexpr size_t kMapWindow = 4800;   // 0.1 s at 48 kHz -> 10 Hz bins
        constexpr size_t kMapSkip = 256;      // past the filter's startup ramp
        constexpr double kLeftHz = 1000.0;    // both are multiples of 10 Hz, so
        constexpr double kRightHz = 5000.0;   // each is periodic in the window
        constexpr double kMapAmplitude = 0.3;
        const size_t mapSourceFrames = (kMapWindow + kMapSkip) * 2 + 4096;

        std::vector<BYTE> mapped(mapSourceFrames * source96k.blockAlign, 0);
        auto* mappedSamples = reinterpret_cast<int16_t*>(mapped.data());
        for (size_t frame = 0; frame < mapSourceFrames; frame += 1) {
            const double time = static_cast<double>(frame) / source96k.sampleRate;
            mappedSamples[frame * 2] = static_cast<int16_t>(std::lround(
                kMapAmplitude * 32767.0 * std::sin(2.0 * kTestPi * kLeftHz * time)));
            mappedSamples[frame * 2 + 1] = static_cast<int16_t>(std::lround(
                kMapAmplitude * 32767.0 * std::sin(2.0 * kTestPi * kRightHz * time)));
        }

        // Goertzel over interleaved PCM16, on a NAMED channel, in dBFS.
        const auto binDbChannel = [&](const std::vector<BYTE>& pcm, UINT32 channel,
                                      double hz) -> double {
            const size_t available = pcm.size() / target48k.blockAlign;
            if (available <= kMapSkip) {
                return -300.0;
            }
            const size_t n = std::min(kMapWindow, available - kMapSkip);
            const auto* s = reinterpret_cast<const int16_t*>(pcm.data());
            const double w = 2.0 * kTestPi * hz / target48k.sampleRate;
            const double c = 2.0 * std::cos(w);
            double s1 = 0.0;
            double s2 = 0.0;
            for (size_t i = 0; i < n; i += 1) {
                const double v = static_cast<double>(s[(kMapSkip + i) * 2 + channel]);
                const double s0 = v + c * s1 - s2;
                s2 = s1;
                s1 = s0;
            }
            const double mag = 2.0 * std::sqrt(std::max(0.0, s1 * s1 + s2 * s2 - c * s1 * s2)) /
                static_cast<double>(n);
            return mag <= 0.0 ? -300.0 : 20.0 * std::log10(mag / 32768.0);
        };

        AudioDecimatorState mapDecimator;
        std::vector<BYTE> mappedOut;
        convertAudioWithGain(
            mapped.data(),
            static_cast<DWORD>(mapped.size()),
            source96k,
            target48k,
            1.0,
            mappedOut,
            mapDecimator);

        const double leftAtLeft = binDbChannel(mappedOut, 0, kLeftHz);
        const double leftAtRight = binDbChannel(mappedOut, 0, kRightHz);
        const double rightAtRight = binDbChannel(mappedOut, 1, kRightHz);
        const double rightAtLeft = binDbChannel(mappedOut, 1, kLeftHz);
        std::cout << "CHANMAP_RAW L@1k=" << leftAtLeft << " L@5k=" << leftAtRight
                  << " R@5k=" << rightAtRight << " R@1k=" << rightAtLeft << " dBFS" << std::endl;

        // 0.3 FS is -10.46 dBFS. Each channel must carry its OWN tone at full
        // level and the other channel's tone at least 60 dB down -- the leak
        // floor is set by PCM16 quantization, not by the filter.
        expect(
            "resample-96k-channel-mapping-preserved",
            leftAtLeft > -11.0 && rightAtRight > -11.0 &&
                leftAtRight < leftAtLeft - 60.0 && rightAtLeft < rightAtRight - 60.0,
            "L@1k=" + std::to_string(leftAtLeft) + " L@5k=" + std::to_string(leftAtRight) +
                " R@5k=" + std::to_string(rightAtRight) + " R@1k=" + std::to_string(rightAtLeft));

        // Same input, half gain: every bin must move by exactly -6.02 dB. An
        // ignored gain argument leaves it at 0 dB, a doubled one at -12.
        AudioDecimatorState gainDecimator;
        std::vector<BYTE> halfGainOut;
        convertAudioWithGain(
            mapped.data(),
            static_cast<DWORD>(mapped.size()),
            source96k,
            target48k,
            0.5,
            halfGainOut,
            gainDecimator);

        const double halfLeft = binDbChannel(halfGainOut, 0, kLeftHz);
        const double halfRight = binDbChannel(halfGainOut, 1, kRightHz);
        const double leftDelta = leftAtLeft - halfLeft;
        const double rightDelta = rightAtRight - halfRight;
        std::cout << "GAIN_RAW half-gain delta L=" << leftDelta << " R=" << rightDelta
                  << " dB (expect 6.02)" << std::endl;
        expect(
            "resample-96k-gain-applied-on-decimation-branch",
            std::abs(leftDelta - 6.0206) < 0.2 && std::abs(rightDelta - 6.0206) < 0.2 &&
                halfGainOut.size() == mappedOut.size(),
            "dL=" + std::to_string(leftDelta) + " dR=" + std::to_string(rightDelta) +
                " bytes=" + std::to_string(halfGainOut.size()) + "/" +
                std::to_string(mappedOut.size()));
    }

    // --- Overshoot: the level change this filter introduces -----------------
    //
    // A box average cannot exceed its input peak; this filter can, because a
    // transition this sharp needs negative taps. Two things are pinned here.
    // First the size, so the +1.4 to +1.5 dB documented beside the filter design
    // for a 1 kHz square cannot go stale (a square with a higher fundamental
    // overshoots more, up to about +3.8 dB, still under the taps' ceiling): a near-full-scale square wave (the Gibbs case) read straight out
    // of the decimator, before anything clamps -- every convert entry point
    // clamps, float targets included, so this is the only place it is visible.
    // Second, what happens to it: overshoot must saturate at full scale, never
    // wrap. A PCM16 write that skipped its clamp would turn a +1.12 FS peak into
    // a large negative sample -- an audible click -- and before this assertion
    // existed that mutation passed the entire suite, because nothing else drove
    // this branch past 1.0.
    {
        const auto squareAt = [](size_t frame, UINT32 rate, double amplitude) {
            const double phase =
                std::fmod(static_cast<double>(frame) * 1000.0 / static_cast<double>(rate), 1.0);
            return phase < 0.5 ? amplitude : -amplitude;
        };

        std::string gibbsDetail;
        bool gibbsOk = true;
        for (UINT32 factor : {2u, 3u, 4u, 6u, 8u, 12u, 24u}) {
            const UINT32 rate = 48000 * factor;
            AudioDecimatorState gibbsState;
            gibbsState.prepare(factor, 1);
            double peak = 0.0;
            double filteredValue = 0.0;
            for (size_t frame = 0; frame < rate; frame += 1) {
                const double in = squareAt(frame, rate, 0.95);
                if (gibbsState.consume(&in, &filteredValue) &&
                    frame > static_cast<size_t>(4 * 80 * factor)) {
                    peak = std::max(peak, std::abs(filteredValue));
                }
            }
            const double overshootDb = 20.0 * std::log10(peak / 0.95);
            gibbsOk = gibbsOk && overshootDb > 1.3 && overshootDb < 1.6;
            gibbsDetail += "f" + std::to_string(factor) + "=" + std::to_string(overshootDb) + "dB ";
        }
        std::cout << "OVERSHOOT_RAW square 0.95 FS " << gibbsDetail << std::endl;
        expect("filter-overshoot-square-is-gibbs", gibbsOk, gibbsDetail);

        // Same square, 96 kHz PCM16 in, 48 kHz PCM16 out, checked sample by
        // sample against the filter output computed through a second decimator
        // state and clamped here. That reference shares any consume() defect by
        // construction -- the Gibbs check above is what covers the filter; this
        // one isolates what happens after it: gain, the clamp, and rounding to
        // PCM16. Both channels are compared, but they carry the same signal, so
        // which channel a sample lands in is the channel-mapping test's job.
        // Three gains, because a clamp that is right on one channel only, or
        // right up to some level and wraps above it, passes a single unity-gain
        // check on the left channel -- but it sees only the levels these cases
        // reach, not every level. The tolerance is half an LSB, which correct
        // rounding meets and truncation does not. Gain is live on this branch:
        // the microphone's is a fixed 1.4 today, though the native parser would
        // accept any value, and the filter's own ceiling is about 2.2x.
        const size_t squareFrames = 48000;  // 0.5 s at 96 kHz
        std::vector<BYTE> square(squareFrames * source96k.blockAlign, 0);
        auto* squareSamples = reinterpret_cast<int16_t*>(square.data());
        std::vector<double> squareLeft(squareFrames);
        for (size_t frame = 0; frame < squareFrames; frame += 1) {
            const int16_t v =
                static_cast<int16_t>(std::lround(squareAt(frame, 96000, 0.95) * 32767.0));
            squareSamples[frame * 2] = v;
            squareSamples[frame * 2 + 1] = v;
            squareLeft[frame] = static_cast<double>(v) / 32768.0;
        }

        AudioDecimatorState reference;
        reference.prepare(2, 1);
        std::vector<double> unclamped;
        unclamped.reserve(squareFrames / 2);
        double referenceOut = 0.0;
        for (size_t frame = 0; frame < squareFrames; frame += 1) {
            if (reference.consume(&squareLeft[frame], &referenceOut)) {
                unclamped.push_back(referenceOut);
            }
        }
        size_t overshootAtUnity = 0;
        for (double v : unclamped) {
            if (std::abs(v) > 1.0) {
                overshootAtUnity += 1;
            }
        }

        std::string clampDetail = "overshootAtUnity=" + std::to_string(overshootAtUnity);
        bool clampOk = overshootAtUnity > 0 && unclamped.size() == squareFrames / 2;
        for (double testGain : {1.0, 2.0, 8.0}) {
            AudioDecimatorState squareState;
            std::vector<BYTE> squareOut;
            convertAudioWithGain(
                square.data(), static_cast<DWORD>(square.size()), source96k, target48k,
                testGain, squareOut, squareState);
            const auto* outSamples = reinterpret_cast<const int16_t*>(squareOut.data());
            const size_t outFrames = squareOut.size() / target48k.blockAlign;
            double worstErrorLsb = 0.0;
            size_t saturatedSamples = 0;
            for (size_t outFrame = 0; outFrame < outFrames && outFrame < unclamped.size();
                 outFrame += 1) {
                const double wanted =
                    std::clamp(unclamped[outFrame] * testGain, -1.0, 1.0) * 32767.0;
                for (UINT32 outChannel = 0; outChannel < 2; outChannel += 1) {
                    const double got = static_cast<double>(outSamples[outFrame * 2 + outChannel]);
                    worstErrorLsb = std::max(worstErrorLsb, std::abs(got - wanted));
                    if (std::abs(got) >= 32766.0) {
                        saturatedSamples += 1;
                    }
                }
            }
            clampOk = clampOk && outFrames == unclamped.size() && worstErrorLsb <= 0.5 + 1e-6 &&
                saturatedSamples > 0;
            char part[128]{};
            sprintf_s(part, " g%.0f:err=%.3fLSB,sat=%zu,frames=%zu", testGain, worstErrorLsb,
                      saturatedSamples, outFrames);
            clampDetail += part;
        }
        std::cout << "CLAMP_RAW " << clampDetail << std::endl;
        // overshootAtUnity > 0 is what keeps the unity-gain case from passing
        // vacuously: a filter that stopped overshooting would leave nothing
        // there to clamp. (At gains 2 and 8 even a box average saturates.)
        expect("resample-96k-overshoot-clamps-not-wraps", clampOk, clampDetail);
    }

    // --- Group delay, asserted against the ideal it claims to be ------------
    //
    // The filter's own delay is (N-1)/2 = 40*factor SOURCE frames, but output
    // frame j is emitted at source index j*factor + (factor-1), so decimation
    // hands (factor-1) of them back. Net: 39 + 1/factor OUTPUT frames -- 39.5 at
    // factor 2 down to 39.04 at factor 24, never the flat 40 it looks like.
    //
    // It is asserted by reconstructing the ideal delayed sine and taking the
    // worst-case error, not by argmax of an impulse response: argmax is 39 for
    // every factor and so cannot tell the factors apart. The same assertion
    // doubles as a passband-transparency check, since a filter that got the
    // delay right but coloured the band would fail it.
    {
        const auto delayFit = [&](UINT32 factor, double delayFrames, size_t* settleOut) -> double {
            const UINT32 outRate = 48000;
            const AudioInputFormat src =
                makeFormat(MFAudioFormat_Float, outRate * factor, 2, 32);
            const AudioInputFormat dst = makeFormat(MFAudioFormat_Float, outRate, 2, 32);
            const size_t outFrames = 4800;
            const size_t srcFrames = outFrames * factor;
            const double amplitude = 0.5;
            const double toneHz = 1000.0;
            std::vector<BYTE> in(srcFrames * src.blockAlign, 0);
            auto* inSamples = reinterpret_cast<float*>(in.data());
            for (size_t i = 0; i < srcFrames; i += 1) {
                const double v = amplitude *
                    std::sin(2.0 * kTestPi * toneHz * static_cast<double>(i) / src.sampleRate);
                inSamples[i * 2] = static_cast<float>(v);
                inSamples[i * 2 + 1] = static_cast<float>(v);
            }
            std::vector<BYTE> out;
            convertAudioWithGain(in.data(), static_cast<DWORD>(in.size()), src, dst, 1.0, out);
            const size_t produced = out.size() / dst.blockAlign;
            const auto* outSamples = reinterpret_cast<const float*>(out.data());
            // The steady-state window is FIXED, not derived from where the error
            // happens to fall. An earlier version advanced the window start every
            // time the error exceeded tolerance, which meant a persistently wrong
            // delay pushed the window past every bad sample and reported a small
            // error -- the discrimination assertion below is what caught it.
            const size_t steadyStart = 100;
            double worst = 0.0;
            size_t settle = 0;
            for (size_t j = 0; j < produced; j += 1) {
                const double ideal = amplitude *
                    std::sin(2.0 * kTestPi * toneHz * (static_cast<double>(j) - delayFrames) /
                             outRate);
                const double err = std::abs(static_cast<double>(outSamples[j * 2]) - ideal);
                if (err > 0.002) {
                    settle = j + 1;
                }
                if (j >= steadyStart) {
                    worst = std::max(worst, err);
                }
            }
            if (settleOut != nullptr) {
                *settleOut = settle;
            }
            return worst;
        };

        for (UINT32 factor : {2u, 3u, 4u, 6u}) {
            const double expected = 39.0 + 1.0 / static_cast<double>(factor);
            size_t settle = 0;
            const double atExpected = delayFit(factor, expected, &settle);
            // A tolerance only means something if a wrong answer breaks it. Half
            // an output frame either side is the discrimination check: if the
            // assertion passed at 39.0 and 40.0 as readily as at 39.5, it would
            // not be measuring the delay at all.
            const double atLow = delayFit(factor, expected - 0.5, nullptr);
            const double atHigh = delayFit(factor, expected + 0.5, nullptr);
            const std::string tag = "-f" + std::to_string(factor);
            char detail[192]{};
            sprintf_s(
                detail, "expected=%.4f err=%.6f err(-0.5)=%.5f err(+0.5)=%.5f settleFrames=%zu",
                expected, atExpected, atLow, atHigh, settle);
            std::cout << "DELAY_RAW factor" << factor << " " << detail << std::endl;
            expect(("delay-matches-39-plus-1-over-factor" + tag).c_str(),
                   atExpected < 0.002, detail);
            expect(("delay-tolerance-discriminates" + tag).c_str(),
                   atLow > atExpected * 10.0 && atHigh > atExpected * 10.0, detail);
            // The cold filter ramps in over its own length; after that the output
            // is the ideal delayed sine. Bounding it matters because those frames
            // are the ones a listener hears at the start of every recording.
            expect(("delay-startup-ramp-bounded" + tag).c_str(), settle <= 80, detail);
        }

        // Cross-branch skew. A 48 kHz stream against a 48 kHz target does not
        // decimate, so it carries no filter delay at all -- which means this
        // change introduces a skew between a decimated stream and a
        // non-decimated one where there was effectively none before (the box
        // average it replaces delayed by (factor-1)/2 source frames = 0.25
        // output frames at factor 2). Sub-millisecond, but real, and asserted
        // here so it cannot grow unnoticed.
        {
            const AudioInputFormat src = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
            const AudioInputFormat dst = makeFormat(MFAudioFormat_PCM, 48000, 2, 16);
            const size_t frames = 4800;
            const double amplitude = 0.5;
            std::vector<BYTE> in(frames * src.blockAlign, 0);
            auto* inSamples = reinterpret_cast<float*>(in.data());
            for (size_t i = 0; i < frames; i += 1) {
                const double v = amplitude *
                    std::sin(2.0 * kTestPi * 1000.0 * static_cast<double>(i) / 48000.0);
                inSamples[i * 2] = static_cast<float>(v);
                inSamples[i * 2 + 1] = static_cast<float>(v);
            }
            std::vector<BYTE> out;
            convertAudioWithGain(in.data(), static_cast<DWORD>(in.size()), src, dst, 1.0, out);
            const auto* outSamples = reinterpret_cast<const int16_t*>(out.data());
            const size_t produced = out.size() / dst.blockAlign;
            double worst = 0.0;
            for (size_t j = 16; j < produced; j += 1) {
                const double ideal = amplitude *
                    std::sin(2.0 * kTestPi * 1000.0 * static_cast<double>(j) / 48000.0);
                worst = std::max(
                    worst,
                    std::abs(static_cast<double>(outSamples[j * 2]) / 32768.0 - ideal));
            }
            char detail[128]{};
            sprintf_s(
                detail, "non-decimating path worst error vs zero delay = %.5f (skew is the "
                "decimating path's 39+1/factor)", worst);
            std::cout << "DELAY_RAW cross-branch " << detail << std::endl;
            expect("delay-non-decimating-path-has-none", worst < 0.002, detail);
        }
    }

    // --- Production wiring: the real AudioMixer -----------------------------
    //
    // Everything above calls convertAudioWithGain directly with a state the test
    // owns, so all of it stays green against a mixer that re-initialised the
    // filter on every packet. This is the only thing here that would not.
    //
    // Amplitude is specified rather than inherited: two tones at the 16384 used
    // elsewhere in this file would clip, and the third harmonic of 36 kHz is
    // 108 kHz, which in a 96 kHz-sampled signal lands on exactly 12 kHz -- the
    // bin being read. Clipping distortion would be indistinguishable from
    // decimation aliasing, which is why (d) measures the generator itself.
    {
        const AudioInputFormat system96k = makeFormat(MFAudioFormat_Float, 96000, 2, 32);
        const AudioInputFormat mic48k = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        const size_t probeFrames = 96000 * 5 / 2;  // 2.5 s, pushed before the window opens
        std::vector<BYTE> probe(probeFrames * system96k.blockAlign, 0);
        auto* probeSamples = reinterpret_cast<float*>(probe.data());
        for (size_t i = 0; i < probeFrames; i += 1) {
            const double time = static_cast<double>(i) / system96k.sampleRate;
            const double v = 0.2 * std::sin(2.0 * kTestPi * 36000.0 * time) +
                             0.2 * std::sin(2.0 * kTestPi * 1000.0 * time);
            probeSamples[i * 2] = static_cast<float>(v);
            probeSamples[i * 2 + 1] = static_cast<float>(v);
        }

        // Goertzel over interleaved PCM16, left channel, in dBFS.
        const auto binDbPcm = [&](const std::vector<BYTE>& pcm, double hz, size_t from,
                                  size_t count) -> double {
            const size_t available = pcm.size() / target48k.blockAlign;
            if (from >= available) {
                return -300.0;
            }
            const size_t n = std::min(count, available - from);
            const auto* s = reinterpret_cast<const int16_t*>(pcm.data());
            const double w = 2.0 * kTestPi * hz / target48k.sampleRate;
            const double c = 2.0 * std::cos(w);
            double s1 = 0.0;
            double s2 = 0.0;
            for (size_t i = 0; i < n; i += 1) {
                const double v = static_cast<double>(s[(from + i) * 2]);
                const double s0 = v + c * s1 - s2;
                s2 = s1;
                s1 = s0;
            }
            const double mag = 2.0 * std::sqrt(std::max(0.0, s1 * s1 + s2 * s2 - c * s1 * s2)) /
                static_cast<double>(n);
            return mag <= 0.0 ? -300.0 : 20.0 * std::log10(mag / 32768.0);
        };

        // (d) The generator control, measured on the 96 kHz INPUT buffer.
        // 12 kHz is an ordinary in-band frequency at 96 kHz, so if the generator
        // put anything there -- clipping, rounding, a wrong constant -- it would
        // pass through the filter untouched and be read at the output as if it
        // were an alias. This is why the earlier plan's control (measuring the
        // same signal through a 48 kHz source) was abandoned: 36 kHz cannot
        // exist in a 48 kHz sampled signal at all.
        {
            const double w = 2.0 * kTestPi * 12000.0 / system96k.sampleRate;
            const double c = 2.0 * std::cos(w);
            double s1 = 0.0;
            double s2 = 0.0;
            for (size_t i = 0; i < probeFrames; i += 1) {
                const double s0 = static_cast<double>(probeSamples[i * 2]) + c * s1 - s2;
                s2 = s1;
                s1 = s0;
            }
            const double mag = 2.0 * std::sqrt(std::max(0.0, s1 * s1 + s2 * s2 - c * s1 * s2)) /
                static_cast<double>(probeFrames);
            const double db = mag <= 0.0 ? -300.0 : 20.0 * std::log10(mag / 0.2);
            char detail[96]{};
            sprintf_s(detail, "input 12 kHz bin = %.2f dB rel tone", db);
            std::cout << "MIXER_RAW generator-control " << detail << std::endl;
            expect("mixer-generator-has-no-12k", db < -100.0, detail);
        }

        const uint32_t chunkFrames = target48k.sampleRate / 100;  // the mixer's 10 ms cadence
        const size_t windowStart = static_cast<size_t>(chunkFrames) * 10;
        const size_t windowFrames = static_cast<size_t>(target48k.sampleRate) / 2;  // 0.5 s

        const auto runMixer = [&](bool includeMic, const char* label) {
            std::mutex guard;
            std::vector<BYTE> collected;
            size_t chunkCount = 0;
            size_t zeroChunks = 0;

            AudioMixer mixer(
                target48k, system96k, mic48k, true, includeMic, 1.0, 1.0,
                [&](const BYTE* data, DWORD byteCount, int64_t, int64_t) {
                    std::scoped_lock lock(guard);
                    chunkCount += 1;
                    bool allZero = true;
                    for (DWORD i = 0; i < byteCount; i += 1) {
                        if (data[i] != 0) {
                            allZero = false;
                            break;
                        }
                    }
                    if (allZero && chunkCount > 10) {
                        zeroChunks += 1;
                    }
                    collected.insert(collected.end(), data, data + byteCount);
                    return true;
                });

            expect((std::string("mixer-start") + label).c_str(), mixer.start(), "");
            // beginTimeline clears both queues and resets both decimators, so the
            // pre-fill has to come after it or it is simply discarded.
            mixer.beginTimeline();

            // Ragged packets, including sub-factor ones. A mixer that reset the
            // filter per packet would drop every 1-frame packet on the floor and
            // restart the filter cold hundreds of times; the alias would return.
            const size_t sizes[] = {1, 2, 3, 5, 8, 13, 21, 480, 960, 1920};
            std::vector<BYTE> silentMic(chunkFrames * mic48k.blockAlign, 0);
            size_t cursor = 0;
            size_t index = 0;
            while (cursor < probeFrames) {
                const size_t frames = std::min(sizes[index % 10], probeFrames - cursor);
                mixer.pushSystem(
                    probe.data() + cursor * system96k.blockAlign,
                    static_cast<DWORD>(frames * system96k.blockAlign));
                if (includeMic && (index % 4) == 0) {
                    // Silent, so it adds nothing to the measurement -- but each
                    // one runs pushMicrophone -> append -> the interpolation
                    // branch, which resets the MICROPHONE decimator. If the two
                    // streams shared one state, that reset would tear the system
                    // filter apart and the alias would come back.
                    mixer.pushMicrophone(
                        silentMic.data(), static_cast<DWORD>(silentMic.size()));
                }
                index += 1;
                cursor += frames;
            }

            const size_t needed = windowStart + windowFrames;
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
            for (;;) {
                {
                    std::scoped_lock lock(guard);
                    if (collected.size() / target48k.blockAlign >= needed) {
                        break;
                    }
                }
                if (std::chrono::steady_clock::now() > deadline) {
                    break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
            mixer.stop();

            std::vector<BYTE> out;
            size_t observedZero = 0;
            {
                std::scoped_lock lock(guard);
                out = collected;
                observedZero = zeroChunks;
            }
            const size_t frames = out.size() / target48k.blockAlign;
            const double alias = binDbPcm(out, 12000.0, windowStart, windowFrames);
            const double pass = binDbPcm(out, 1000.0, windowStart, windowFrames);
            char detail[176]{};
            sprintf_s(
                detail, "alias12k=%.2f dBFS pass1k=%.2f dBFS frames=%zu zeroChunks=%zu",
                alias, pass, frames, observedZero);
            std::cout << "MIXER_RAW " << label << " " << detail << std::endl;

            expect(
                (std::string("mixer-produced-enough") + label).c_str(), frames >= needed, detail);
            // An underrun dilutes the measurement. It would not turn a failing
            // alias into a passing one -- pop()'s zero-fill is rectangular
            // gating, which LEAKS, and leakage from the 1 kHz tone raises the
            // 12 kHz floor -- but a silently diluted measurement is still a
            // broken one, so it fails with its count.
            expect(
                (std::string("mixer-no-underrun") + label).c_str(), observedZero == 0, detail);
            // Ratio inside one stream, so any uniform attenuation cancels...
            // 80 dB, matching the stop band the design budget claims -- not a
            // round number picked for comfort. Measured: a healthy mixer
            // separates these by 101 dB, while a mixer that re-initialised the
            // filter per packet separates them by 63 dB. A 60 dB threshold
            // passed that mutant by 3 dB, which is how this number was chosen.
            expect(
                (std::string("mixer-alias-80db-below-passband") + label).c_str(),
                alias < pass - 80.0, detail);
            // ...and an absolute floor on the passband, so silence fails loudly
            // rather than satisfying the ratio.
            // Tight, not a floor. The probe is 0.2 full scale, so 20*log10(0.2)
            // = -13.98 dBFS is what an unattenuated passband must read, and M7
            // established the filter is unity there to 1e-6. A loose floor here
            // missed a mutant that lost 10.6 dB of signal to per-packet filter
            // restarts, so the assertion is the level itself.
            expect(
                (std::string("mixer-passband-at-full-level") + label).c_str(),
                pass > -15.0, detail);
        };

        runMixer(false, "-system-only");
        runMixer(true, "-with-mic");
    }

    // --- Gain staging: where the microphone gain clamps ----------------------
    //
    // The microphone used to be boosted at push time, clamping to the rails in
    // PCM16 before the system stream was mixed in -- a hot boosted mic arrived
    // flat-topped and the sum then distorted again on top of it. The gain now
    // rides in the double-domain sum and the result clamps exactly once, at the
    // write. DC levels make every post-fill output sample an exact number, so
    // the three cases below pin the arithmetic itself rather than a tendency.
    //
    // float32 in, PCM16 out, both 48 kHz -- the interpolation branch, which is
    // what an ordinary machine's microphone packet takes.
    {
        const AudioInputFormat f32stereo = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        const auto dcPacket = [&](double value, size_t frames) {
            std::vector<BYTE> bytes(frames * f32stereo.blockAlign, 0);
            auto* samples = reinterpret_cast<float*>(bytes.data());
            for (size_t i = 0; i < frames; i += 1) {
                samples[i * 2] = static_cast<float>(value);
                samples[i * 2 + 1] = static_cast<float>(value);
            }
            return bytes;
        };
        const auto steadySample = [&](bool includeSystem, double system, double mic,
                                      double gain, double systemGain = 1.0) -> int {
            std::mutex guard;
            std::vector<BYTE> collected;
            AudioMixer mixer(
                target48k, f32stereo, f32stereo, includeSystem, true, gain, systemGain,
                [&](const BYTE* data, DWORD byteCount, int64_t, int64_t) {
                    std::scoped_lock lock(guard);
                    collected.insert(collected.end(), data, data + byteCount);
                    return true;
                });
            expect("gain-stage-mixer-start", mixer.start(), "");
            mixer.beginTimeline();
            // Far more than the 10 ms cadence can consume in the wait window, so
            // no pop() ever zero-fills into the measured region.
            const auto systemPackets = dcPacket(system, 48000);
            const auto micPackets = dcPacket(mic, 48000);
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
            for (int burst = 0; burst < 20; burst += 1) {
                if (includeSystem) {
                    mixer.pushSystem(systemPackets.data(), static_cast<DWORD>(systemPackets.size()));
                }
                mixer.pushMicrophone(micPackets.data(), static_cast<DWORD>(micPackets.size()));
                std::this_thread::sleep_for(std::chrono::milliseconds(25));
                std::scoped_lock lock(guard);
                // 2 s of output is well past queue fill-in; DC never varies after.
                if (collected.size() >= 2 * 48000 * target48k.blockAlign) {
                    break;
                }
                if (std::chrono::steady_clock::now() > deadline) {
                    break;
                }
            }
            mixer.stop();
            const size_t frames = collected.size() / target48k.blockAlign;
            // The bursts span ~0.65 s of real time and mixLoop emits on the
            // clock, so that is what there is; 0.5 s is far past queue fill-in
            // and DC never varies after it.
            expect("gain-stage-produced-output", frames >= 24000, "frames=" + std::to_string(frames));
            // The last written sample: every one of them is the same number once
            // both queues have delivered, which is what DC buys us.
            const auto* out = reinterpret_cast<const int16_t*>(collected.data());
            return out[(frames - 1) * 2];
        };

        // (1) 0.9 * 1.4 - 0.5 = 0.76 -> 24903. The old clamp-then-sum path read
        // 0.5 (16384) here because the boosted mic was already flat at 1.0.
        {
            const int got = steadySample(true, -0.5, 0.9, 1.4);
            char detail[96]{};
            sprintf_s(detail, "got=%d want=24903", got);
            std::cout << "GAIN_RAW mix-over-system " << detail << std::endl;
            expect("mixer-mic-gain-applied-at-mix", std::abs(got - 24903) <= 2, detail);
        }
        // (2) 0.9 * 1.4 + 0.5 = 1.76 -> clamped once at the rail.
        {
            const int got = steadySample(true, 0.5, 0.9, 1.4);
            char detail[96]{};
            sprintf_s(detail, "got=%d want=32767", got);
            std::cout << "GAIN_RAW sum-clamp " << detail << std::endl;
            expect("mixer-sum-clamps-once-at-rail", got >= 32766, detail);
        }
        // (3) Unity passthrough: the level a mic-only take must ride at, since
        // the request now sends 1.0 when there is no system audio to sit over.
        {
            const int got = steadySample(false, 0.0, 0.9, 1.0);
            char detail[96]{};
            sprintf_s(detail, "got=%d want=29490", got);
            std::cout << "GAIN_RAW unity " << detail << std::endl;
            expect("mixer-unity-gain-passthrough", std::abs(got - 29490) <= 2, detail);
        }
        // (4) The system stream carries its own gain: 0.8 * 0.5 + 0.3 = 0.7
        // -> 22937. A mixer that ignored systemGain would read 0.8 + 0.3 = 1.1
        // clamped at the rail instead.
        {
            const int got = steadySample(true, 0.8, 0.3, 1.0, 0.5);
            char detail[96]{};
            sprintf_s(detail, "got=%d want=22937", got);
            std::cout << "GAIN_RAW system-gain " << detail << std::endl;
            expect("mixer-system-gain-applied-at-mix", std::abs(got - 22937) <= 2, detail);
        }
    }

    // --- Capture jitter: the mixer's cushion (getopenscreen/openscreen#911) ---
    //
    // The capture threads poll WASAPI every 5 ms -- 15.6 ms at the default timer
    // resolution -- and push whatever packets have piled up, while the mixer emits
    // on its own clock. With no margin between the two, every packet that arrived
    // just after the mixer's tick was zero-filled: holes of up to 10 ms in the
    // middle of the voice, heard as a crackle in the recording itself. `capture`
    // below is that loop without WASAPI: a 10 ms packet becomes available every
    // 10 ms from `from`, and a poller that sleeps 5 ms pushes what has piled up.
    {
        using std::chrono::milliseconds;
        using Clock = std::chrono::steady_clock;
        const AudioInputFormat f32 = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        const auto dcPacket = [&](float value) {
            std::vector<BYTE> bytes(480 * f32.blockAlign, 0);
            auto* samples = reinterpret_cast<float*>(bytes.data());
            for (size_t i = 0; i < 480 * 2; i += 1) {
                samples[i] = value;
            }
            return bytes;
        };
        const auto capture = [](const auto& push, Clock::time_point from, int packets,
                                int stallAtPacket, int stallMs) {
            int pushed = 0;
            bool stalled = false;
            while (pushed < packets) {
                const auto now = Clock::now();
                const int available = now < from
                    ? 0
                    : std::min(packets, static_cast<int>((now - from) / milliseconds(10)));
                for (; pushed < available; pushed += 1) {
                    push();
                }
                if (!stalled && pushed >= stallAtPacket) {
                    stalled = true;
                    std::this_thread::sleep_for(milliseconds(stallMs));
                }
                std::this_thread::sleep_for(milliseconds(5));
            }
        };
        // Left channel of everything the mixer writes, from beginTimeline to stop.
        const auto runTake = [&](bool includeSystem, bool includeMic, const auto& drive) {
            std::mutex guard;
            std::vector<int16_t> left;
            AudioMixer mixer(
                target48k, f32, f32, includeSystem, includeMic, 1.0, 1.0,
                [&](const BYTE* data, DWORD byteCount, int64_t, int64_t) {
                    std::scoped_lock lock(guard);
                    const auto* samples = reinterpret_cast<const int16_t*>(data);
                    for (size_t i = 0; i < byteCount / target48k.blockAlign; i += 1) {
                        left.push_back(samples[i * 2]);
                    }
                    return true;
                });
            expect("jitter-mixer-start", mixer.start(), "");
            mixer.beginTimeline();
            drive(mixer, Clock::now());
            mixer.stop();
            std::scoped_lock lock(guard);
            return left;
        };
        const auto msAt = [](size_t frame) { return static_cast<double>(frame) * 1000.0 / 48000.0; };

        // (1) A microphone streaming a steady DC through ordinary poll jitter and one
        // 40 ms stall: every sample between its first and its last must be voiced.
        {
            const auto packet = dcPacket(0.5f);
            const auto left = runTake(false, true, [&](AudioMixer& mixer, Clock::time_point t0) {
                capture(
                    [&] { mixer.pushMicrophone(packet.data(), static_cast<DWORD>(packet.size())); },
                    t0, 120, 50, 40);
            });
            const auto voiced = [](int16_t s) { return s != 0; };
            const auto first = std::find_if(left.begin(), left.end(), voiced);
            const auto last = std::find_if(left.rbegin(), left.rend(), voiced).base();
            const size_t span = first < last ? static_cast<size_t>(last - first) : 0;
            const size_t holes = first < last ? static_cast<size_t>(std::count(first, last, int16_t{0})) : 0;
            char detail[128]{};
            sprintf_s(detail, "span=%zu holes=%zu of 57600 pushed", span, holes);
            std::cout << "JITTER_RAW streaming " << detail << std::endl;
            expect("mixer-streaming-source-has-no-holes", span >= 110 * 480 && holes == 0, detail);
        }

        // (2) The cushion must not move a source that starts after silence -- loopback
        // delivers nothing while nothing plays. Played from 400 ms, it lands there.
        {
            const auto packet = dcPacket(0.5f);
            const auto left = runTake(true, false, [&](AudioMixer& mixer, Clock::time_point t0) {
                capture(
                    [&] { mixer.pushSystem(packet.data(), static_cast<DWORD>(packet.size())); },
                    t0 + milliseconds(400), 30, 1000, 0);
            });
            const auto first = std::find_if(left.begin(), left.end(), [](int16_t s) { return s != 0; });
            const double at = msAt(static_cast<size_t>(first - left.begin()));
            char detail[96]{};
            sprintf_s(detail, "first sound at %.1f ms, played at 400 ms", at);
            std::cout << "JITTER_RAW late-source " << detail << std::endl;
            expect("mixer-late-source-lands-when-it-played", first != left.end() && std::abs(at - 400.0) <= 40.0, detail);
        }

        // (3) Nor across a pause: what the cushion still holds at the pause is written
        // before it, so what follows the resume starts where the pause began.
        {
            const auto beforePause = dcPacket(0.5f);
            const auto afterPause = dcPacket(-0.5f);
            double pausedAtMs = 0.0;
            const auto left = runTake(false, true, [&](AudioMixer& mixer, Clock::time_point t0) {
                capture(
                    [&] { mixer.pushMicrophone(beforePause.data(), static_cast<DWORD>(beforePause.size())); },
                    t0, 40, 1000, 0);
                pausedAtMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
                mixer.setPaused(true);
                std::this_thread::sleep_for(milliseconds(200));
                mixer.setPaused(false);
                capture(
                    [&] { mixer.pushMicrophone(afterPause.data(), static_cast<DWORD>(afterPause.size())); },
                    Clock::now(), 30, 1000, 0);
            });
            const auto first = std::find_if(left.begin(), left.end(), [](int16_t s) { return s < 0; });
            const double at = msAt(static_cast<size_t>(first - left.begin()));
            char detail[96]{};
            sprintf_s(detail, "resumed sound at %.1f ms, paused at %.1f ms", at, pausedAtMs);
            std::cout << "JITTER_RAW pause " << detail << std::endl;
            expect("mixer-resume-continues-at-the-pause", first != left.end() && std::abs(at - pausedAtMs) <= 40.0, detail);
        }

        // (5) A pause followed by a stop, as the helper ends every take (#942):
        // the track ends at the pause, not at the stop that comes later.
        {
            const auto packet = dcPacket(0.5f);
            double pausedAtMs = 0.0;
            const auto left = runTake(false, true, [&](AudioMixer& mixer, Clock::time_point t0) {
                capture(
                    [&] { mixer.pushMicrophone(packet.data(), static_cast<DWORD>(packet.size())); },
                    t0, 40, 1000, 0);
                pausedAtMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
                mixer.setPaused(true);
                std::this_thread::sleep_for(milliseconds(300));
            });
            const double lengthMs = msAt(left.size());
            char detail[96]{};
            sprintf_s(detail, "track %.1f ms long, paused at %.1f ms", lengthMs, pausedAtMs);
            std::cout << "JITTER_RAW stop-after-pause " << detail << std::endl;
            expect("mixer-track-ends-at-the-pause-before-a-stop", std::abs(lengthMs - pausedAtMs) <= 20.0, detail);
        }

        // (4) The same with a resume that follows the pause at once, before the
        // mixer has had a chance to see the pause: the resume must wait for the
        // cushion to be written, or it throws the cushion away and what follows
        // lands a cushion early.
        {
            const auto beforePause = dcPacket(0.5f);
            const auto afterPause = dcPacket(-0.5f);
            double pausedAtMs = 0.0;
            const auto left = runTake(false, true, [&](AudioMixer& mixer, Clock::time_point t0) {
                capture(
                    [&] { mixer.pushMicrophone(beforePause.data(), static_cast<DWORD>(beforePause.size())); },
                    t0, 40, 1000, 0);
                pausedAtMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
                mixer.setPaused(true);
                mixer.setPaused(false);
                capture(
                    [&] { mixer.pushMicrophone(afterPause.data(), static_cast<DWORD>(afterPause.size())); },
                    Clock::now(), 30, 1000, 0);
            });
            const auto first = std::find_if(left.begin(), left.end(), [](int16_t s) { return s < 0; });
            const double at = msAt(static_cast<size_t>(first - left.begin()));
            // 40 packets were pushed before the pause: 400 ms of voice, all of it
            // due before the pause, none of it to be thrown away with the cushion.
            const auto lastBefore = std::find_if(left.rbegin(), left.rend(), [](int16_t s) { return s > 0; });
            const double voiceEnd = msAt(static_cast<size_t>(left.rend() - lastBefore));
            char detail[128]{};
            sprintf_s(
                detail, "voice before the pause ends at %.1f ms of 400, resumed at %.1f ms, paused at %.1f ms",
                voiceEnd, at, pausedAtMs);
            std::cout << "JITTER_RAW instant-resume " << detail << std::endl;
            expect("mixer-instant-resume-keeps-the-voice-before-it", voiceEnd >= 390.0, detail);
            expect("mixer-instant-resume-continues-at-the-pause", first != left.end() && std::abs(at - pausedAtMs) <= 40.0, detail);
        }
    }

    // --- mixAudioInPlace, per output format -----------------------------------
    //
    // The gain rides in mixAudioInPlace on every format branch, but the
    // AudioMixer sections above can only reach PCM16: production always mixes
    // into the AAC input format. These call the branches directly, with the
    // negative-destination-plus-boosted-source case that pins sum-then-clamp
    // (clamp-then-sum reads the destination alone: 0.4, not 0.76).
    {
        const size_t frames = 4;
        const AudioInputFormat f32 = makeFormat(MFAudioFormat_Float, 48000, 2, 32);
        {
            std::vector<BYTE> dest(frames * f32.blockAlign, 0);
            std::vector<BYTE> src(frames * f32.blockAlign, 0);
            auto* d = reinterpret_cast<float*>(dest.data());
            auto* s = reinterpret_cast<float*>(src.data());
            for (size_t i = 0; i < frames * 2; i += 1) {
                d[i] = -0.5f;
                s[i] = 0.9f;
            }
            mixAudioInPlace(dest, src.data(), static_cast<DWORD>(src.size()), f32, 1.4);
            char detail[96]{};
            sprintf_s(detail, "got=%.6f want=0.76", d[0]);
            std::cout << "MIXFMT_RAW float-over-system " << detail << std::endl;
            expect("mix-in-place-float-sums-before-clamp", std::abs(d[0] - 0.76) < 1e-3, detail);
            for (size_t i = 0; i < frames * 2; i += 1) {
                d[i] = 0.5f;
            }
            mixAudioInPlace(dest, src.data(), static_cast<DWORD>(src.size()), f32, 1.4);
            sprintf_s(detail, "got=%.6f want=1.0", d[0]);
            std::cout << "MIXFMT_RAW float-rail " << detail << std::endl;
            expect("mix-in-place-float-clamps-at-rail", d[0] == 1.0f, detail);
        }
        // PCM16 is the production path, pinned here in its own units too:
        // -16384 + 29491 * 1.4 = 24903.4 -> 24903, and 16384 + 29491 * 1.4
        // clamps at 32767.
        {
            std::vector<BYTE> dest(frames * target48k.blockAlign, 0);
            std::vector<BYTE> src(frames * target48k.blockAlign, 0);
            auto* d = reinterpret_cast<int16_t*>(dest.data());
            auto* s = reinterpret_cast<int16_t*>(src.data());
            for (size_t i = 0; i < frames * 2; i += 1) {
                d[i] = -16384;
                s[i] = 29491;
            }
            mixAudioInPlace(
                dest, src.data(), static_cast<DWORD>(src.size()), target48k, 1.4);
            char detail[96]{};
            sprintf_s(detail, "got=%d want=24903", d[0]);
            std::cout << "MIXFMT_RAW pcm16-over-system " << detail << std::endl;
            expect("mix-in-place-pcm16-sums-before-clamp", std::abs(d[0] - 24903) <= 1, detail);
            for (size_t i = 0; i < frames * 2; i += 1) {
                d[i] = 16384;
            }
            mixAudioInPlace(
                dest, src.data(), static_cast<DWORD>(src.size()), target48k, 1.4);
            sprintf_s(detail, "got=%d want=32767", d[0]);
            std::cout << "MIXFMT_RAW pcm16-rail " << detail << std::endl;
            expect("mix-in-place-pcm16-clamps-at-rail", d[0] == 32767, detail);
        }
        // Round numbers in int32 units: -1e9 + 2e9 * 1.4 = 1.8e9 (fits), and
        // 1e9 + 2e9 * 1.4 = 3.8e9 clamps at INT32_MAX.
        {
            const AudioInputFormat p32 = makeFormat(MFAudioFormat_PCM, 48000, 2, 32);
            std::vector<BYTE> dest(frames * p32.blockAlign, 0);
            std::vector<BYTE> src(frames * p32.blockAlign, 0);
            auto* d = reinterpret_cast<int32_t*>(dest.data());
            auto* s = reinterpret_cast<int32_t*>(src.data());
            for (size_t i = 0; i < frames * 2; i += 1) {
                d[i] = -1000000000;
                s[i] = 2000000000;
            }
            mixAudioInPlace(dest, src.data(), static_cast<DWORD>(src.size()), p32, 1.4);
            char detail[96]{};
            sprintf_s(detail, "got=%d want=1800000000", static_cast<int>(d[0]));
            std::cout << "MIXFMT_RAW pcm32-over-system " << detail << std::endl;
            expect("mix-in-place-pcm32-sums-before-clamp", d[0] == 1800000000LL, detail);
            for (size_t i = 0; i < frames * 2; i += 1) {
                d[i] = 1000000000;
            }
            mixAudioInPlace(dest, src.data(), static_cast<DWORD>(src.size()), p32, 1.4);
            sprintf_s(detail, "got=%d want=2147483647", static_cast<int>(d[0]));
            std::cout << "MIXFMT_RAW pcm32-rail " << detail << std::endl;
            expect(
                "mix-in-place-pcm32-clamps-at-rail",
                d[0] == static_cast<int32_t>(2147483647LL),
                detail);
        }
    }

    HRESULT mfHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(mfHr) && mfHr != RPC_E_CHANGED_MODE) {
        skip("mf-startup", "CoInitializeEx failed — no Media Foundation on this host");
    } else {
        mfHr = MFStartup(MF_VERSION);
        if (FAILED(mfHr)) {
            skip("mf-startup", "MFStartup hr=" + std::to_string(static_cast<long>(mfHr)));
        } else {
            expect("mf-startup", true, "");
            const auto runReject = [](const char* name, HRESULT hr) {
                char hex[16]{};
                sprintf_s(hex, "0x%08lx", static_cast<unsigned long>(hr));
                std::cout << "MF_RAW " << name << " hr=" << hex << "\n";
                if (FAILED(hr) && static_cast<unsigned long>(hr) == 0xc00d36b4ul) {
                    expect(name, true, "");
                } else if (SUCCEEDED(hr)) {
                    skip(name, "host AAC accepts 96 kHz");
                } else {
                    skip(name, std::string("host cannot probe this rate hr=") + hex);
                }
            };
            const auto runAccept = [](const char* name, HRESULT hr) {
                char hex[16]{};
                sprintf_s(hex, "0x%08lx", static_cast<unsigned long>(hr));
                std::cout << "MF_RAW " << name << " hr=" << hex << "\n";
                if (SUCCEEDED(hr)) {
                    expect(name, true, "");
                    return true;
                }
                skip(name, std::string("host has no AAC encoder hr=") + hex);
                return false;
            };
            runReject("mf-reject-96000", trySetAacPcmRate(96000));
            if (runAccept("mf-accept-48000", trySetAacPcmRate(48000))) {
                runReject("mf-reject-96000-with-video", trySetAacPcmRateWithVideo(96000));
                runAccept("mf-accept-48000-with-video", trySetAacPcmRateWithVideo(48000));
                Microsoft::WRL::ComPtr<IMFAttributes> swAttr;
                if (FAILED(MFCreateAttributes(&swAttr, 1))) {
                    skip("mf-reject-96000-sw-attr", "MFCreateAttributes failed");
                } else {
                    swAttr->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, FALSE);
                    runReject("mf-reject-96000-sw-attr", trySetAacPcmRate(96000, swAttr.Get()));
                    runAccept("mf-accept-48000-sw-attr", trySetAacPcmRate(48000, swAttr.Get()));
                }
            }
            MFShutdown();
        }
    }

    std::cout << "ran " << g_ran << " tests\n";
    if (g_failed != 0) {
        std::cout << g_failed << " failed\n";
        return 1;
    }
    return 0;
}
