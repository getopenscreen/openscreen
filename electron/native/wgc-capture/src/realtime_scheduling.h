#pragma once

#include <Windows.h>
#include <avrt.h>
#include <timeapi.h>

#include <iostream>

// Every wait in the capture helpers -- the video writer's deadline, the WASAPI
// poll, the audio mixer's chunk clock, the cursor sampler's interval -- lands on
// the system timer tick, and a process that asks for nothing gets the default
// 15.625 ms one. Measured on a real take (getopenscreen/openscreen#920, #921):
// webcam frames spaced in whole ticks, 25.9 unique frames/s for a 30 fps camera;
// the cursor sampled at 22.7 Hz for 30 asked; WASAPI packets handed over late
// enough to leave holes in the voice (#911).
//
// Held for the life of the process. Windows 11 ignores the timer request of a
// process it throttles (a minimized or occluded app, which a recording helper
// always is), so the process is also opted out of power throttling for both
// execution speed and timer resolution. Either call failing is logged and
// survived: the recording still works at the coarser tick, as it always has.
class HighResolutionTiming {
public:
    HighResolutionTiming() {
        PROCESS_POWER_THROTTLING_STATE throttling{};
        throttling.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
        throttling.ControlMask =
            PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
        throttling.StateMask = 0;
        if (!SetProcessInformation(
                GetCurrentProcess(), ProcessPowerThrottling, &throttling, sizeof(throttling))) {
            std::cerr << "WARNING: Could not opt out of power throttling (error " << GetLastError()
                      << ")" << std::endl;
        }
        periodSet_ = timeBeginPeriod(1) == TIMERR_NOERROR;
        if (!periodSet_) {
            std::cerr << "WARNING: Could not raise the timer resolution to 1 ms" << std::endl;
        }
    }
    ~HighResolutionTiming() {
        if (periodSet_) {
            timeEndPeriod(1);
        }
    }
    HighResolutionTiming(const HighResolutionTiming&) = delete;
    HighResolutionTiming& operator=(const HighResolutionTiming&) = delete;

private:
    bool periodSet_ = false;
};

// Registers the calling thread with MMCSS for as long as it lives, so the
// scheduler favours it over ordinary work while the machine is busy -- the
// stalls that outlast the timer tick. `task` is a task name from the registry's
// MMCSS profile: "Pro Audio" for the audio threads, "Capture" for video. A thread
// that cannot register runs at its normal priority, as before.
class MmcssThread {
public:
    explicit MmcssThread(const wchar_t* task) {
        DWORD taskIndex = 0;
        handle_ = AvSetMmThreadCharacteristicsW(task, &taskIndex);
        if (!handle_) {
            std::wcerr << L"WARNING: Could not register thread with MMCSS task \"" << task
                       << L"\" (error " << GetLastError() << L")" << std::endl;
        }
    }
    ~MmcssThread() {
        if (handle_) {
            AvRevertMmThreadCharacteristics(handle_);
        }
    }
    MmcssThread(const MmcssThread&) = delete;
    MmcssThread& operator=(const MmcssThread&) = delete;

private:
    HANDLE handle_ = nullptr;
};
