#include "dxgi_duplication_session.h"

#include <algorithm>
#include <iostream>

namespace {

// Same device shape WgcSession creates, but on the adapter that owns the output:
// DuplicateOutput refuses a device from any other adapter, which is the normal
// case for a display wired to the discrete GPU of a hybrid laptop.
bool createDevice(IDXGIAdapter1* adapter, Microsoft::WRL::ComPtr<ID3D11Device>& device,
                  Microsoft::WRL::ComPtr<ID3D11DeviceContext>& context) {
    const D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    };
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    D3D_FEATURE_LEVEL obtained = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags, levels,
                                   ARRAYSIZE(levels), D3D11_SDK_VERSION, device.GetAddressOf(),
                                   &obtained, context.GetAddressOf());
    if (FAILED(hr)) {
        hr = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                               flags & ~D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels,
                               ARRAYSIZE(levels), D3D11_SDK_VERSION, device.GetAddressOf(),
                               &obtained, context.GetAddressOf());
    }
    if (FAILED(hr)) {
        std::cerr << "ERROR: DXGI capture could not create a D3D11 device (hr=0x" << std::hex << hr
                  << std::dec << ")" << std::endl;
        return false;
    }
    return true;
}

} // namespace

DxgiDuplicationSession::~DxgiDuplicationSession() {
    stop();
}

bool DxgiDuplicationSession::findOutput(HMONITOR monitor) {
    output_.Reset();
    adapter_.Reset();
    Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
        std::cerr << "ERROR: DXGI capture could not create a DXGI factory" << std::endl;
        return false;
    }

    // The monitor handle the caller matched with EnumDisplayMonitors is the only
    // thing tying the app's chosen source to an output, so match on it rather
    // than on index or position: a display can be rearranged between the picker
    // and the take. Every adapter is searched, not just the default one.
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    for (UINT a = 0; factory->EnumAdapters1(a, adapter.ReleaseAndGetAddressOf()) == S_OK; ++a) {
        Microsoft::WRL::ComPtr<IDXGIOutput> candidate;
        for (UINT i = 0; adapter->EnumOutputs(i, candidate.ReleaseAndGetAddressOf()) == S_OK; ++i) {
            DXGI_OUTPUT_DESC desc{};
            if (FAILED(candidate->GetDesc(&desc)) || desc.Monitor != monitor) {
                continue;
            }
            if (desc.Rotation != DXGI_MODE_ROTATION_IDENTITY &&
                desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
                // Desktop Duplication hands over the unrotated scan-out image, so a
                // portrait display would record sideways. Refuse rather than do that.
                std::cerr << "ERROR: DXGI capture does not support rotated displays (rotation="
                          << desc.Rotation << ")" << std::endl;
                return false;
            }
            if (FAILED(candidate.As(&output_))) {
                std::cerr << "ERROR: DXGI capture could not query IDXGIOutput1 for the chosen monitor"
                          << std::endl;
                return false;
            }
            adapter_ = adapter;
            desktopRect_ = desc.DesktopCoordinates;
            return true;
        }
    }
    std::cerr << "ERROR: DXGI capture could not find an output for the chosen monitor"
              << std::endl;
    return false;
}

bool DxgiDuplicationSession::createD3DDevice() {
    if (d3dDevice_) {
        return true;
    }
    if (!createDevice(adapter_.Get(), d3dDevice_, d3dContext_)) {
        return false;
    }
    QueryPerformanceFrequency(&qpcFrequency_);
    return true;
}

bool DxgiDuplicationSession::createDuplication() {
    Microsoft::WRL::ComPtr<IDXGIOutputDuplication> duplication;
    HRESULT hr = output_->DuplicateOutput(d3dDevice_.Get(), duplication.GetAddressOf());
    if (FAILED(hr)) {
        // DXGI_ERROR_NOT_CURRENTLY_AVAILABLE is what a machine reports when the
        // maximum number of duplications is already in use; anything else here
        // is a driver refusal.
        std::cerr << "ERROR: DXGI capture DuplicateOutput failed (hr=0x" << std::hex << hr << std::dec
                  << ")" << std::endl;
        return false;
    }
    duplication_ = duplication;

    DXGI_OUTDUPL_DESC desc{};
    duplication_->GetDesc(&desc);
    width_ = static_cast<int>(desc.ModeDesc.Width);
    height_ = static_cast<int>(desc.ModeDesc.Height);
    if (width_ <= 0 || height_ <= 0) {
        std::cerr << "ERROR: DXGI capture reported an empty desktop (" << width_ << "x" << height_
                  << ")" << std::endl;
        return false;
    }
    return true;
}

bool DxgiDuplicationSession::ensureCopyTexture() {
    if (copyTexture_) {
        D3D11_TEXTURE2D_DESC existing{};
        copyTexture_->GetDesc(&existing);
        if (static_cast<int>(existing.Width) == width_ &&
            static_cast<int>(existing.Height) == height_) {
            return true;
        }
        copyTexture_.Reset();
    }

    // A private destination for the acquired frame, so AcquireNextFrame can be
    // released immediately and the pointer handed to the caller stays valid.
    // Flags match what main.cpp already does when it copies a WGC frame out:
    // no bind flags, no CPU access -- it is only ever a CopyResource source.
    // With the system cursor it must also take a GDI DC, which needs a render
    // target that is GDI-compatible (drawCursor).
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = static_cast<UINT>(width_);
    desc.Height = static_cast<UINT>(height_);
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = captureCursor_ ? D3D11_BIND_RENDER_TARGET : 0;
    desc.CPUAccessFlags = 0;
    desc.MiscFlags = captureCursor_ ? D3D11_RESOURCE_MISC_GDI_COMPATIBLE : 0;
    const HRESULT hr = d3dDevice_->CreateTexture2D(&desc, nullptr, copyTexture_.GetAddressOf());
    if (FAILED(hr)) {
        std::cerr << "ERROR: DXGI capture could not create its copy texture (hr=0x" << std::hex << hr
                  << std::dec << ")" << std::endl;
        return false;
    }
    return true;
}

bool DxgiDuplicationSession::initialize(HMONITOR monitor, int fps, bool captureCursor) {
    if (!monitor) {
        return false;
    }
    captureCursor_ = captureCursor;
    fps_ = std::clamp(fps, 1, 120);
    monitor_ = monitor;

    if (!findOutput(monitor) || !createD3DDevice()) {
        return false;
    }
    if (!createDuplication()) {
        return false;
    }
    if (!ensureCopyTexture()) {
        return false;
    }
    return true;
}

bool DxgiDuplicationSession::initialize(HWND, int, bool, bool) {
    // Desktop Duplication duplicates an output, never a single window. There is
    // no DXGI equivalent of CreateForWindow, so a window take has to stay on
    // WGC -- say so rather than pretending to be ready.
    std::cerr << "WARNING: DXGI capture cannot capture a single window; only displays" << std::endl;
    return false;
}

bool DxgiDuplicationSession::start() {
    if (!duplication_) {
        return false;
    }
    started_ = true;
    return true;
}

int64_t DxgiDuplicationSession::ticksToHns(LONGLONG ticks) const {
    if (qpcFrequency_.QuadPart <= 0) {
        return ticks;
    }
    // 10'000'000 == one second in 100 ns units.
    // Split so ticks * 10^7 never overflows (it would after ~25 h of uptime).
    const LONGLONG f = qpcFrequency_.QuadPart;
    return static_cast<int64_t>((ticks / f) * 10'000'000LL + ((ticks % f) * 10'000'000LL) / f);
}

bool DxgiDuplicationSession::reacquire() {
    // DXGI_ERROR_ACCESS_LOST is normal: a UAC prompt, a desktop switch, a
    // resolution or refresh-rate change, or another process taking exclusive
    // fullscreen all invalidate the duplication. Rebuild it and let the caller
    // keep polling -- a frame is simply skipped, never a recording ended. While
    // the secure desktop is up, DuplicateOutput keeps failing, so the caller
    // retries about once a second until it comes back.
    lastReacquireAttemptMs_ = GetTickCount64();
    duplication_.Reset();
    copyTexture_.Reset();
    if (!d3dDevice_ || !findOutput(monitor_) || !createDuplication() || !ensureCopyTexture()) {
        duplication_.Reset();
        if (!warnedReacquireFailed_) {
            warnedReacquireFailed_ = true;
            std::cerr << "WARNING: DXGI capture lost the desktop and could not reacquire it yet; "
                         "retrying every second"
                      << std::endl;
        }
        return false;
    }
    warnedReacquireFailed_ = false;
    std::cout << "{\"event\":\"capture-reacquired\",\"backend\":\"dxgi\"}" << std::endl;
    return true;
}

bool DxgiDuplicationSession::tryGetNextFrame(ID3D11Texture2D** outTexture, int64_t* outTimestampHns) {
    if (!outTexture || !outTimestampHns || !started_) {
        return false;
    }
    if (!duplication_) {
        // A previous rebuild failed: try again, throttled, rather than give up.
        if (GetTickCount64() - lastReacquireAttemptMs_ < 1000 || !reacquire()) {
            return false;
        }
    }
    *outTexture = nullptr;

    // Wait no longer than one frame interval. main.cpp polls this on its own
    // cadence while it holds no lock, and a longer block here would simply make
    // the writer answer `stop` late.
    const UINT timeoutMs = static_cast<UINT>(std::max(1, 1000 / std::max(1, fps_)));
    DXGI_OUTDUPL_FRAME_INFO info{};
    Microsoft::WRL::ComPtr<IDXGIResource> resource;
    const HRESULT hr = duplication_->AcquireNextFrame(timeoutMs, &info, &resource);

    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        // A static desktop presents nothing. Not an error, and not a dropped frame.
        return false;
    }
    if (hr == DXGI_ERROR_ACCESS_LOST) {
        reacquire();
        return false;
    }
    if (FAILED(hr)) {
        if (hr == DXGI_ERROR_INVALID_CALL) {
            // Only reachable if a previous frame was not released; recover rather
            // than wedge the writer on a permanently failing acquire.
            duplication_->ReleaseFrame();
            return false;
        }
        std::cerr << "WARNING: DXGI capture AcquireNextFrame failed (hr=0x" << std::hex << hr
                  << std::dec << ")" << std::endl;
        return false;
    }

    Microsoft::WRL::ComPtr<ID3D11Texture2D> acquired;
    bool copied = false;
    if (SUCCEEDED(resource.As(&acquired)) && acquired) {
        if (ensureCopyTexture()) {
            d3dContext_->CopyResource(copyTexture_.Get(), acquired.Get());
            copied = true;
        }
    }

    // The frame must be released before the next acquisition, whatever happened
    // above -- holding it would make every later AcquireNextFrame fail.
    duplication_->ReleaseFrame();

    if (!copied) {
        return false;
    }

    if (captureCursor_) {
        drawCursor();
    }

    // LastPresentTime shares the QPC clock. A zero means the frame carried no
    // timestamp, which falls back to now -- the value is only ever used as a
    // delta from the first frame, so monotonic is what matters.
    LONGLONG ticks = info.LastPresentTime.QuadPart;
    if (ticks == 0) {
        LARGE_INTEGER now{};
        QueryPerformanceCounter(&now);
        ticks = now.QuadPart;
    }
    *outTimestampHns = ticksToHns(ticks);
    *outTexture = copyTexture_.Get();
    return true;
}

void DxgiDuplicationSession::drawCursor() {
    CURSORINFO ci{};
    ci.cbSize = sizeof(ci);
    if (!GetCursorInfo(&ci) || !(ci.flags & CURSOR_SHOWING) || !ci.hCursor) {
        return;
    }
    ICONINFO icon{};
    if (!GetIconInfo(ci.hCursor, &icon)) {
        return;
    }
    // GetIconInfo hands over copies of the bitmaps, which the caller owns.
    if (icon.hbmMask) {
        DeleteObject(icon.hbmMask);
    }
    if (icon.hbmColor) {
        DeleteObject(icon.hbmColor);
    }

    Microsoft::WRL::ComPtr<IDXGISurface1> surface;
    HDC dc = nullptr;
    if (FAILED(copyTexture_.As(&surface)) || FAILED(surface->GetDC(FALSE, &dc))) {
        return;
    }
    // The helper is per-monitor DPI aware, so the cursor position and the
    // output's desktop rectangle are both in physical pixels. DrawIconEx with
    // DI_NORMAL applies the AND/XOR masks, so monochrome and inverting cursors
    // look the way they do on screen.
    DrawIconEx(dc, ci.ptScreenPos.x - desktopRect_.left - static_cast<int>(icon.xHotspot),
               ci.ptScreenPos.y - desktopRect_.top - static_cast<int>(icon.yHotspot), ci.hCursor, 0,
               0, 0, nullptr, DI_NORMAL);
    surface->ReleaseDC(nullptr);
}

void DxgiDuplicationSession::setFrameCallback(FrameCallback callback) {
    (void)callback;
    // Deliberately inert: Desktop Duplication is pull-only, and rebuilding the
    // WGC callback-thread model here would reintroduce the frame-lock hazard
    // that pull-based delivery exists to avoid (see wgc_session.h). main.cpp
    // keeps the pull path when this backend is active.
}

bool DxgiDuplicationSession::quiesceLegacyCallback(int) {
    // Nothing was ever registered -- report drained so the caller never waits.
    return true;
}

void DxgiDuplicationSession::stop() {
    started_ = false;
    if (duplication_) {
        // An acquired-but-unreleased frame would keep the output duplicated for
        // the rest of the process, so release unconditionally before dropping it.
        duplication_->ReleaseFrame();
    }
    copyTexture_.Reset();
    duplication_.Reset();
    output_.Reset();
    adapter_.Reset();
    d3dContext_.Reset();
    d3dDevice_.Reset();
    width_ = 0;
    height_ = 0;
}
