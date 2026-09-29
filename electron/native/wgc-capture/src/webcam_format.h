#pragma once

#include <vector>

// One capture format a camera advertises.
struct WebcamFormat {
    int width = 0;
    int height = 0;
    int fps = 0;
    /**
     * True for MJPEG/H264 modes, which reach higher resolutions than a camera's
     * uncompressed ones but need a decoder MFT in front of the RGB32 conversion.
     */
    bool compressed = false;
};

// Picks the format to drive the camera at, given everything it advertises.
//
// Both capture backends used to leave this to the driver: Media Foundation was
// handed a media type with no MF_MT_FRAME_SIZE, and the DirectShow graph was
// rendered without touching IAMStreamConfig. In both cases the device answers
// with its *default* type, and for a UVC camera that is the first format it
// enumerates -- 640x480 even on a BRIO that offers 3840x2160. The recording was
// then upscaled into the overlay, which is the pixelation users reported.
//
// Rules, in order:
//   * uncompressed modes beat compressed ones outright, whatever their size.
//     Pinning a camera's MJPEG mode and asking the source reader for RGB32
//     leaves it delivering no samples at all on some hosts -- a recording with
//     no camera in it, which is far worse than a smaller one that works;
//   * only formats that fit inside the target in BOTH dimensions are eligible,
//     so an ultrawide mode cannot sneak in on pixel count alone;
//   * among those, the most pixels wins;
//   * ties go to the lowest frame rate that still reaches the target, else the
//     highest available -- a 1080p60 mode is no help when we encode at 30;
//   * if nothing fits (a camera that only does 4K), the smallest mode wins, so
//     we scale down rather than push 1 GB/s of RGB32 through the encoder;
//   * an empty list returns the target unchanged, letting the caller fall back
//     to whatever the driver would have picked on its own.
WebcamFormat chooseWebcamFormat(
    const std::vector<WebcamFormat>& available,
    int targetWidth,
    int targetHeight,
    int targetFps);
