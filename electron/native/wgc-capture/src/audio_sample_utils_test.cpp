#include "audio_sample_utils.h"

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

} // namespace

int main() {
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

    // reset() has to mean cold, not nearly cold. start(), beginTimeline() and
    // setPaused(true) all call it, so anything it left behind would be audible
    // in the first frames after a pause.
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
                target48k, system96k, mic48k, true, includeMic, 1.0,
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
