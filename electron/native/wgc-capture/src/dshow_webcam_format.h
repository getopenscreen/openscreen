#pragma once

#include <Windows.h>
#include <dshow.h>

// Both subtypes store packed B,G,R,A bytes. The webcam encoder and preview ignore
// the camera's alpha channel, so neither needs a colour converter in the graph.
inline bool isBgraDshowSubtype(const GUID& subtype) {
    return subtype == MEDIASUBTYPE_RGB32 || subtype == MEDIASUBTYPE_ARGB32;
}
