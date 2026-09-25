#include "wasapi_device_watcher.h"

#include <Functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>

#include <chrono>
#include <cstdio>
#include <iostream>
#include <sstream>

namespace {

std::string wideToUtf8(const std::wstring& value) {
    if (value.empty()) {
        return {};
    }
    const int size = WideCharToMultiByte(
        CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(
        CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

std::string jsonEscape(const std::string& value) {
    std::string result;
    result.reserve(value.size());
    for (const char c : value) {
        switch (c) {
            case '\\':
                result += "\\\\";
                break;
            case '"':
                result += "\\\"";
                break;
            case '\n':
                result += "\\n";
                break;
            default:
                result += c;
        }
    }
    return result;
}

std::string deviceStateLabel(DWORD state) {
    switch (state) {
        case DEVICE_STATE_ACTIVE:
            return "active";
        case DEVICE_STATE_DISABLED:
            return "disabled";
        case DEVICE_STATE_NOTPRESENT:
            return "not-present";
        case DEVICE_STATE_UNPLUGGED:
            return "unplugged";
        default:
            return "unknown";
    }
}

int64_t nowUnixMillis() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

// Only ever called from the worker thread or from start() (before the worker
// exists), never from an IMMNotificationClient callback -- this does a property
// store round trip and must not run on the callback thread.
std::wstring friendlyNameForDevice(IMMDeviceEnumerator* enumerator, const std::wstring& deviceId) {
    if (!enumerator || deviceId.empty()) {
        return {};
    }
    Microsoft::WRL::ComPtr<IMMDevice> device;
    if (FAILED(enumerator->GetDevice(deviceId.c_str(), &device)) || !device) {
        return {};
    }
    Microsoft::WRL::ComPtr<IPropertyStore> properties;
    if (FAILED(device->OpenPropertyStore(STGM_READ, &properties)) || !properties) {
        return {};
    }
    PROPVARIANT value;
    PropVariantInit(&value);
    std::wstring name;
    if (SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR &&
        value.pwszVal) {
        name = value.pwszVal;
    }
    PropVariantClear(&value);
    return name;
}

} // namespace

WasapiDeviceWatcher::~WasapiDeviceWatcher() {
    stop();
}

bool WasapiDeviceWatcher::start() {
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&deviceEnumerator_));
    if (FAILED(hr) || !deviceEnumerator_) {
        std::cerr << "WARNING: [device-watcher] CoCreateInstance(MMDeviceEnumerator) failed (hr=0x"
                  << std::hex << hr << std::dec << ")" << std::endl;
        return false;
    }

    hr = deviceEnumerator_->RegisterEndpointNotificationCallback(this);
    if (FAILED(hr)) {
        std::cerr << "WARNING: [device-watcher] RegisterEndpointNotificationCallback failed (hr=0x"
                  << std::hex << hr << std::dec << ")" << std::endl;
        deviceEnumerator_.Reset();
        return false;
    }
    registered_ = true;

    workerStopRequested_ = false;
    worker_ = std::thread([this] {
        workerLoop();
    });

    enqueueBaseline(eRender, L"render");
    enqueueBaseline(eCapture, L"capture");
    return true;
}

void WasapiDeviceWatcher::stop() {
    if (registered_ && deviceEnumerator_) {
        deviceEnumerator_->UnregisterEndpointNotificationCallback(this);
    }
    registered_ = false;

    // The worker dereferences deviceEnumerator_ (writeBaseline calls
    // GetDefaultAudioEndpoint through it), and stop() can run while events are
    // still queued -- main.cpp calls this on every early-failure path, potentially
    // right after start() enqueued the baselines. Drain and join first, release
    // the enumerator last, or the worker wakes up holding a dangling pointer.
    if (worker_.joinable()) {
        {
            std::lock_guard<std::mutex> lock(queueMutex_);
            workerStopRequested_ = true;
        }
        queueCv_.notify_one();
        worker_.join();
    }
    deviceEnumerator_.Reset();
}

void WasapiDeviceWatcher::workerLoop() {
    // GetDefaultAudioEndpoint/GetDevice/CoTaskMemFree are called from this thread,
    // which is otherwise never COM-initialized. Both this and the wmain thread are
    // MTA (see winrt::init_apartment in main.cpp), so no marshaling is needed --
    // this only satisfies the "calling thread must be initialized" requirement.
    const HRESULT comInit = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(comInit)) {
        std::cerr << "WARNING: [device-watcher] CoInitializeEx(COINIT_MULTITHREADED) failed (hr=0x"
                  << std::hex << comInit << std::dec << ")" << std::endl;
        return;
    }

    // This thread owns all name resolution and all event writes for this watcher,
    // so nothing here runs on an IMMNotificationClient callback thread.
    while (true) {
        PendingEvent event;
        {
            std::unique_lock<std::mutex> lock(queueMutex_);
            queueCv_.wait(lock, [this] { return !queue_.empty() || workerStopRequested_; });
            if (queue_.empty()) {
                if (workerStopRequested_) {
                    break;
                }
                continue;
            }
            event = std::move(queue_.front());
            queue_.pop();
        }

        if (event.needsBaselineLookup) {
            writeBaseline(event);
        } else {
            writeDeviceEvent(event);
        }
    }
    CoUninitialize();
}

void WasapiDeviceWatcher::enqueueBaseline(EDataFlow flow, const wchar_t* flowLabel) {
    PendingEvent event;
    event.needsBaselineLookup = true;
    event.baselineFlow = flow;
    event.baselineFlowLabel = flowLabel;
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        queue_.push(std::move(event));
    }
    queueCv_.notify_one();
}

void WasapiDeviceWatcher::writeBaseline(const PendingEvent& event) {
    Microsoft::WRL::ComPtr<IMMDevice> device;
    HRESULT hr = deviceEnumerator_->GetDefaultAudioEndpoint(event.baselineFlow, eConsole, &device);
    if (FAILED(hr) || !device) {
        return;
    }

    LPWSTR rawId = nullptr;
    std::wstring id;
    if (SUCCEEDED(device->GetId(&rawId)) && rawId) {
        id = rawId;
        CoTaskMemFree(rawId);
    }

    DWORD state = 0;
    device->GetState(&state);
    const std::wstring name = friendlyNameForDevice(deviceEnumerator_.Get(), id);

    // Built as one complete string before the write, and emitted with a single
    // stream operation. Events from helper threads go to stderr -- the
    // microphone-defaulted warning set that precedent -- so stdout protocol
    // lines stay owned by the main thread alone.
    std::ostringstream line;
    line << "{\"event\":\"audio-device-watch\",\"schemaVersion\":1,\"type\":\"baseline\","
            "\"flow\":\""
         << wideToUtf8(event.baselineFlowLabel) << "\",\"deviceId\":\"" << jsonEscape(wideToUtf8(id))
         << "\",\"deviceName\":\"" << jsonEscape(wideToUtf8(name)) << "\",\"state\":\""
         << deviceStateLabel(state) << "\",\"timestampMs\":" << nowUnixMillis() << "}\n";

    std::cerr << line.str() << std::flush;
}

void WasapiDeviceWatcher::enqueue(const wchar_t* eventName, LPCWSTR deviceId, const char* extraJson) {
    PendingEvent event;
    event.eventName = eventName ? eventName : L"";
    event.deviceId = deviceId ? deviceId : L"";
    event.extraJson = extraJson ? extraJson : "";
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        queue_.push(std::move(event));
    }
    queueCv_.notify_one();
}

void WasapiDeviceWatcher::writeDeviceEvent(const PendingEvent& event) {
    const std::wstring name = friendlyNameForDevice(deviceEnumerator_.Get(), event.deviceId);

    std::ostringstream line;
    line << "{\"event\":\"audio-device-watch\",\"schemaVersion\":1,\"type\":\""
         << wideToUtf8(event.eventName) << "\",\"deviceId\":\""
         << jsonEscape(wideToUtf8(event.deviceId)) << "\",\"deviceName\":\""
         << jsonEscape(wideToUtf8(name)) << "\"";
    if (!event.extraJson.empty()) {
        line << "," << event.extraJson;
    }
    line << ",\"timestampMs\":" << nowUnixMillis() << "}\n";

    std::cerr << line.str() << std::flush;
}

ULONG STDMETHODCALLTYPE WasapiDeviceWatcher::AddRef() {
    return ++refCount_;
}

ULONG STDMETHODCALLTYPE WasapiDeviceWatcher::Release() {
    // This object's lifetime is owned by main.cpp, not by COM: it lives on the
    // stack for the duration of the recording and unregisters in stop() before
    // destruction, so a ref count reaching zero here must not delete `this`.
    const ULONG count = --refCount_;
    return count;
}

HRESULT STDMETHODCALLTYPE WasapiDeviceWatcher::QueryInterface(REFIID riid, void** ppvObject) {
    if (!ppvObject) {
        return E_POINTER;
    }
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
        *ppvObject = static_cast<IMMNotificationClient*>(this);
        AddRef();
        return S_OK;
    }
    *ppvObject = nullptr;
    return E_NOINTERFACE;
}

// Every method below runs on a COM callback thread and must be nonblocking per
// IMMNotificationClient's documented contract: no name resolution, no I/O, no
// lock that can wait. Each one only copies its arguments and enqueues them --
// see workerLoop() for where the real work happens.

HRESULT STDMETHODCALLTYPE WasapiDeviceWatcher::OnDeviceStateChanged(LPCWSTR deviceId, DWORD newState) {
    char extra[64];
    snprintf(extra, sizeof(extra), "\"state\":\"%s\"", deviceStateLabel(newState).c_str());
    enqueue(L"state-changed", deviceId, extra);
    return S_OK;
}

HRESULT STDMETHODCALLTYPE WasapiDeviceWatcher::OnDeviceAdded(LPCWSTR deviceId) {
    enqueue(L"added", deviceId, nullptr);
    return S_OK;
}

HRESULT STDMETHODCALLTYPE WasapiDeviceWatcher::OnDeviceRemoved(LPCWSTR deviceId) {
    enqueue(L"removed", deviceId, nullptr);
    return S_OK;
}

HRESULT STDMETHODCALLTYPE WasapiDeviceWatcher::OnDefaultDeviceChanged(
    EDataFlow flow, ERole role, LPCWSTR defaultDeviceId) {
    // Only eConsole is what this app's capture paths use (GetDefaultAudioEndpoint
    // calls elsewhere all pass eConsole); the other roles fire independently and
    // would just be noise here.
    if (role != eConsole) {
        return S_OK;
    }
    // Sized for the longest payload: "flow":"capture" is 16 chars plus the
    // terminator, and 16 bytes truncates the closing quote into a malformed line.
    char extra[32];
    snprintf(extra, sizeof(extra), "\"flow\":\"%s\"", flow == eRender ? "render" : "capture");
    enqueue(L"default-changed", defaultDeviceId, extra);
    return S_OK;
}

HRESULT STDMETHODCALLTYPE WasapiDeviceWatcher::OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) {
    // Not interesting for this diagnosis: fires on things like a renamed endpoint,
    // not on power/connection state.
    return S_OK;
}
