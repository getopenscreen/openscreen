#pragma once

#include <Windows.h>

#include <thread>

// "Hide desktop icons" on Windows, for one display capture.
//
// WGC records a whole monitor and cannot leave another process's window out, so
// the icons cannot be excluded the way ScreenCaptureKit excludes Finder's desktop
// window. Instead this covers them: a borderless window, on the captured monitor
// only, painted with the wallpaper by `PaintDesktop`, and slotted into the z-order
// directly above the window that hosts the icons -- below every application window.
//
// No setting is touched: not "Show desktop icons", not the registry, not Explorer.
// The window belongs to this helper's thread, so it disappears with the recording
// and, just as surely, with a crashed or killed helper. There is nothing to restore.
//
// The user sees it too: the icons vanish from the real desktop while recording.
// That is why the option is opt-in and says so in its label.
class DesktopIconCover {
public:
    DesktopIconCover() = default;
    ~DesktopIconCover();
    DesktopIconCover(const DesktopIconCover&) = delete;
    DesktopIconCover& operator=(const DesktopIconCover&) = delete;

    // Returns once the cover is on screen and painted, or false when it could not
    // be placed (no icon host found, window creation failed). A false leaves the
    // desktop as it was; the recording goes ahead with the icons in it.
    bool show(HMONITOR monitor);

private:
    std::thread thread_;
    DWORD threadId_ = 0;
};
