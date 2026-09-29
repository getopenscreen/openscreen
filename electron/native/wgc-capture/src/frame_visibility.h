#pragma once

#include <cstdint>
#include <vector>

/**
 * Does this frame contain any picture, or is it the blank one a camera emits
 * while it is still warming up?
 *
 * Used before recording starts, to tell "the camera is running" from "the
 * camera is open but has not produced anything yet".
 */
bool hasVisibleBgraContent(const std::vector<std::uint8_t>& frame);

/**
 * The NV12 twin: luma is the Y plane, one byte per pixel, so no colour
 * conversion is needed. The Y plane is the first two thirds of the buffer.
 *
 * A camera's NV12 is studio-range, where black is 16 rather than 0. Those
 * values are normalised to full range before the thresholds are applied --
 * without that, the average of an all-black frame is 16, clears the average
 * threshold on its own, and every black frame counts as visible.
 */
bool hasVisibleNv12Content(const std::vector<std::uint8_t>& frame);

/** Dispatches to the probe matching the frame's layout. */
bool hasVisibleWebcamContent(const std::vector<std::uint8_t>& frame, bool isNv12);
