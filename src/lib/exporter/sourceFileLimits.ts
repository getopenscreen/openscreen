/**
 * Largest source file we are willing to read fully into memory in one shot.
 *
 * Node's `fs.readFile` (behind the `read-binary-file` IPC) throws
 * `ERR_FS_FILE_TOO_LARGE` above 2 GiB, and a multi-GB `ArrayBuffer`/`Blob` would
 * exhaust memory on typical machines anyway. Recordings above this threshold are
 * streamed on demand instead (into OPFS for demuxing; skipped for the in-memory
 * source-copy and waveform/decodeAudioData paths).
 *
 * Kept comfortably below the 2 GiB cap to leave headroom.
 */
export const MAX_IN_MEMORY_SOURCE_BYTES = 1.5 * 1024 * 1024 * 1024;
