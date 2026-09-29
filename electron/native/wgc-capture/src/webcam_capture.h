#pragma once

#include "dshow_webcam_capture.h"

#include <Windows.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

class WebcamCapture {
public:
    WebcamCapture() = default;
    ~WebcamCapture();

    WebcamCapture(const WebcamCapture&) = delete;
    WebcamCapture& operator=(const WebcamCapture&) = delete;

    bool initialize(
        const std::wstring& deviceId,
        const std::wstring& deviceName,
        const std::wstring& directShowClsid,
        int requestedWidth,
        int requestedHeight,
        int requestedFps,
        bool preferNv12);
    bool start();
    void stop();
    bool copyLatestFrame(WebcamFrameSnapshot& destination);

    int width() const;
    int height() const;
    int fps() const;
    /**
     * Do the frames from `copyLatestFrame` carry NV12 rather than BGRA?
     *
     * Always false on the DirectShow fallback, which unpacks whatever the
     * camera speaks into BGRA itself. Callers must ask rather than assume:
     * the two layouts differ in size as well as in meaning.
     */
    bool deliversNv12() const;
    const std::wstring& selectedDeviceName() const;

private:
    bool selectDevice(const std::wstring& deviceId, const std::wstring& deviceName);
    bool configureReader(int requestedWidth, int requestedHeight, int requestedFps, bool preferNv12);
    void captureLoop();

    Microsoft::WRL::ComPtr<IMFMediaSource> mediaSource_;
    Microsoft::WRL::ComPtr<IMFSourceReader> sourceReader_;
    DirectShowWebcamCapture directShowCapture_;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    std::mutex frameMutex_;
    std::vector<BYTE> latestFrame_;
    uint64_t latestFrameSequence_ = 0;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 30;
    bool mfStarted_ = false;
    bool usingDirectShow_ = false;
    bool deliversNv12_ = false;
    /** Latches the short-buffer warning so it is said once, not 30x a second. */
    bool reportedShortBuffer_ = false;
    /**
     * Why the capture loop did or did not produce frames.
     *
     * A camera that delivers nothing used to surface only as
     * MF_E_SINK_NO_SAMPLES_PROCESSED from the encoder's Finalize -- the one
     * place that cannot say which of the loop's five silent `continue` paths
     * swallowed the frames. These are reported once when the loop ends.
     */
    uint64_t framesDelivered_ = 0;
    uint64_t emptySamples_ = 0;
    uint64_t readFailures_ = 0;
    uint64_t shortBuffers_ = 0;
    uint64_t bufferFailures_ = 0;
    bool sawEndOfStream_ = false;
    HRESULT lastReadFailure_ = S_OK;
    /** Where the loop's wall time goes, in microseconds. */
    uint64_t readSampleUs_ = 0;
    uint64_t storeUs_ = 0;
    int selectedMatchScore_ = 0;
    std::wstring selectedDeviceName_;
};
