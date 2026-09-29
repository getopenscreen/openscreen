#include "webcam_format.h"

#include <algorithm>

namespace {

bool isUsable(const WebcamFormat& format) {
    return format.width > 0 && format.height > 0;
}

bool fitsTarget(const WebcamFormat& format, int targetWidth, int targetHeight) {
    return format.width <= targetWidth && format.height <= targetHeight;
}

long long pixels(const WebcamFormat& format) {
    return static_cast<long long>(format.width) * static_cast<long long>(format.height);
}

// True when `candidate` is a better frame rate than `best` for a target of
// `targetFps`: the lowest rate that still reaches the target, or -- when no
// mode reaches it -- the highest one on offer.
bool betterFps(int candidate, int best, int targetFps) {
    const bool candidateReaches = candidate >= targetFps;
    const bool bestReaches = best >= targetFps;
    if (candidateReaches != bestReaches) {
        return candidateReaches;
    }
    return candidateReaches ? candidate < best : candidate > best;
}

}  // namespace

WebcamFormat chooseWebcamFormat(
    const std::vector<WebcamFormat>& available,
    int targetWidth,
    int targetHeight,
    int targetFps) {
    const WebcamFormat target{targetWidth, targetHeight, targetFps, false};

    // Compressed modes are a last resort, so they are only considered when the
    // camera offers nothing else at all.
    const bool anyUncompressed = std::any_of(available.begin(), available.end(), [](const WebcamFormat& format) {
        return isUsable(format) && !format.compressed;
    });

    const auto eligible = [&](const WebcamFormat& format) {
        return isUsable(format) && !(anyUncompressed && format.compressed);
    };

    const bool anyFits = std::any_of(available.begin(), available.end(), [&](const WebcamFormat& format) {
        return eligible(format) && fitsTarget(format, targetWidth, targetHeight);
    });

    const WebcamFormat* best = nullptr;
    for (const WebcamFormat& format : available) {
        if (!eligible(format)) {
            continue;
        }
        // Once anything fits, oversized modes are out of the running entirely.
        // With nothing fitting we rank the oversized modes instead, smallest
        // first, so the scaler has the least work to do.
        if (anyFits != fitsTarget(format, targetWidth, targetHeight)) {
            continue;
        }
        if (best == nullptr) {
            best = &format;
            continue;
        }
        if (pixels(format) != pixels(*best)) {
            const bool wins = anyFits ? pixels(format) > pixels(*best) : pixels(format) < pixels(*best);
            if (wins) {
                best = &format;
            }
            continue;
        }
        if (betterFps(format.fps, best->fps, targetFps)) {
            best = &format;
        }
    }

    return best ? *best : target;
}
