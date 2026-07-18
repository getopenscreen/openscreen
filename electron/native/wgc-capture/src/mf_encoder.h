#pragma once

#include <Windows.h>
#include <d3d11.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

struct BgraFrameView {
    const BYTE* data = nullptr;
    int width = 0;
    int height = 0;
};

struct AudioInputFormat {
    GUID subtype = MFAudioFormat_PCM;
    UINT32 sampleRate = 0;
    UINT32 channels = 0;
    UINT32 bitsPerSample = 0;
    UINT32 blockAlign = 0;
    UINT32 avgBytesPerSec = 0;
};

struct MFEncoderOptions {
    bool preferSoftwareEncoder = false;
    bool injectDefaultSinkWriterFailureOnce = false;
    bool injectGpuFrameFailureOnce = false;
    bool allowGpuFrameTransport = true;
};

constexpr const char* kVideoEncoderSelectionDefault = "default";
constexpr const char* kVideoEncoderSelectionHardware = "hardware";
constexpr const char* kVideoEncoderSelectionSoftwareDefault = "software-default";
constexpr const char* kVideoEncoderSelectionSoftwarePreferred = "software-preferred";
constexpr const char* kVideoEncoderSelectionSoftwareFallback = "software-fallback";
constexpr const char* kVideoFrameTransportGpuZeroCopy = "gpu-zero-copy";
constexpr const char* kVideoFrameTransportCpuReadback = "cpu-readback";

class MFEncoder {
public:
    MFEncoder();
    ~MFEncoder();

    MFEncoder(const MFEncoder&) = delete;
    MFEncoder& operator=(const MFEncoder&) = delete;

    bool initialize(
        const std::wstring& outputPath,
        int width,
        int height,
        int fps,
        int bitrate,
        ID3D11Device* device,
        ID3D11DeviceContext* context,
        const AudioInputFormat* audioFormat = nullptr,
        MFEncoderOptions options = {});
    bool writeFrame(ID3D11Texture2D* texture, int64_t timestampHns, const BgraFrameView* webcamFrame = nullptr);
    bool writeBgraFrame(const BgraFrameView& frame, int64_t timestampHns);
    bool writeAudio(const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns);
    bool finalize();
    const char* videoEncoderSelection() const;
    const char* videoFrameTransport() const;
    uint64_t gpuFramesWritten() const;
    uint64_t cpuFramesWritten() const;

private:
    struct GpuFramePipeline;

    bool initializeGpuFramePipeline();
    bool writeGpuFrame(
        ID3D11Texture2D* texture,
        int64_t sampleTime,
        int64_t sampleDuration,
        bool& retryWithCpu);
    bool writeCpuFrame(
        ID3D11Texture2D* texture,
        int64_t sampleTime,
        int64_t sampleDuration,
        const BgraFrameView* webcamFrame);
    void disableGpuFrameTransport(const char* reason, HRESULT hr);
    bool ensureStagingTexture(ID3D11Texture2D* texture);
    bool copyFrameToBuffer(
        ID3D11Texture2D* texture,
        BYTE* destination,
        DWORD destinationSize,
        const BgraFrameView* webcamFrame);
    bool copyBgraFrameToBuffer(const BgraFrameView& frame, BYTE* destination, DWORD destinationSize);
    bool configureAudioStream(const AudioInputFormat& audioFormat);

    Microsoft::WRL::ComPtr<IMFSinkWriter> sinkWriter_;
    Microsoft::WRL::ComPtr<ID3D11Device> device_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> stagingTexture_;
    std::unique_ptr<GpuFramePipeline> gpuFramePipeline_;
    std::mutex writerMutex_;
    DWORD videoStreamIndex_ = 0;
    DWORD audioStreamIndex_ = 0;
    bool hasAudioStream_ = false;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 60;
    int64_t firstTimestampHns_ = -1;
    int64_t lastTimestampHns_ = -1;
    bool finalized_ = false;
    const char* videoEncoderSelection_ = kVideoEncoderSelectionDefault;
    const char* videoFrameTransport_ = kVideoFrameTransportCpuReadback;
    uint64_t gpuFramesWritten_ = 0;
    uint64_t cpuFramesWritten_ = 0;
    bool injectGpuFrameFailureOnce_ = false;
    bool injectedGpuFrameFailure_ = false;
};
