#pragma once

#include "dxgi_duplication_session.h"
#include "wgc_session.h"

#include <cctype>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <utility>

// One frame source, two backends, chosen at initialize() time.
//
// main.cpp used to talk to WgcSession directly. It now talks to this instead,
// so the choice between WGC and DXGI Desktop Duplication lives in one place and
// every downstream stage -- the encoder, the MP4 muxer, audio, webcam, the
// cursor sampler, the JSON event protocol -- is unchanged and unaware.
//
// The fallback exists because CreateForMonitor can be refused with
// E_ACCESSDENIED on a machine that captures perfectly well otherwise; see
// dxgi_duplication_session.h for the measurements. WGC is still tried first
// everywhere, so a machine where it works keeps the backend it has always had.
class CaptureSession {
public:
    using FrameCallback = WgcSession::FrameCallback;

    // OPENSCREEN_CAPTURE_BACKEND=dxgi   force Desktop Duplication (diagnostics)
    //                          =wgc    force WGC, no fallback (diagnostics)
    //                          unset   try WGC, fall back to DXGI
    static std::string requestedBackend() {
        const char* raw = std::getenv("OPENSCREEN_CAPTURE_BACKEND");
        if (!raw) {
            return {};
        }
        std::string value(raw);
        for (char& c : value) {
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        }
        return value;
    }

    bool initialize(HMONITOR monitor, int fps, bool captureCursor) {
        const std::string requested = requestedBackend();
        if (requested == "dxgi") {
            return startDxgi(monitor, fps, captureCursor, "requested");
        }
        if (wgc_.initialize(monitor, fps, captureCursor)) {
            return adoptWgc();
        }
        wgcUnavailable_ = true;
        if (requested == "wgc") {
            return false;
        }
        wgc_.stop();
        return startDxgi(monitor, fps, captureCursor, "wgc-unavailable");
    }

    bool initialize(HWND window, int fps, bool captureCursor, bool includeSecondaryWindows = false) {
        // Desktop Duplication duplicates an output, never a single window, so a
        // window take has no fallback: it is WGC or it is a failure.
        if (wgc_.initialize(window, fps, captureCursor, includeSecondaryWindows)) {
            return adoptWgc();
        }
        wgcUnavailable_ = true;
        return false;
    }

    bool start() {
        switch (backend_) {
            case Backend::Wgc:
                return wgc_.start();
            case Backend::Dxgi:
                return dxgi_.start();
            default:
                return false;
        }
    }

    bool tryGetNextFrame(ID3D11Texture2D** outTexture, int64_t* outTimestampHns) {
        switch (backend_) {
            case Backend::Wgc:
                return wgc_.tryGetNextFrame(outTexture, outTimestampHns);
            case Backend::Dxgi:
                return dxgi_.tryGetNextFrame(outTexture, outTimestampHns);
            default:
                return false;
        }
    }

    void setFrameCallback(FrameCallback callback) {
        if (backend_ == Backend::Wgc) {
            wgc_.setFrameCallback(std::move(callback));
        }
    }

    bool quiesceLegacyCallback(int drainTimeoutMs = 5000) {
        if (backend_ == Backend::Wgc) {
            return wgc_.quiesceLegacyCallback(drainTimeoutMs);
        }
        return true;
    }

    void stop() {
        wgc_.stop();
        dxgi_.stop();
        backend_ = Backend::None;
    }

    int captureWidth() const {
        return backend_ == Backend::Dxgi ? dxgi_.captureWidth() : wgc_.captureWidth();
    }

    int captureHeight() const {
        return backend_ == Backend::Dxgi ? dxgi_.captureHeight() : wgc_.captureHeight();
    }

    ID3D11Device* device() const {
        return backend_ == Backend::Dxgi ? dxgi_.device() : wgc_.device();
    }

    ID3D11DeviceContext* context() const {
        return backend_ == Backend::Dxgi ? dxgi_.context() : wgc_.context();
    }

    bool usingDxgi() const { return backend_ == Backend::Dxgi; }
    bool wgcUnavailable() const { return wgcUnavailable_; }

    const char* backendName() const {
        switch (backend_) {
            case Backend::Wgc:
                return "wgc";
            case Backend::Dxgi:
                return "dxgi-duplication";
            default:
                return "none";
        }
    }

private:
    enum class Backend { None, Wgc, Dxgi };

    bool adoptWgc() {
        backend_ = Backend::Wgc;
        std::cout << "{\"event\":\"capture-backend\",\"backend\":\"wgc\"}" << std::endl;
        return true;
    }

    bool startDxgi(HMONITOR monitor, int fps, bool captureCursor, const char* reason) {
        if (!dxgi_.initialize(monitor, fps, captureCursor)) {
            return false;
        }
        backend_ = Backend::Dxgi;
        // Printed rather than only logged: which backend ran is a per-machine
        // outcome the app reports next to encoder-selection, so a future report
        // says which one produced the file without anyone having to guess.
        std::cout << "{\"event\":\"capture-backend\",\"backend\":\"dxgi-duplication\",\"reason\":\""
                  << reason << "\"}" << std::endl;
        return true;
    }

    Backend backend_ = Backend::None;
    WgcSession wgc_;
    DxgiDuplicationSession dxgi_;
    bool wgcUnavailable_ = false;
};
