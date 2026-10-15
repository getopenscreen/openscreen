#pragma once

#include <Windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <cstdint>
#include <functional>

// DXGI Desktop Duplication capture, as an alternative frame source to
// WgcSession for the same pipeline.
//
// Why it exists: IGraphicsCaptureItemInterop::CreateForMonitor can be refused
// with E_ACCESSDENIED on a machine where the OS reports WGC as supported
// (GraphicsCaptureSession::IsSupported() == 1) and where every other capture
// route works -- measured on Windows 10 22H2 (19045.6466), where the same
// process that gets 0x80070005 from CreateForMonitor acquires 2560x1440 BGRA
// frames from IDXGIOutputDuplication for the same monitor, in the same run.
// Window capture has no equivalent here: Desktop Duplication only ever
// duplicates an output, so initialize(HWND, ...) refuses.
//
// The public surface mirrors WgcSession deliberately. main.cpp drives both
// through the CaptureSession wrapper, so nothing downstream -- encoder, MP4
// muxer, audio, webcam, cursor sampler, the JSON event protocol -- knows which
// backend produced a frame.
class DxgiDuplicationSession {
public:
    using FrameCallback = std::function<void(ID3D11Texture2D*, int64_t)>;

    DxgiDuplicationSession() = default;
    ~DxgiDuplicationSession();

    DxgiDuplicationSession(const DxgiDuplicationSession&) = delete;
    DxgiDuplicationSession& operator=(const DxgiDuplicationSession&) = delete;

    bool initialize(HMONITOR monitor, int fps, bool captureCursor);
    // Unsupported by design -- see the class comment. Returns false and says so
    // once, so a window take falls back to the WGC failure path rather than
    // silently recording nothing.
    bool initialize(HWND window, int fps, bool captureCursor, bool includeSecondaryWindows = false);

    bool start();
    // Returns the most recent frame's texture, or false when no new frame has
    // been presented since the last call. Unlike WgcSession, the texture is a
    // private copy owned by this session rather than pool-owned: AcquireNextFrame
    // requires the frame to be released before the next acquisition, so the
    // desktop image is copied out immediately and the returned pointer stays
    // valid until the next call or stop().
    bool tryGetNextFrame(ID3D11Texture2D** outTexture, int64_t* outTimestampHns);

    // Pull-only backend. WgcSession's FrameArrived path exists as a rollback
    // lever for a driver bug specific to WGC's callback thread (see wgc_session.h);
    // Desktop Duplication has no equivalent push mode, so these are inert and
    // main.cpp keeps the pull path when this backend is the active one.
    void setFrameCallback(FrameCallback callback);
    bool quiesceLegacyCallback(int drainTimeoutMs = 5000);
    void stop();

    int captureWidth() const { return width_; }
    int captureHeight() const { return height_; }
    ID3D11Device* device() const { return d3dDevice_.Get(); }
    ID3D11DeviceContext* context() const { return d3dContext_.Get(); }

private:
    bool createD3DDevice();
    bool createDuplication(HMONITOR monitor);
    bool ensureCopyTexture();
    bool reacquire();
    // LastPresentTime and QueryPerformanceCounter share the QPC clock, which is
    // the same clock WGC's SystemRelativeTime is derived from -- and main.cpp
    // only ever uses the value as a delta from the first frame, so a monotonic
    // 100 ns count is all this has to be.
    int64_t ticksToHns(LONGLONG ticks) const;

    Microsoft::WRL::ComPtr<ID3D11Device> d3dDevice_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> d3dContext_;
    Microsoft::WRL::ComPtr<IDXGIAdapter> adapter_;
    Microsoft::WRL::ComPtr<IDXGIOutput1> output_;
    Microsoft::WRL::ComPtr<IDXGIOutputDuplication> duplication_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> copyTexture_;

    HMONITOR monitor_ = nullptr;
    LARGE_INTEGER qpcFrequency_{};
    int width_ = 0;
    int height_ = 0;
    int fps_ = 60;
    bool captureCursor_ = false;
    bool started_ = false;
    bool warnedCursorIgnored_ = false;
    bool warnedAccessLost_ = false;
    bool exhausted_ = false;
    uint64_t reacquireCount_ = 0;
};
