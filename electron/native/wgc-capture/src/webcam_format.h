#pragma once

#include <vector>

// One capture format a camera advertises.
struct WebcamFormat {
    int width = 0;
    int height = 0;
    int fps = 0;
    /**
     * True for MJPEG/H264 modes, which reach higher resolutions than a camera's
     * uncompressed ones but cost a decode on the CPU for every frame.
     */
    bool compressed = false;
    // Backend enumeration identity. Dimensions and rate alone cannot distinguish
    // DirectShow subtypes; -1 is the driver-default fallback for an empty list.
    int sourceIndex = -1;
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
//   * a compressed mode is out when decoding it costs more than 1080p at 30
//     fps (an MJPEG 4K mode, say), unless the camera offers nothing cheaper.
//     Under that ceiling it competes like any other mode: a C920 only reaches
//     1080p at 30 in MJPEG, its uncompressed 1080p runs at 5 fps;
//   * only formats that fit inside the target in BOTH dimensions are eligible,
//     so an ultrawide mode cannot sneak in on pixel count alone;
//   * among those, the frame rate comes first: the highest rate up to the
//     target wins, so a C920's 2304x1536 at 2 fps loses to its 1080p at 30.
//     Ranking pixels first drove that camera at 2 to 5 fps on every preset;
//   * then the most pixels;
//   * then an uncompressed mode over a compressed one, which only adds a decode;
//   * remaining ties go to the lowest frame rate that still reaches the
//     target, else the highest available -- a 1080p60 mode is no help when we
//     encode at 30;
//   * if nothing fits (a camera that only does 4K), the smallest mode at the
//     best rate wins, so we scale down rather than push 1 GB/s of RGB32
//     through the encoder;
//   * an empty list returns the target unchanged, letting the caller fall back
//     to whatever the driver would have picked on its own.
WebcamFormat chooseWebcamFormat(
    const std::vector<WebcamFormat>& available,
    int targetWidth,
    int targetHeight,
    int targetFps);
