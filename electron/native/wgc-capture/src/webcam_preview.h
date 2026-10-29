#pragma once

#include "webcam_capture.h"
#include "webcam_preview_bitmap.h"
#include <condition_variable>
#include <filesystem>
#include <fstream>

// Latest-frame mailbox, replaced atomically. A slow UI never blocks the camera
// or encoder, and no frame queue grows during a long take.
class WebcamPreview {
public:
    WebcamPreview(WebcamCapture& capture, const std::wstring& path) {
        if (path.empty()) return;
        thread_ = std::thread([this, &capture, path] {
            const std::filesystem::path target(path);
            const std::filesystem::path pending(path + L".tmp");
            uint64_t sequence = 0;
            std::unique_lock lock(mutex_);
            while (!stopped_) {
                lock.unlock();
                WebcamFrameSnapshot frame;
                if (capture.copyLatestFrame(frame, sequence)) {
                    sequence = frame.sequence;
                    const auto bmp = webcamPreviewBitmap(frame.data, frame.width, frame.height, capture.deliversNv12());
                    if (!bmp.empty()) {
                        std::ofstream out(pending, std::ios::binary | std::ios::trunc);
                        out.write(reinterpret_cast<const char*>(bmp.data()), static_cast<std::streamsize>(bmp.size()));
                        out.close();
                        if (out) MoveFileExW(pending.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING);
                    }
                }
                lock.lock();
                cv_.wait_for(lock, std::chrono::milliseconds(200), [this] { return stopped_; });
            }
            lock.unlock();
            std::error_code ignored;
            std::filesystem::remove(pending, ignored);
            std::filesystem::remove(target, ignored);
        });
    }
    ~WebcamPreview() {
        { std::lock_guard lock(mutex_); stopped_ = true; }
        cv_.notify_all();
        if (thread_.joinable()) thread_.join();
    }
    WebcamPreview(const WebcamPreview&) = delete;
    WebcamPreview& operator=(const WebcamPreview&) = delete;
private:
    std::mutex mutex_;
    std::condition_variable cv_;
    bool stopped_ = false;
    std::thread thread_;
};
