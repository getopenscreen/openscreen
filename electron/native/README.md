# Native capture helpers

## macOS

macOS native recording will use a ScreenCaptureKit helper with the same process boundary as the Windows WGC helper:

1. Electron resolves the selected source, output paths, and user-selected devices.
2. The helper receives one structured JSON request.
3. The helper owns ScreenCaptureKit/AVFoundation capture, timing, encoding, and muxing.
4. Electron persists the resulting media/session manifest and reports helper errors explicitly.

Helper locations:

1. `OPENSCREEN_SCK_CAPTURE_EXE`, for local development and diagnostics.
2. `electron/native/screencapturekit/build/openscreen-screencapturekit-helper`, for locally built Swift output.
3. `electron/native/bin/darwin-arm64/openscreen-screencapturekit-helper` or `electron/native/bin/darwin-x64/openscreen-screencapturekit-helper`, for packaged prebuilt helpers.

Build the macOS helper with:

```bash
npm run build:native:mac
```

On non-macOS hosts this command exits successfully and does not affect Windows/Linux development. On macOS it builds the Swift package at `electron/native/screencapturekit`, writes the development binary to `electron/native/screencapturekit/build/openscreen-screencapturekit-helper`, and copies the redistributable binary to `electron/native/bin/darwin-${arch}/openscreen-screencapturekit-helper`.

The current helper implementation supports display/window ScreenCaptureKit video capture, cursor exclusion through `SCStreamConfiguration.showsCursor`, H.264 encoding, MP4 muxing, and ScreenCaptureKit system audio. It also attempts native ScreenCaptureKit microphone capture when the running macOS version exposes that capability. Webcam recording currently stays as an Electron sidecar and is attached to the same recording session after the native screen capture stops.

Electron exposes `is-native-mac-capture-available` for capability probing. It resolves the same helper locations listed above and reports `missing-helper` until a Swift helper binary is present. When available, macOS recording routes screen/window capture through the native helper so editable cursor recordings do not bake the system cursor into the video.

See `docs/engineering/macos-native-recorder-roadmap.md` for the contract, rollout phases, and SSOT rules.

## Windows

Windows native recording is resolved from one of these locations:

1. `OPENSCREEN_WGC_CAPTURE_EXE`, for local development and diagnostics.
2. `electron/native/wgc-capture/build/wgc-capture.exe`, for a locally built Ninja helper.
3. `electron/native/wgc-capture/build/Release/wgc-capture.exe`, for a locally built multi-config helper.
4. `electron/native/bin/win32-x64/wgc-capture.exe` or `electron/native/bin/win32-arm64/wgc-capture.exe`, for packaged prebuilt helpers.

Build the Windows helper with:

```powershell
npm run build:native:win
```

The build writes the CMake output to `electron/native/wgc-capture/build/wgc-capture.exe` and copies the redistributable binary to `electron/native/bin/win32-x64/wgc-capture.exe`.

The helper contract is process-based: the app starts the process with one JSON argument and sends commands on stdin. `stop\n` finalizes the recording. During migration the helper prints both newline-delimited JSON events and the legacy text messages `Recording started` / `Recording stopped. Output path: <path>`.

Current V2 JSON shape:

```json
{
  "schemaVersion": 2,
  "recordingId": 123,
  "sourceType": "display",
  "sourceId": "screen:0:0",
  "displayId": 1,
  "windowHandle": null,
  "outputPath": "C:\\path\\recording-123.mp4",
  "videoWidth": 1920,
  "videoHeight": 1080,
  "fps": 60,
  "captureSystemAudio": false,
  "captureMic": false,
  "microphoneDeviceId": "default",
  "microphoneDeviceName": "Microphone (NVIDIA Broadcast)",
  "microphoneGain": 1.4,
  "webcamEnabled": true,
  "webcamDeviceId": "default",
  "webcamDeviceName": "Camera (NVIDIA Broadcast)",
  "webcamWidth": 1280,
  "webcamHeight": 720,
  "webcamFps": 30,
  "outputs": {
    "screenPath": "C:\\path\\recording-123.mp4"
  }
}
```

The current helper implementation supports display/window video capture, system audio loopback, selected-microphone capture, Media Foundation webcam capture, and a DirectShow webcam fallback for virtual cameras that are not exposed through Media Foundation. Webcam frames are currently composed into the primary MP4 as a bottom-right picture-in-picture overlay. Browser `deviceId` values do not always map to Media Foundation symbolic links or WASAPI endpoint IDs, so the renderer passes both browser IDs and user-visible device names. For microphones, the helper tries the requested WASAPI endpoint ID first, then resolves an active capture endpoint by `microphoneDeviceName`, then falls back to the default endpoint. For webcams, Electron resolves a matching DirectShow filter CLSID for the selected label; the helper uses Media Foundation first, then that exact DirectShow filter when the requested camera is absent from Media Foundation.

Smoke-test the helper with:

```powershell
npm run test:wgc-helper:win
npm run test:wgc-window:win
npm run test:wgc-audio:win
npm run test:wgc-mic:win
npm run test:wgc-mixed-audio:win
npm run test:wgc-webcam:win
```

To validate a specific native webcam manually:

```powershell
$env:OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME = "NVIDIA Broadcast"
npm run test:wgc-webcam:win
Remove-Item Env:OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME
```

To validate a specific native microphone manually:

```powershell
$env:OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_NAME = "Microphone (NVIDIA Broadcast)"
npm run test:wgc-mic:win
Remove-Item Env:OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_NAME
```
