#include "wasapi_render_keepalive.h"

#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <ksmedia.h>

namespace {

constexpr REFERENCE_TIME BufferDurationHns = 10'000'000;
// A 1kHz tone at 1% amplitude was clearly audible in testing -- 1kHz sits right
// in the most sensitive part of human hearing, so "quiet" in raw amplitude terms
// was still loud in perceived loudness. 19kHz is above what the large majority of
// adults can hear at all (upper hearing limit typically drops well below 20kHz
// with age), so the actual amplitude can afford to be smaller still and remain
// robustly non-silent to the audio engine.
constexpr double ToneAmplitude = 0.003;
constexpr double ToneFrequencyHz = 19000.0;

bool isFloatFormat(const WAVEFORMATEX* format) {
    if (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
        return true;
    }
    if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
        format->cbSize >= sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
        const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
        return extensible->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    }
    return false;
}

constexpr double TwoPi = 2.0 * 3.14159265358979323846;

// The minimum sample rate at which ToneFrequencyHz stays comfortably below
// Nyquist. Below this, generating the tone at all would mean either aliasing it
// into an audible range or silently picking a lower, audible frequency instead
// -- both worse than not running the keep-alive at all, so start() refuses to
// run rather than risk a perceptible tone.
constexpr double MinSampleRateForTone = ToneFrequencyHz / 0.9 * 2.0;

// Fills `frameCount` frames of `data` with a quiet sine tone at the format
// described by `format`, starting at `phase` radians and returning the phase to
// continue from on the next call, so the waveform stays continuous across
// separate GetBuffer/ReleaseBuffer calls instead of clicking at each boundary.
// Caller (start()) has already verified the sample rate supports ToneFrequencyHz
// with margin, so this always uses it directly rather than silently degrading.
double writeToneFrames(BYTE* data, UINT32 frameCount, const WAVEFORMATEX* format, double phase) {
    // Zeroed up front so an unsupported bit depth (anything but 16/32-bit) falls
    // back to real silence for that packet instead of playing back GetBuffer's
    // uninitialized memory.
    std::memset(data, 0, static_cast<size_t>(frameCount) * format->nBlockAlign);

    const double phaseStep = TwoPi * ToneFrequencyHz / format->nSamplesPerSec;
    const bool isFloat = isFloatFormat(format);
    const UINT16 bitsPerSample = format->wBitsPerSample;

    for (UINT32 frame = 0; frame < frameCount; ++frame) {
        const double sampleValue = std::sin(phase) * ToneAmplitude;
        phase += phaseStep;
        if (phase >= TwoPi) {
            // Wrap rather than let phase grow unboundedly over a long recording,
            // which would eventually lose precision in the sine's argument.
            phase -= TwoPi;
        }

        for (UINT16 channel = 0; channel < format->nChannels; ++channel) {
            BYTE* sampleData = data + frame * format->nBlockAlign + channel * (bitsPerSample / 8);
            if (isFloat && bitsPerSample == 32) {
                const float value = static_cast<float>(sampleValue);
                std::memcpy(sampleData, &value, sizeof(value));
            } else if (bitsPerSample == 16) {
                const int16_t value = static_cast<int16_t>(sampleValue * 32767.0);
                std::memcpy(sampleData, &value, sizeof(value));
            } else if (bitsPerSample == 32) {
                // 32-bit integer PCM.
                const int32_t value = static_cast<int32_t>(sampleValue * 2147483647.0);
                std::memcpy(sampleData, &value, sizeof(value));
            }
            // Any other bit depth is left zeroed (already cleared above) rather
            // than risking a malformed write -- this is a best-effort keep-alive,
            // not a guarantee of coverage for every possible device format.
        }
    }

    return phase;
}

} // namespace

WasapiRenderKeepAlive::~WasapiRenderKeepAlive() {
    stop();
    if (mixFormat_) {
        CoTaskMemFree(mixFormat_);
        mixFormat_ = nullptr;
    }
}

bool WasapiRenderKeepAlive::start() {
    Microsoft::WRL::ComPtr<IMMDeviceEnumerator> deviceEnumerator;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&deviceEnumerator));
    if (FAILED(hr)) {
        return false;
    }

    Microsoft::WRL::ComPtr<IMMDevice> device;
    hr = deviceEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(hr)) {
        // No default render device to keep alive -- nothing to do.
        return false;
    }

    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &audioClient_);
    if (FAILED(hr)) {
        return false;
    }

    hr = audioClient_->GetMixFormat(&mixFormat_);
    if (FAILED(hr) || !mixFormat_) {
        return false;
    }

    if (mixFormat_->nSamplesPerSec < MinSampleRateForTone) {
        // Generating the tone here would mean either aliasing 19kHz into an
        // audible frequency or silently picking a lower, audible one -- both
        // worse than not running the keep-alive at all. The caller already
        // treats this as non-fatal to the recording.
        return false;
    }

    // Shared mode: mixes into whatever else may be playing rather than requesting
    // exclusive control, so it can't block another app from using the device, and
    // it fails cleanly (non-fatal to the caller) if another app already holds it
    // exclusively.
    hr = audioClient_->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, BufferDurationHns, 0, mixFormat_, nullptr);
    if (FAILED(hr)) {
        return false;
    }

    hr = audioClient_->GetBufferSize(&bufferFrameCount_);
    if (FAILED(hr)) {
        return false;
    }

    hr = audioClient_->GetService(IID_PPV_ARGS(&renderClient_));
    if (FAILED(hr)) {
        return false;
    }

    // Prime the full buffer with the tone before Start() so there's no gap for the
    // audio engine to glitch on.
    BYTE* data = nullptr;
    hr = renderClient_->GetBuffer(bufferFrameCount_, &data);
    if (FAILED(hr)) {
        return false;
    }
    tonePhase_ = writeToneFrames(data, bufferFrameCount_, mixFormat_, tonePhase_);
    renderClient_->ReleaseBuffer(bufferFrameCount_, 0);

    stopRequested_ = false;
    hr = audioClient_->Start();
    if (FAILED(hr)) {
        return false;
    }

    thread_ = std::thread([this] {
        // GetBuffer/ReleaseBuffer/GetCurrentPadding are called from this thread,
        // which is otherwise never COM-initialized. Both this and the wmain thread
        // are MTA (see winrt::init_apartment in main.cpp), so no marshaling is
        // needed -- this only satisfies the "calling thread must be initialized"
        // requirement.
        const HRESULT comInit = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        renderLoop();
        if (SUCCEEDED(comInit)) {
            CoUninitialize();
        }
    });
    return true;
}

void WasapiRenderKeepAlive::stop() {
    stopRequested_ = true;
    if (thread_.joinable()) {
        thread_.join();
    }
    if (audioClient_) {
        audioClient_->Stop();
    }
    renderClient_.Reset();
    audioClient_.Reset();
}

void WasapiRenderKeepAlive::renderLoop() {
    while (!stopRequested_) {
        UINT32 paddingFrames = 0;
        if (FAILED(audioClient_->GetCurrentPadding(&paddingFrames))) {
            break;
        }

        const UINT32 framesAvailable = bufferFrameCount_ - paddingFrames;
        if (framesAvailable > 0) {
            BYTE* data = nullptr;
            if (SUCCEEDED(renderClient_->GetBuffer(framesAvailable, &data))) {
                tonePhase_ = writeToneFrames(data, framesAvailable, mixFormat_, tonePhase_);
                renderClient_->ReleaseBuffer(framesAvailable, 0);
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
}
