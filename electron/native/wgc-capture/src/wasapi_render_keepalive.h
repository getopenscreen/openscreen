#pragma once

// getopenscreen/openscreen#724: a headset can be idled by Windows partway through a
// mic-only recording, because nothing in that path ever writes to the render
// (playback) endpoint -- WasapiLoopbackCapture's system-audio path only ever READS
// from it via AUDCLNT_STREAMFLAGS_LOOPBACK. Confirmed on real hardware: the drop
// reproduces with mic-only capture and does NOT reproduce with system audio (i.e.
// loopback) also enabled, so touching the render endpoint at all is what keeps it
// alive, and loopback capture already does that as a side effect when it runs.
//
// This opens an ordinary render stream on the same default output device and
// writes a near-inaudible tone to it for as long as a recording is running. It
// only runs when system audio is NOT being captured: loopback capture already
// fills the endpoint with real content of its own, so there is nothing to keep
// alive, and anything written here alongside it would end up in the recording's
// system-audio track.
//
// Real signal, not digital silence: confirmed on real hardware that writing
// AUDCLNT_BUFFERFLAGS_SILENT packets does not reliably stop a wireless headset's
// own idle timer from firing, while writing an actual (if very quiet) tone does.
// This matches the earlier finding that system-audio loopback capture (which
// reads real audio, when something is playing) prevents the drop but mic-only
// capture (which touches nothing) does not -- some headsets' firmware appears to
// require genuine signal, not merely a live but silent stream, to register as
// activity.
//
// A first attempt at 1kHz / 1% amplitude was clearly audible in testing -- 1kHz
// sits in the most sensitive part of human hearing, so "quiet" in raw amplitude
// terms was still perceptibly loud. The tone is now 19kHz (above what the large
// majority of adults can hear at all) at 0.3% amplitude. It is not adapted to the
// device: on a mix format whose sample rate cannot represent 19kHz with margin,
// start() refuses to run at all rather than alias it into an audible frequency.
// The tone is never captured into the recording itself, because this stream only
// exists when loopback capture is off.
//
// Known limitation: the stream targets whatever the default render endpoint is at
// start and never re-targets. If the user switches output devices mid-take, the
// new default is not protected for the rest of the recording (the device watcher,
// if enabled, logs the switch).
//
// Kill-switch: set OPENSCREEN_WGC_DISABLE_AUDIO_KEEPALIVE=1 to turn this off.

#include <Windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <atomic>
#include <thread>

class WasapiRenderKeepAlive {
public:
    WasapiRenderKeepAlive() = default;
    ~WasapiRenderKeepAlive();

    WasapiRenderKeepAlive(const WasapiRenderKeepAlive&) = delete;
    WasapiRenderKeepAlive& operator=(const WasapiRenderKeepAlive&) = delete;

    // Opens the default render endpoint in shared mode and starts writing the
    // keep-alive tone. Returns false on any failure -- including another app
    // holding the device exclusively -- which callers must treat as non-fatal to
    // the recording itself.
    bool start();
    void stop();

private:
    void renderLoop();

    Microsoft::WRL::ComPtr<IAudioClient> audioClient_;
    Microsoft::WRL::ComPtr<IAudioRenderClient> renderClient_;
    WAVEFORMATEX* mixFormat_ = nullptr;
    UINT32 bufferFrameCount_ = 0;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    // Carries the tone's phase across GetBuffer/ReleaseBuffer calls so the
    // waveform is continuous instead of restarting (and clicking) at each one.
    // Only ever touched from the render thread, so no synchronization needed.
    double tonePhase_ = 0.0;
};
