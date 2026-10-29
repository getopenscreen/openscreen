//! Direct X11 capture for desktops without a ScreenCast portal (e.g. Xfce).
//! Pixels, cursor sprites and mouse buttons all come from the selected X
//! server. This is never a fallback on Wayland or an XWayland DISPLAY: those
//! sessions keep the portal's source selection and permission boundary.

use std::collections::HashSet;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde::Deserialize;
use x11rb::connection::Connection;
use x11rb::protocol::composite::{ConnectionExt as _, Redirect};
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xfixes::{ConnectionExt as _, GetCursorImageReply};
use x11rb::protocol::xinput::{ConnectionExt as _, Device, EventMask, XIEventMask};
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder, MapState};
use x11rb::protocol::Event as XEvent;
use x11rb::rust_connection::RustConnection;

use crate::capture::Capture;
use crate::events::{timestamp_ms, CursorAsset, Emitter, Event};
use crate::{bitmap, encoder, shim, Message, Request};

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Source {
    Display {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    },
    Window {
        window_id: u32,
    },
}

pub fn is_x11_session() -> bool {
    uses_x11(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("DISPLAY").ok().as_deref(),
    )
}

fn uses_x11(session: Option<&str>, wayland: Option<&str>, display: Option<&str>) -> bool {
    // An XWayland DISPLAY must never turn a Wayland portal failure into an
    // unrestricted X11 capture of a different/empty desktop.
    if session == Some("wayland") || wayland.is_some_and(|value| !value.is_empty()) {
        return false;
    }
    display.is_some_and(|value| !value.is_empty())
        && (session == Some("x11") || session.is_none_or(str::is_empty))
}

/// A server-created MIT-SHM segment, mapped read-only: `ShmGetImage` writes
/// each frame into it instead of streaming it over the X socket (~250 MB/s at
/// 1080p30, ~1 GB/s at 4K).
struct Shm {
    seg: u32,
    ptr: *const u8,
    len: usize,
}

impl Shm {
    /// `None` when the server cannot share memory with us (a remote DISPLAY,
    /// SHM < 1.2): frames then come through plain `GetImage`.
    fn open(connection: &RustConnection, len: usize) -> Option<Self> {
        let version = connection.shm_query_version().ok()?.reply().ok()?;
        if (version.major_version, version.minor_version) < (1, 2) {
            return None;
        }
        let seg = connection.generate_id().ok()?;
        let reply = connection
            .shm_create_segment(seg, u32::try_from(len).ok()?, false)
            .ok()?
            .reply()
            .ok()?;
        // SAFETY: maps, read-only, the `len` bytes of the segment the server
        // just created for us. The mapping outlives the fd, closed on drop.
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ,
                libc::MAP_SHARED,
                reply.shm_fd.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            let _ = connection.shm_detach(seg);
            return None;
        }
        Some(Self {
            seg,
            ptr: ptr.cast(),
            len,
        })
    }
}

impl Drop for Shm {
    fn drop(&mut self) {
        // SAFETY: unmaps exactly the mapping made in `open`.
        unsafe { libc::munmap(self.ptr as *mut _, self.len) };
    }
}

struct Desktop {
    connection: RustConnection,
    root: u32,
    root_size: (u16, u16),
    source: Source,
    width: u16,
    height: u16,
    shm: Option<Shm>,
    /// A window source whose own contents XComposite keeps off screen, so
    /// overlapping windows never reach the frame. Without it, the root.
    composite: bool,
}

impl Desktop {
    fn open(source: Option<Source>, recording: bool) -> Result<Self, String> {
        let (connection, screen_index) = x11rb::connect(None).map_err(|e| e.to_string())?;
        let screen = &connection.setup().roots[screen_index];
        let root = screen.root;
        let root_size = (screen.width_in_pixels, screen.height_in_pixels);
        let source = match source {
            Some(source) => source,
            None if !recording => Source::Display {
                x: 0,
                y: 0,
                width: root_size.0.into(),
                height: root_size.1.into(),
            },
            None => return Err("X11 recording requires a selected display or window".into()),
        };
        connection
            .xfixes_query_version(4, 0)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        connection
            .xinput_xi_query_version(2, 0)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        // Mouse buttons only. No keyboard devices, keycodes or typed text.
        connection
            .xinput_xi_select_events(
                root,
                &[EventMask {
                    deviceid: Device::ALL_MASTER.into(),
                    mask: vec![XIEventMask::RAW_BUTTON_PRESS | XIEventMask::RAW_BUTTON_RELEASE],
                }],
            )
            .map_err(|e| e.to_string())?
            .check()
            .map_err(|e| e.to_string())?;
        let mut composite = false;
        let (width, height) = match &source {
            Source::Display {
                x,
                y,
                width,
                height,
            } => {
                validate_display(*x, *y, *width, *height, root_size)?;
                (*width as u16, *height as u16)
            }
            Source::Window { window_id } => {
                let geometry = connection
                    .get_geometry(*window_id)
                    .map_err(|e| e.to_string())?
                    .reply()
                    .map_err(|e| e.to_string())?;
                composite = redirect(&connection, *window_id, geometry.depth);
                (geometry.width, geometry.height)
            }
        };
        // The existing encoder consumes packed BGRX. Refuse unusual visuals
        // explicitly rather than silently interpreting their pixels as BGRX.
        let format = connection
            .setup()
            .pixmap_formats
            .iter()
            .find(|f| f.depth == screen.root_depth);
        let visual = screen
            .allowed_depths
            .iter()
            .flat_map(|depth| &depth.visuals)
            .find(|visual| visual.visual_id == screen.root_visual);
        if connection.setup().image_byte_order != ImageOrder::LSB_FIRST
            || !format.is_some_and(|f| f.bits_per_pixel == 32 && f.scanline_pad == 32)
            || !visual.is_some_and(|v| {
                v.red_mask == 0xff0000 && v.green_mask == 0xff00 && v.blue_mask == 0xff
            })
        {
            return Err("X11 capture requires a little-endian 32-bit TrueColor visual".into());
        }
        // H.264 4:2:0 needs even dimensions. Trim at most the last row/column,
        // never widen the capture into pixels outside the selected source.
        let (width, height) = (width & !1, height & !1);
        if width < 2 || height < 2 {
            return Err("The selected X11 source is too small to record".into());
        }
        let shm = Shm::open(&connection, usize::from(width) * usize::from(height) * 4);
        Ok(Self {
            connection,
            root,
            root_size,
            source,
            width,
            height,
            shm,
            composite,
        })
    }

    fn kind(&self) -> String {
        match self.source {
            Source::Display { .. } => "monitor",
            Source::Window { .. } => "window",
        }
        .into()
    }

    fn origin(&self) -> Result<(i32, i32), String> {
        match self.source {
            Source::Display { x, y, .. } => Ok((x, y)),
            Source::Window { window_id } => {
                let attributes = self
                    .connection
                    .get_window_attributes(window_id)
                    .map_err(|e| e.to_string())?
                    .reply()
                    .map_err(|e| e.to_string())?;
                if attributes.map_state != MapState::VIEWABLE {
                    return Err("The selected X11 window is no longer viewable".into());
                }
                let geometry = self
                    .connection
                    .get_geometry(window_id)
                    .map_err(|e| e.to_string())?
                    .reply()
                    .map_err(|e| e.to_string())?;
                if geometry.width & !1 != self.width || geometry.height & !1 != self.height {
                    return Err(
                        "The selected X11 window changed size; start a new recording".into(),
                    );
                }
                let position = self
                    .connection
                    .translate_coordinates(window_id, self.root, 0, 0)
                    .map_err(|e| e.to_string())?
                    .reply()
                    .map_err(|e| e.to_string())?;
                Ok((position.dst_x.into(), position.dst_y.into()))
            }
        }
    }

    /// A composited window's own pixmap, whole even when covered or off
    /// screen. Otherwise the root over the source's rectangle, clipped to the
    /// screen: a window drawable raises BadMatch once the window crosses the
    /// screen edge and is undefined where it is covered. Whatever lies off
    /// screen stays black, so the frame keeps its size.
    fn frame(&self, origin: (i32, i32)) -> Result<shim::Frame, String> {
        let stride = usize::from(self.width) * 4;
        let mut pixels = vec![0; stride * usize::from(self.height)];
        let mut pixmap = None;
        let region = match self.source {
            Source::Window { window_id } if self.composite => {
                // Named per frame: a window that is unmapped or resized gets
                // a new pixmap, and the old name would keep stale contents.
                let id = self.connection.generate_id().map_err(|e| e.to_string())?;
                self.connection
                    .composite_name_window_pixmap(window_id, id)
                    .map_err(|e| e.to_string())?
                    .check()
                    .map_err(|e| e.to_string())?;
                pixmap = Some(id);
                Some((id, (0, 0, self.width, self.height), (0, 0)))
            }
            _ => clip(origin, (self.width, self.height), self.root_size)
                .map(|rect| (self.root, rect, origin)),
        };
        let read = (|| -> Result<(), String> {
            let Some((drawable, (x, y, width, height), origin)) = region else {
                return Ok(());
            };
            let row = usize::from(width) * 4;
            let len = row * usize::from(height);
            let fallback;
            let rows = match &self.shm {
                Some(shm) => {
                    self.connection
                        .shm_get_image(
                            drawable,
                            x,
                            y,
                            width,
                            height,
                            u32::MAX,
                            ImageFormat::Z_PIXMAP.into(),
                            shm.seg,
                            0,
                        )
                        .map_err(|e| e.to_string())?
                        .reply()
                        .map_err(|e| e.to_string())?;
                    // SAFETY: the reply is in, so the server has finished
                    // writing; `len` never exceeds the segment (the source size).
                    unsafe { std::slice::from_raw_parts(shm.ptr, len) }
                }
                None => {
                    fallback = self
                        .connection
                        .get_image(ImageFormat::Z_PIXMAP, drawable, x, y, width, height, u32::MAX)
                        .map_err(|e| e.to_string())?
                        .reply()
                        .map_err(|e| e.to_string())?
                        .data;
                    if fallback.len() != len {
                        return Err("X11 returned an unexpected image stride".into());
                    }
                    &fallback[..]
                }
            };
            let dx = (i32::from(x) - origin.0) as usize * 4;
            let dy = (i32::from(y) - origin.1) as usize;
            for (line, source) in rows.chunks_exact(row).enumerate() {
                let start = (dy + line) * stride + dx;
                pixels[start..start + row].copy_from_slice(source);
            }
            Ok(())
        })();
        if let Some(id) = pixmap {
            let _ = self.connection.free_pixmap(id);
        }
        read?;
        Ok(shim::Frame {
            pixels,
            stride,
            width: self.width.into(),
            height: self.height.into(),
            video_format: shim::constants().video_format_bgrx,
            crop: shim::CropRect {
                x: 0,
                y: 0,
                width: self.width.into(),
                height: self.height.into(),
            },
            ..Default::default()
        })
    }
}

/// Asks the server to keep the window's contents in an off-screen pixmap.
/// Automatic redirection changes nothing on screen and ends with our
/// connection. `false` (read the root instead) without XComposite 0.2 or for
/// a window whose pixels are not 32-bit.
fn redirect(connection: &RustConnection, window: u32, depth: u8) -> bool {
    let packed = connection
        .setup()
        .pixmap_formats
        .iter()
        .any(|f| f.depth == depth && f.bits_per_pixel == 32 && f.scanline_pad == 32);
    packed
        && connection
            .composite_query_version(0, 2)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some_and(|v| (v.major_version, v.minor_version) >= (0, 2))
        && connection
            .composite_redirect_window(window, Redirect::AUTOMATIC)
            .ok()
            .and_then(|cookie| cookie.check().ok())
            .is_some()
}

/// The part of a `size` rectangle at `origin` that lies on a `root`-sized
/// screen, in root coordinates; `None` when none of it does.
fn clip(origin: (i32, i32), size: (u16, u16), root: (u16, u16)) -> Option<(i16, i16, u16, u16)> {
    let (left, top) = (origin.0.max(0), origin.1.max(0));
    let right = (origin.0 + i32::from(size.0)).min(i32::from(root.0));
    let bottom = (origin.1 + i32::from(size.1)).min(i32::from(root.1));
    (right > left && bottom > top).then(|| {
        (
            left as i16,
            top as i16,
            (right - left) as u16,
            (bottom - top) as u16,
        )
    })
}

fn validate_display(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    root: (u16, u16),
) -> Result<(), String> {
    if x < 0
        || y < 0
        || width < 2
        || height < 2
        || i64::from(x) + i64::from(width) > i64::from(root.0)
        || i64::from(y) + i64::from(height) > i64::from(root.1)
        || x > i16::MAX.into()
        || y > i16::MAX.into()
    {
        return Err("The selected X11 display is outside the root window".into());
    }
    Ok(())
}

fn cursor_asset(cursor: &GetCursorImageReply) -> Result<CursorAsset, String> {
    let bitmap = shim::CursorBitmap {
        format: shim::constants().video_format_bgra,
        width: cursor.width.into(),
        height: cursor.height.into(),
        stride: i32::from(cursor.width) * 4,
        pixels: cursor
            .cursor_image
            .iter()
            .flat_map(|pixel| pixel.to_le_bytes())
            .collect(),
    };
    let encoded = bitmap::encode(&shim::constants(), &bitmap)?;
    Ok(CursorAsset {
        id: encoded.id,
        image_data_url: encoded.image_data_url,
        width: encoded.width,
        height: encoded.height,
        hotspot_x: cursor.xhot.into(),
        hotspot_y: cursor.yhot.into(),
    })
}

fn paint_cursor(frame: &mut shim::Frame, cursor: &GetCursorImageReply, origin: (i32, i32)) {
    let left = i32::from(cursor.x) - i32::from(cursor.xhot) - origin.0;
    let top = i32::from(cursor.y) - i32::from(cursor.yhot) - origin.1;
    for y in 0..i32::from(cursor.height) {
        for x in 0..i32::from(cursor.width) {
            let (dx, dy) = (left + x, top + y);
            if dx < 0 || dy < 0 || dx >= frame.width || dy >= frame.height {
                continue;
            }
            let argb = cursor.cursor_image[(y * i32::from(cursor.width) + x) as usize];
            let alpha = argb >> 24;
            let offset = dy as usize * frame.stride + dx as usize * 4;
            for channel in 0..3 {
                let source = (argb >> (channel * 8)) & 255;
                let dest = u32::from(frame.pixels[offset + channel]);
                frame.pixels[offset + channel] =
                    (source + (dest * (255 - alpha) + 127) / 255).min(255) as u8;
            }
        }
    }
}

pub fn run<W: Write>(request: &Request, emitter: &mut Emitter<W>) -> Result<(), String> {
    let desktop = Desktop::open(request.source.clone(), request.output_path.is_some())?;
    let cursor_mode = request.cursor_mode()?;
    let mut emit = |event: &Event| emitter.emit(event).map_err(|e| e.to_string());
    emit(&Event::Ready {
        timestamp_ms: timestamp_ms(),
        pipewire_version: None,
        cursor_metadata_supported: true,
        cursor_mode: cursor_mode.as_str(),
        backend: "x11",
    })?;
    if request.probe_only {
        return Ok(());
    }
    let origin = desktop.origin()?;
    emit(&Event::SourceSelected {
        timestamp_ms: timestamp_ms(),
        node_id: 0,
        source_kind: Some(desktop.kind()),
        position_x: Some(origin.0),
        position_y: Some(origin.1),
    })?;
    emit(&Event::StreamStarted {
        timestamp_ms: timestamp_ms(),
        node_id: 0,
        width: desktop.width.into(),
        height: desktop.height.into(),
        position_x: Some(origin.0),
        position_y: Some(origin.1),
        source_kind: Some(desktop.kind()),
    })?;
    let (sender, receiver) = mpsc::channel();
    crate::spawn_stdin_reader(sender);
    if request.defer_start {
        loop {
            match receiver.recv() {
                Ok(Message::Record) => break,
                Ok(Message::Stop) | Err(_) => return Ok(()),
                _ => {}
            }
        }
    }
    // Clicks made before the take (the countdown) belong to no frame of it.
    while desktop
        .connection
        .poll_for_event()
        .map_err(|e| e.to_string())?
        .is_some()
    {}
    let mut audio_configs = request.audio_sources();
    // Without PipeWire the take loses its audio, not its video.
    if !audio_configs.is_empty() {
        if let Err(message) = shim::load() {
            emit(&Event::Warning {
                code: "audio-unavailable".to_owned(),
                message: format!(
                    "PipeWire could not be loaded, so the recording has no audio track: {message}"
                ),
            })?;
            audio_configs.clear();
        }
    }
    let (_audio_sessions, audio_sources) = crate::start_audio(emitter, &audio_configs);
    let mut capture = if let Some(path) = request.output_path.as_deref() {
        let (capture, selection) = Capture::start(
            std::path::Path::new(path),
            desktop.width.into(),
            desktop.height.into(),
            request.fps(),
            request.bitrate(),
            encoder::forced_backend_from_env()?,
            audio_sources,
            None,
        )?;
        emitter
            .emit(&Event::EncoderSelection {
                video: selection.backend.as_str().into(),
                rejected: selection.rejected,
            })
            .map_err(|e| e.to_string())?;
        Some(capture)
    } else {
        None
    };
    let interval = Duration::from_micros(1_000_000 / request.fps() as u64);
    let sample_interval = Duration::from_millis(
        request
            .sample_interval_ms
            .unwrap_or(crate::DEFAULT_SAMPLE_INTERVAL_MS)
            .max(crate::MIN_SAMPLE_INTERVAL_MS),
    );
    let mut next_frame = Instant::now();
    let mut last_sample = Instant::now() - sample_interval;
    let mut last_serial = None;
    let mut asset: Option<CursorAsset> = None;
    let mut emitted_assets = HashSet::new();
    let mut paused = false;
    let mut started = false;
    let result = (|| -> Result<(), String> {
        loop {
            let mut interactions = Vec::new();
            while let Some(event) = desktop
                .connection
                .poll_for_event()
                .map_err(|e| e.to_string())?
            {
                match event {
                    XEvent::XinputRawButtonPress(e) if e.detail == 1 => interactions.push("click"),
                    XEvent::XinputRawButtonRelease(e) if e.detail == 1 => {
                        interactions.push("mouseup")
                    }
                    _ => {}
                }
            }
            if !paused {
                let origin = desktop.origin()?;
                let cursor = desktop
                    .connection
                    .xfixes_get_cursor_image()
                    .map_err(|e| e.to_string())?
                    .reply()
                    .map_err(|e| e.to_string())?;
                if cursor_mode.reports_cursor() && last_serial != Some(cursor.cursor_serial) {
                    asset = Some(cursor_asset(&cursor)?);
                    last_serial = Some(cursor.cursor_serial);
                }
                if let Some(capture) = capture.as_mut() {
                    let mut frame = desktop.frame(origin)?;
                    if cursor_mode == crate::portal::CursorMode::Embedded {
                        paint_cursor(&mut frame, &cursor, origin);
                    }
                    capture.stage(&frame)?;
                    capture.advance()?;
                    if !started {
                        emitter
                            .emit(&Event::CaptureStarted {
                                timestamp_ms: timestamp_ms(),
                                path: request.output_path.clone().unwrap_or_default(),
                                width: desktop.width.into(),
                                height: desktop.height.into(),
                                fps: request.fps(),
                            })
                            .map_err(|e| e.to_string())?;
                        started = true;
                    }
                }
                if cursor_mode.reports_cursor()
                    && (last_sample.elapsed() >= sample_interval || !interactions.is_empty())
                {
                    if interactions.is_empty() {
                        interactions.push("move");
                    }
                    let (x, y) = (
                        i32::from(cursor.x) - origin.0,
                        i32::from(cursor.y) - origin.1,
                    );
                    for interaction in interactions {
                        let new_asset = asset
                            .as_ref()
                            .filter(|a| emitted_assets.insert(a.id.clone()))
                            .cloned();
                        emitter
                            .emit(&Event::CursorSample {
                                timestamp_ms: timestamp_ms(),
                                x,
                                y,
                                width: desktop.width.into(),
                                height: desktop.height.into(),
                                visible: x >= 0
                                    && y >= 0
                                    && x < i32::from(desktop.width)
                                    && y < i32::from(desktop.height),
                                asset_id: asset.as_ref().map(|a| a.id.clone()),
                                asset: new_asset,
                                interaction_type: Some(interaction.into()),
                            })
                            .map_err(|e| e.to_string())?;
                    }
                    last_sample = Instant::now();
                }
            }
            next_frame += interval;
            let wait = next_frame.saturating_duration_since(Instant::now());
            match receiver.recv_timeout(wait) {
                Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(Message::Pause) => {
                    paused = true;
                    if let Some(c) = capture.as_mut() {
                        c.pause();
                    }
                }
                Ok(Message::Resume) => {
                    paused = false;
                    if let Some(c) = capture.as_mut() {
                        c.resume();
                    }
                }
                _ => {}
            }
            // Do not build a backlog of frame requests if encoding is slower
            // than the selected rate. Capture retains wall-clock timestamps.
            if next_frame < Instant::now() - interval {
                next_frame = Instant::now();
            }
        }
        Ok(())
    })();
    let mut exit_code = 0;
    if let Some(capture) = capture {
        crate::finish_capture(emitter, capture, None, &mut exit_code);
    }
    result?;
    if exit_code != 0 {
        return Err("Could not finalize the X11 recording".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_never_falls_back_to_xwayland() {
        assert!(!uses_x11(Some("wayland"), Some("wayland-0"), Some(":0")));
        assert!(!uses_x11(Some("x11"), Some("wayland-0"), Some(":0")));
        assert!(uses_x11(Some("x11"), None, Some(":0")));
        assert!(uses_x11(None, None, Some(":0")));
        assert!(!uses_x11(None, None, None));
    }

    #[test]
    fn display_bounds_must_be_inside_the_x11_root() {
        assert!(validate_display(1920, 0, 1920, 1080, (3840, 1080)).is_ok());
        assert!(validate_display(1920, 0, 1921, 1080, (3840, 1080)).is_err());
        assert!(validate_display(-1, 0, 1920, 1080, (3840, 1080)).is_err());
        assert!(validate_display(0, 0, u32::MAX, 1080, (3840, 1080)).is_err());
    }

    #[test]
    fn capture_is_clipped_to_the_screen() {
        let root = (1920, 1080);
        assert_eq!(clip((0, 0), (1920, 1080), root), Some((0, 0, 1920, 1080)));
        assert_eq!(clip((-100, 50), (400, 300), root), Some((0, 50, 300, 300)));
        assert_eq!(clip((1800, 1000), (400, 300), root), Some((1800, 1000, 120, 80)));
        assert_eq!(clip((1920, 0), (400, 300), root), None);
        assert_eq!(clip((-400, -300), (400, 300), root), None);
    }

    #[test]
    fn embedded_cursor_blends_premultiplied_channels() {
        let mut frame = shim::Frame {
            pixels: vec![20, 40, 60, 255],
            width: 1,
            height: 1,
            stride: 4,
            ..Default::default()
        };
        let cursor = GetCursorImageReply {
            width: 1,
            height: 1,
            cursor_image: vec![0x80800000],
            ..Default::default()
        };
        paint_cursor(&mut frame, &cursor, (0, 0));
        assert_eq!(frame.pixels, [10, 20, 158, 255]);
    }

    #[test]
    fn cursor_hotspot_is_clipped_at_the_source_edge() {
        let mut frame = shim::Frame {
            pixels: vec![20, 40, 60, 255],
            width: 1,
            height: 1,
            stride: 4,
            ..Default::default()
        };
        let cursor = GetCursorImageReply {
            width: 2,
            height: 1,
            xhot: 1,
            cursor_image: vec![0xff00ff00, 0xff0000ff],
            ..Default::default()
        };
        paint_cursor(&mut frame, &cursor, (0, 0));
        assert_eq!(frame.pixels, [255, 0, 0, 255]);
    }
}
