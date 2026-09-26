#include "desktop_icon_cover.h"

#include <future>
#include <iostream>

namespace {

constexpr wchar_t kClassName[] = L"OpenScreenDesktopIconCover";

// The top-level window that owns the icon list view (`SHELLDLL_DefView`): Progman
// on a plain desktop, a WorkerW when Explorer has split the desktop in two
// (wallpaper slideshow, some Windows 10 builds). Whichever it is, the cover goes
// right above it.
HWND findDesktopIconHost() {
    HWND host = nullptr;
    EnumWindows(
        [](HWND hwnd, LPARAM out) -> BOOL {
            if (FindWindowExW(hwnd, nullptr, L"SHELLDLL_DefView", nullptr)) {
                *reinterpret_cast<HWND*>(out) = hwnd;
                return FALSE;
            }
            return TRUE;
        },
        reinterpret_cast<LPARAM>(&host));
    return host;
}

LRESULT CALLBACK coverWindowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_PAINT: {
        PAINTSTRUCT paint{};
        HDC dc = BeginPaint(hwnd, &paint);
        // The desktop's own wallpaper painter, fit mode and all. ponytail: user32
        // keeps one wallpaper, so a setup with a different picture per monitor may
        // get the primary's here; IDesktopWallpaper + WIC is the upgrade if that
        // turns up.
        PaintDesktop(dc);
        EndPaint(hwnd, &paint);
        return 0;
    }
    case WM_ERASEBKGND:
        return 1;
    case WM_MOUSEACTIVATE:
        // A click on the cover must not raise it over the user's windows.
        return MA_NOACTIVATE;
    case WM_SETTINGCHANGE:
        if (wParam == SPI_SETDESKWALLPAPER) {
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;
    default:
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
}

} // namespace

bool DesktopIconCover::show(HMONITOR monitor) {
    MONITORINFO info{sizeof(info)};
    if (!monitor || !GetMonitorInfoW(monitor, &info)) {
        std::cerr << "[desktop-icon-cover] could not read the captured monitor" << std::endl;
        return false;
    }

    // Moved into the thread, not captured by reference: `get()` can return before
    // `set_value` has finished with the promise, and this frame is gone by then.
    std::promise<bool> promise;
    std::future<bool> placedResult = promise.get_future();
    thread_ = std::thread([this, rect = info.rcMonitor, placed = std::move(promise)]() mutable {
        threadId_ = GetCurrentThreadId();
        HINSTANCE instance = GetModuleHandleW(nullptr);
        WNDCLASSEXW windowClass{sizeof(windowClass)};
        windowClass.lpfnWndProc = coverWindowProc;
        windowClass.hInstance = instance;
        windowClass.lpszClassName = kClassName;
        windowClass.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512)); // IDC_ARROW, wide
        RegisterClassExW(&windowClass);

        HWND host = findDesktopIconHost();
        HWND cover = host ? CreateWindowExW(
                                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                                kClassName,
                                L"",
                                WS_POPUP,
                                rect.left,
                                rect.top,
                                rect.right - rect.left,
                                rect.bottom - rect.top,
                                nullptr,
                                nullptr,
                                instance,
                                nullptr)
                          : nullptr;
        if (!cover) {
            std::cerr << "[desktop-icon-cover] not shown: "
                      << (host ? "window creation failed" : "no desktop icon host found")
                      << std::endl;
            placed.set_value(false);
            return;
        }

        // "Insert after" the window just above the host = directly above the host.
        // With nothing above it the host is on top already, and so is the cover.
        HWND above = GetWindow(host, GW_HWNDPREV);
        SetWindowPos(cover, above ? above : HWND_TOP, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        UpdateWindow(cover);
        std::cerr << "[desktop-icon-cover] shown over the desktop icons" << std::endl;
        placed.set_value(true);

        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        DestroyWindow(cover);
    });

    if (!placedResult.get()) {
        thread_.join();
        threadId_ = 0;
        return false;
    }
    return true;
}

DesktopIconCover::~DesktopIconCover() {
    if (!thread_.joinable()) {
        return;
    }
    if (threadId_ != 0) {
        PostThreadMessageW(threadId_, WM_QUIT, 0, 0);
    }
    thread_.join();
}
