// What the H.264 track actually says about itself (getopenscreen/openscreen#922,
// #923). Drives the real MFEncoder with synthetic BGRA frames -- three solid
// bands, red, green and blue -- into a temporary MP4, then reads the file back
// with ffprobe and ffmpeg: the profile, the colour tags, and the YUV values the
// encoder really produced for each band. The compositor decodes every
// recording as BT.709 limited range, so that is what the file has to be and
// has to say.
//
// Needs ffprobe and ffmpeg on PATH; without them the checks are skipped, not
// failed. The hardware encoder is covered when the host has one.

#include "mf_encoder.h"

#include <d3d11.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {

int g_ran = 0;
int g_failed = 0;

void expect(const std::string& name, bool ok, const std::string& detail) {
    g_ran += 1;
    std::cout << (ok ? "PASS " : "FAIL ") << name << (ok ? "" : " " + detail) << "\n";
    if (!ok) {
        g_failed += 1;
    }
}

void skip(const std::string& name, const std::string& reason) {
    std::cout << "SKIP " << name << " " << reason << "\n";
}

std::string run(const std::string& command) {
    std::string output;
    FILE* pipe = _popen(command.c_str(), "rb");
    if (!pipe) {
        return output;
    }
    char buffer[65536];
    size_t read = 0;
    while ((read = fread(buffer, 1, sizeof(buffer), pipe)) > 0) {
        output.append(buffer, read);
    }
    _pclose(pipe);
    return output;
}

// GetTempPathA answers in the ANSI code page, which _popen also speaks; the
// encoder takes a wide path, so widen it through that code page, not per byte.
std::wstring widen(const std::string& ansi) {
    const int size = MultiByteToWideChar(CP_ACP, 0, ansi.data(), static_cast<int>(ansi.size()), nullptr, 0);
    std::wstring result(size, L'\0');
    MultiByteToWideChar(CP_ACP, 0, ansi.data(), static_cast<int>(ansi.size()), result.data(), size);
    return result;
}

bool toolsAvailable() {
    return run("ffprobe -version 2>NUL").find("ffprobe") != std::string::npos &&
           run("ffmpeg -version 2>NUL").find("ffmpeg") != std::string::npos;
}

std::string field(const std::string& probe, const std::string& key) {
    const auto at = probe.find(key + "=");
    if (at == std::string::npos) {
        return "";
    }
    const auto start = at + key.size() + 1;
    const auto end = probe.find_first_of("\r\n", start);
    return probe.substr(start, end - start);
}

constexpr int kWidth = 480;
constexpr int kHeight = 272;
constexpr int kFrames = 30;

struct Expected {
    const char* name;
    int y, cb, cr;
};
// BT.709, studio range. BT.601 would put red at Y 81, Cb 90.
constexpr Expected kBands[] = {{"red", 63, 102, 240}, {"green", 173, 42, 26}, {"blue", 32, 240, 118}};

void checkEncoder(ID3D11Device* device, ID3D11DeviceContext* context, bool software) {
    const std::string label = software ? "software" : "default";
    char tempDir[MAX_PATH]{};
    GetTempPathA(MAX_PATH, tempDir);
    const std::string path = std::string(tempDir) + "openscreen-mf-encoder-color-" + label + ".mp4";
    const std::wstring widePath = widen(path);
    DeleteFileA(path.c_str());

    std::vector<BYTE> bgra(static_cast<size_t>(kWidth) * kHeight * 4);
    for (int y = 0; y < kHeight; y += 1) {
        for (int x = 0; x < kWidth; x += 1) {
            BYTE* pixel = &bgra[(static_cast<size_t>(y) * kWidth + x) * 4];
            const int band = x * 3 / kWidth;
            pixel[0] = band == 2 ? 255 : 0;  // B
            pixel[1] = band == 1 ? 255 : 0;  // G
            pixel[2] = band == 0 ? 255 : 0;  // R
            pixel[3] = 255;
        }
    }

    {
        MFEncoder encoder;
        MFEncoderOptions options;
        options.preferSoftwareEncoder = software;
        if (!encoder.initialize(widePath, kWidth, kHeight, 30, 2'000'000, device, context, nullptr, options)) {
            expect("encoder-initialize-" + label, false, "initialize failed");
            return;
        }
        const std::string runtime = encoder.videoEncoderRuntime();
        std::cout << "COLOR_RAW " << label << " runtime=" << runtime << "\n";
        if (!software && runtime != kVideoEncoderRuntimeHardware) {
            skip("encoder-" + label, "no hardware H.264 encoder on this host (" + runtime + ")");
            encoder.finalize();
            return;
        }
        const BgraFrameView frame{bgra.data(), kWidth, kHeight};
        bool wrote = true;
        for (int i = 0; i < kFrames && wrote; i += 1) {
            Microsoft::WRL::ComPtr<IMFSample> sample;
            wrote = encoder.captureBgraSample(frame, static_cast<int64_t>(i) * 333'333, sample) &&
                    encoder.submitVideoSample(sample.Get());
        }
        expect("encoder-writes-" + label, wrote && encoder.finalize(), "write or finalize failed");
    }

    const std::string probe = run(
        "ffprobe -v error -select_streams v:0 -show_entries "
        "stream=profile,has_b_frames,color_range,color_space,color_primaries,color_transfer -of default=nw=1 \"" +
        path + "\"");
    std::cout << "COLOR_RAW " << label << " profile=" << field(probe, "profile")
              << " range=" << field(probe, "color_range") << " space=" << field(probe, "color_space")
              << " primaries=" << field(probe, "color_primaries")
              << " transfer=" << field(probe, "color_transfer") << "\n";
    expect("profile-high-" + label, field(probe, "profile") == "High", probe);
    // B-frames broke the fragmented writer on macOS; the profile must not bring them.
    expect("no-b-frames-" + label, field(probe, "has_b_frames") == "0", probe);
    expect(
        "colour-tags-bt709-limited-" + label,
        field(probe, "color_range") == "tv" && field(probe, "color_space") == "bt709" &&
            field(probe, "color_primaries") == "bt709" && field(probe, "color_transfer") == "bt709",
        probe);

    // The last frame, as the encoder wrote its samples: yuv420p out of a yuv420p
    // stream is a straight copy, no range or matrix conversion on the way.
    const std::string yuv = run(
        "ffmpeg -v error -sseof -0.2 -i \"" + path + "\" -frames:v 1 -f rawvideo -pix_fmt yuv420p -");
    const size_t lumaSize = static_cast<size_t>(kWidth) * kHeight;
    if (yuv.size() < lumaSize * 3 / 2) {
        expect("yuv-readback-" + label, false, "ffmpeg returned " + std::to_string(yuv.size()) + " bytes");
        return;
    }
    for (int band = 0; band < 3; band += 1) {
        const int x = kWidth * (2 * band + 1) / 6;
        const int y = kHeight / 2;
        const int luma = static_cast<unsigned char>(yuv[static_cast<size_t>(y) * kWidth + x]);
        const size_t chroma = static_cast<size_t>(y / 2) * (kWidth / 2) + x / 2;
        const int cb = static_cast<unsigned char>(yuv[lumaSize + chroma]);
        const int cr = static_cast<unsigned char>(yuv[lumaSize + lumaSize / 4 + chroma]);
        const Expected& want = kBands[band];
        char detail[128]{};
        sprintf_s(
            detail, "%s Y=%d Cb=%d Cr=%d, BT.709 limited wants %d/%d/%d", want.name, luma, cb, cr, want.y,
            want.cb, want.cr);
        std::cout << "COLOR_RAW " << label << " " << detail << "\n";
        expect(
            std::string("yuv-bt709-") + want.name + "-" + label,
            std::abs(luma - want.y) <= 3 && std::abs(cb - want.cb) <= 3 && std::abs(cr - want.cr) <= 3,
            detail);
    }
    DeleteFileA(path.c_str());
}

// The converter against BT.709 in double precision, on noise: solid bands
// cannot tell a 2x2 average from a wrong pairing of pixels, and 38 wide with a
// padded stride runs the SIMD body, its scalar tail and the row pitch.
void checkConverterAgainstReference() {
    constexpr int width = 38;
    constexpr int height = 22;
    constexpr int stride = width * 4 + 24;
    std::vector<BYTE> bgra(static_cast<size_t>(stride) * height);
    uint32_t seed = 12345;
    for (BYTE& value : bgra) {
        seed = seed * 1664525u + 1013904223u;
        value = static_cast<BYTE>(seed >> 24);
    }
    std::vector<BYTE> nv12(static_cast<size_t>(width) * height * 3 / 2);
    convertBgraToNv12Bt709(bgra.data(), stride, width, height, nv12.data());

    const double kr = 0.2126;
    const double kb = 0.0722;
    const auto channel = [&](int x, int y, int c) { return bgra[static_cast<size_t>(y) * stride + x * 4 + c] / 255.0; };
    int worst = 0;
    for (int y = 0; y < height; y += 1) {
        for (int x = 0; x < width; x += 1) {
            const double luma = kr * channel(x, y, 2) + (1 - kr - kb) * channel(x, y, 1) + kb * channel(x, y, 0);
            const int want = static_cast<int>(std::lround(16 + 219 * luma));
            worst = std::max(worst, std::abs(want - nv12[static_cast<size_t>(y) * width + x]));
        }
    }
    for (int y = 0; y < height; y += 2) {
        for (int x = 0; x < width; x += 2) {
            double r = 0, g = 0, b = 0;
            for (int dy = 0; dy < 2; dy += 1) {
                for (int dx = 0; dx < 2; dx += 1) {
                    r += channel(x + dx, y + dy, 2) / 4;
                    g += channel(x + dx, y + dy, 1) / 4;
                    b += channel(x + dx, y + dy, 0) / 4;
                }
            }
            const double luma = kr * r + (1 - kr - kb) * g + kb * b;
            const int cb = static_cast<int>(std::lround(128 + 224 * (b - luma) / (2 * (1 - kb))));
            const int cr = static_cast<int>(std::lround(128 + 224 * (r - luma) / (2 * (1 - kr))));
            const size_t at = static_cast<size_t>(width) * height + static_cast<size_t>(y / 2) * width + x;
            worst = std::max({worst, std::abs(cb - nv12[at]), std::abs(cr - nv12[at + 1])});
        }
    }
    std::cout << "COLOR_RAW converter worst deviation from BT.709 = " << worst << " code values" << std::endl;
    expect("converter-matches-bt709-reference", worst <= 1, "worst=" + std::to_string(worst));
}

// Not a pass/fail: what one 1080p frame costs to hand over and encode, for a
// before/after comparison of the conversion's cost.
void timeFullHd(ID3D11Device* device, ID3D11DeviceContext* context) {
    constexpr int width = 1920;
    constexpr int height = 1080;
    constexpr int frames = 120;
    char tempDir[MAX_PATH]{};
    GetTempPathA(MAX_PATH, tempDir);
    const std::string path = std::string(tempDir) + "openscreen-mf-encoder-timing.mp4";
    const std::wstring widePath = widen(path);
    std::vector<BYTE> bgra(static_cast<size_t>(width) * height * 4);
    for (size_t i = 0; i < bgra.size(); i += 1) {
        bgra[i] = static_cast<BYTE>((i * 2654435761u) >> 24);
    }
    MFEncoder encoder;
    if (!encoder.initialize(widePath, width, height, 60, 18'000'000, device, context, nullptr, {})) {
        return;
    }
    const BgraFrameView frame{bgra.data(), width, height};
    double captureMs = 0.0;
    double submitMs = 0.0;
    for (int i = 0; i < frames; i += 1) {
        Microsoft::WRL::ComPtr<IMFSample> sample;
        const auto start = std::chrono::steady_clock::now();
        encoder.captureBgraSample(frame, static_cast<int64_t>(i) * 166'667, sample);
        const auto captured = std::chrono::steady_clock::now();
        encoder.submitVideoSample(sample.Get());
        const auto submitted = std::chrono::steady_clock::now();
        captureMs += std::chrono::duration<double, std::milli>(captured - start).count();
        submitMs += std::chrono::duration<double, std::milli>(submitted - captured).count();
    }
    encoder.finalize();
    DeleteFileA(path.c_str());
    std::cout << "COLOR_RAW timing 1080p " << encoder.videoEncoderRuntime() << ": capture "
              << captureMs / frames << " ms, submit " << submitMs / frames << " ms per frame" << std::endl;
}

} // namespace

int main() {
    checkConverterAgainstReference();
    if (!toolsAvailable()) {
        skip("mf-encoder-color", "ffprobe/ffmpeg not on PATH");
        return g_failed == 0 ? 0 : 1;
    }
    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
        skip("mf-encoder-color", "CoInitializeEx failed");
        return 0;
    }
    Microsoft::WRL::ComPtr<ID3D11Device> device;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
    const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    if (FAILED(D3D11CreateDevice(
            nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, nullptr, 0, D3D11_SDK_VERSION, &device,
            nullptr, &context)) &&
        FAILED(D3D11CreateDevice(
            nullptr, D3D_DRIVER_TYPE_WARP, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
            D3D11_SDK_VERSION, &device, nullptr, &context))) {
        skip("mf-encoder-color", "no D3D11 device");
        return 0;
    }
    checkEncoder(device.Get(), context.Get(), true);
    checkEncoder(device.Get(), context.Get(), false);
    timeFullHd(device.Get(), context.Get());

    std::cout << "ran " << g_ran << " tests\n";
    if (g_failed != 0) {
        std::cout << g_failed << " failed\n";
        return 1;
    }
    return 0;
}
