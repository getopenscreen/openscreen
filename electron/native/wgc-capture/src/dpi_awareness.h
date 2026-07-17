#pragma once

#include <Windows.h>

// Native capture coordinates must never be DPI-virtualized. Call this before
// WinRT, GDI, monitor enumeration, or any window-coordinate API is initialized.
inline bool enablePerMonitorV2DpiAwareness() {
	if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
		return true;
	}

	// ERROR_ACCESS_DENIED means the process default was already selected (for
	// example by a manifest). Only continue if the active context is actually
	// PMv2; accepting a different context would silently reintroduce DPI
	// virtualization into the capture coordinates.
	return GetLastError() == ERROR_ACCESS_DENIED &&
		AreDpiAwarenessContextsEqual(
			GetThreadDpiAwarenessContext(),
			DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}
