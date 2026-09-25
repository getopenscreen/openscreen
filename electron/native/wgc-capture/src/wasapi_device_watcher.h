#pragma once

// DIAGNOSTIC ONLY, opt-in via OPENSCREEN_WGC_LOG_AUDIO_DEVICE_EVENTS=1 (see main.cpp).
//
// getopenscreen/openscreen#724: before committing to a fix, we need a real,
// timestamped signal on WHY a headset's render/capture endpoints change state
// mid-recording -- USB selective suspend, WASAPI endpoint idle, and the headset's
// own firmware auto-off all look the same to the user ("headphones turned off"),
// but only some of them are fixable from inside this process. This watcher answers
// that by registering an IMMNotificationClient for the duration of the recording
// and emitting a structured JSON event on every state transition of the default
// render and capture endpoints, so it can be correlated against the moment a user
// hears their headset drop.
//
// This does not attempt to fix anything -- it only observes and reports. See the
// issue for the three-way split this is meant to distinguish:
//   1. USB selective suspend (device level): the endpoint would go NOTPRESENT/
//      UNPLUGGED, i.e. the whole device disappears, not just the audio state.
//   2. WASAPI endpoint idle (audio-engine level): the endpoint would typically stay
//      ACTIVE while going quiet -- unlikely to show anything here at all, since nothing
//      in the device's own docs treats "unwritten render buffer" as a state change.
//   3. Headset firmware auto-off: same observable shape as (1) from Windows' point of
//      view (the endpoint disappears), but no amount of keeping the render endpoint
//      "busy" in software prevents a keyed hardware timer from firing.
//
// A DEVICE_STATE_NOTPRESENT/UNPLUGGED transition on the render or capture endpoint,
// correlated with the moment the user hears the drop, points at (1) or (3). No event
// at all around the drop, with the endpoint remaining ACTIVE throughout, would point
// at (2) instead -- but the converse does not hold: the confirmed case in #724
// (Corsair Void Wireless) produced zero events across every live drop, because the
// USB dongle stays enumerated and ACTIVE the whole time and only the RF link to the
// earcups drops, which is invisible to IMMNotificationClient. So silence here does
// not rule out a firmware timer; before concluding (2), check the vendor's own
// power management (e.g. iCUE) and a with-loopback vs mic-only comparison.
//
// Events are written to stderr, as one complete line per write: thread-emitted
// events go to stderr in this helper (the microphone-defaulted warning set that
// precedent), leaving stdout protocol lines owned by the main thread alone. Both
// streams end up merged in the drained helper log.
//
// IMMNotificationClient callbacks must be nonblocking (never resolve names, take a
// lock that can wait, or do I/O) per Microsoft's documented contract, so the
// callbacks here only copy their arguments into a PendingEvent and hand it to a
// worker thread, which does the (possibly slow) name lookup and the actual write.

#include <Windows.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <queue>
#include <string>
#include <thread>

class WasapiDeviceWatcher : public IMMNotificationClient {
public:
    WasapiDeviceWatcher() = default;
    ~WasapiDeviceWatcher();

    WasapiDeviceWatcher(const WasapiDeviceWatcher&) = delete;
    WasapiDeviceWatcher& operator=(const WasapiDeviceWatcher&) = delete;

    // Registers for notifications and enqueues one baseline event per endpoint
    // (render + capture) with their state at the moment the recording starts, so a
    // report has a starting point even if nothing changes afterward.
    bool start();
    // Unregisters callbacks, drains the queue, and joins the worker before
    // returning, so every event queued before stop() is guaranteed to be written.
    void stop();

    // IUnknown
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override;

    // IMMNotificationClient
    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR deviceId, DWORD newState) override;
    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR deviceId) override;
    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR deviceId) override;
    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR defaultDeviceId) override;
    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR deviceId, const PROPERTYKEY key) override;

private:
    struct PendingEvent {
        std::wstring eventName;
        std::wstring deviceId;
        std::string extraJson;
        // Baseline events resolve the endpoint themselves (they run on start(), not
        // a callback thread, so there is no blocking concern) and need no lookup.
        bool needsBaselineLookup = false;
        EDataFlow baselineFlow = eRender;
        std::wstring baselineFlowLabel;
    };

    void enqueue(const wchar_t* eventName, LPCWSTR deviceId, const char* extraJson);
    void enqueueBaseline(EDataFlow flow, const wchar_t* flowLabel);
    void workerLoop();
    void writeDeviceEvent(const PendingEvent& event);
    void writeBaseline(const PendingEvent& event);

    std::atomic<ULONG> refCount_ = 1;
    Microsoft::WRL::ComPtr<IMMDeviceEnumerator> deviceEnumerator_;
    bool registered_ = false;

    std::thread worker_;
    std::mutex queueMutex_;
    std::condition_variable queueCv_;
    std::queue<PendingEvent> queue_;
    bool workerStopRequested_ = false;
};
