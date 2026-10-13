# Audio and subtitle exchange

The Media page provides local file exchange beside each selected source. Video and imported audio are listed separately; audio assets never become video clips. Importing audio into a populated timeline creates an audio region. In an empty project it remains a source that can be transcribed/exported independently.

## Audio

| Choice | Output | Work performed |
| --- | --- | --- |
| Original audio / 原音軌（最快） | Codec-compatible M4A, WAV, MP3, FLAC, OGG; MKA for uncommon codecs | Copy the first audio stream without decoding or re-encoding |
| Uncompressed WAV / 無壓縮 WAV | PCM24 WAV | Decode at the source sample rate/channel count |
| Compressed M4A / 壓縮 M4A | AAC at 192 kbit/s | Encode the first source audio stream |

The native Save dialog defaults to the source folder and an unused filename. Existing files, including the original media, are never overwritten. Exports run outside the renderer; audio export can be canceled. Temporary output is removed on failure/cancel, and a successful result offers Show in Folder.

These are **source-audio** exports, not a rendered mix of timeline music, volume edits, trims or speed changes. For media with multiple audio streams, these source exports use its first track. WAV avoids additional lossy encoding but cannot restore sound already absent in the original recording.

Audio import accepts the existing supported audio formats plus MKA. MKA playback depends on its codec; use WAV or M4A when exchanging unusual source formats with other applications. No transcription provider is required for file exchange.

## Subtitles

- Import SRT attaches phrase-timed text to the selected source. Replacing existing text asks for confirmation. Invalid input leaves the project unchanged.
- Source SRT preserves source timestamps and multiline Traditional Chinese for round trips through external transcription tools.
- Timeline SRT derives captions from the current timeline, including edits and speed mapping, for use with the edited video.

SRT imports/exports are local operations. Importing does not contact GMI or AGY, and a late provider response cannot overwrite the imported transcript. SRT has phrase boundaries, not inferred word alignment.

## Transcription methods

The method/settings action opens the existing transcription settings. Local Whisper performs inference on the device; its model may need an initial download. GMI and AGY are cloud routes and require the corresponding upload consent. AGY additionally requires a supported, installed, signed-in CLI on macOS/Linux with the sandboxed JSON print interface. The application does not install AGY or reuse GMI consent for it.

Manual recognition remains available with automatic transcription disabled. Automatic transcription is enabled by default and can be turned off in settings. An optional Traditional Chinese (Taiwan) setting normalizes recognized Chinese across providers; it is off by default and performs script conversion, not proofreading of homophones. Provider speed varies by file, model, hardware and server availability; benchmark claims must include the tested input and whether cold startup is included.
