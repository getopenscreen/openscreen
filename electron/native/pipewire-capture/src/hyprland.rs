//! Pointer positions from Hyprland's IPC, for a portal that cannot report them.
//!
//! WHY THIS EXISTS. xdg-desktop-portal-hyprland offers only the HIDDEN and
//! EMBEDDED cursor modes, never METADATA, so a recording there gets the pointer
//! painted into its pixels and no record of where it was. Without positions the
//! editor has nothing to place a zoom on, and the clicks `input.rs` reads have
//! no location. Hyprland itself knows: its request socket answers `j/cursorpos`
//! with the pointer in global layout coordinates, the space its monitors are
//! placed in.
//!
//! SCOPE. Positions only, polled at the sample cadence, and only for a monitor
//! stream: for a window the portal says nothing about which window the user
//! picked, so there is nothing to subtract. The monitor's place in the layout
//! comes from Hyprland's own `j/monitors` too, not from the portal: its portal
//! reports the stream's size in PHYSICAL pixels, so a scale derived from it was
//! 1 on a scale-2 monitor and put every position at half its real distance
//! from the corner (measured against a take with the pointer painted in).

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::thread;
use std::time::Duration;

use serde::Deserialize;

use crate::Message;

/// A request is one connection: Hyprland answers and closes, so a reply that
/// takes longer than this is a compositor that has stopped answering.
const QUERY_TIMEOUT: Duration = Duration::from_millis(250);

/// The request socket of the Hyprland instance this process runs under, if any.
///
/// `$XDG_RUNTIME_DIR/hypr/<signature>/` since Hyprland 0.40; `/tmp/hypr/` before.
pub fn socket_path() -> Option<PathBuf> {
    let signature = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    runtime
        .into_iter()
        .chain([PathBuf::from("/tmp")])
        .map(|base| base.join("hypr").join(&signature).join(".socket.sock"))
        .find(|path| path.exists())
}

#[derive(Debug, Deserialize)]
struct CursorPos {
    x: f64,
    y: f64,
}

fn request(socket: &PathBuf, command: &str) -> Result<String, String> {
    let mut stream = UnixStream::connect(socket).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(QUERY_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(QUERY_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(command.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut reply = String::new();
    stream
        .read_to_string(&mut reply)
        .map_err(|error| error.to_string())?;
    Ok(reply)
}

/// The pointer in global layout coordinates (logical pixels).
pub fn query_cursor(socket: &PathBuf) -> Result<(f64, f64), String> {
    parse_cursor(&request(socket, "j/cursorpos")?)
}

/// One output as `j/monitors` describes it: its place in the layout (logical),
/// its mode (physical pixels, before rotation) and the scale between the two.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Monitor {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub scale: f64,
    #[serde(default)]
    pub transform: i32,
}

impl Monitor {
    /// The output's size in the layout. A quarter turn (transforms 1, 3, 5, 7)
    /// swaps the mode's sides.
    fn logical_size(&self) -> (i32, i32) {
        let (width, height) = if self.transform % 2 == 1 {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        };
        let scale = if self.scale > 0.0 { self.scale } else { 1.0 };
        (
            (f64::from(width) / scale).round() as i32,
            (f64::from(height) / scale).round() as i32,
        )
    }
}

pub fn query_monitors(socket: &PathBuf) -> Result<Vec<Monitor>, String> {
    let reply = request(socket, "j/monitors")?;
    serde_json::from_str(&reply).map_err(|error| format!("unexpected monitors reply: {error}"))
}

/// The granted monitor's place in the layout: (position, logical size).
///
/// Found by the position the portal reports, which is the layout's; failing a
/// single match there, by its size, which this portal gives in physical pixels
/// (a mode) and others in logical ones. None when neither is unambiguous: a
/// position guessed on the wrong monitor would be worse than none.
fn only<'a>(found: Vec<&'a Monitor>) -> Option<&'a Monitor> {
    (found.len() == 1).then(|| found[0])
}

pub fn granted_monitor(
    monitors: &[Monitor],
    portal_position: Option<(i32, i32)>,
    portal_size: Option<(i32, i32)>,
) -> Option<((i32, i32), (i32, i32))> {
    let monitor = portal_position
        .and_then(|position| only(monitors.iter().filter(|m| (m.x, m.y) == position).collect()))
        .or_else(|| {
            let size = portal_size?;
            only(
                monitors
                    .iter()
                    .filter(|m| {
                        let mode = if m.transform % 2 == 1 {
                            (m.height, m.width)
                        } else {
                            (m.width, m.height)
                        };
                        mode == size || m.logical_size() == size
                    })
                    .collect(),
            )
        })?;
    Some(((monitor.x, monitor.y), monitor.logical_size()))
}

fn parse_cursor(reply: &str) -> Result<(f64, f64), String> {
    let position: CursorPos = serde_json::from_str(reply)
        .map_err(|error| format!("unexpected cursorpos reply {reply:?}: {error}"))?;
    Ok((position.x, position.y))
}

/// Polls the pointer every `interval` and forwards it as
/// [`Message::HostPointer`]. Stops at the first failed query, reporting it as
/// [`Message::HostPointerLost`]: a compositor that stopped answering will not
/// start again within one recording, and retrying would flood the log.
pub fn spawn_poller(sender: Sender<Message>, socket: PathBuf, interval: Duration) {
    thread::spawn(move || loop {
        match query_cursor(&socket) {
            Ok(position) => {
                if sender.send(Message::HostPointer(position)).is_err() {
                    return; // the session is over
                }
            }
            Err(message) => {
                let _ = sender.send(Message::HostPointerLost(message));
                return;
            }
        }
        thread::sleep(interval);
    });
}

/// Where a monitor stream sits in the global layout, from the portal, and its
/// size in stream pixels, from the negotiated format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorPlacement {
    pub position: (i32, i32),
    pub logical_size: (i32, i32),
    pub pixel_size: (i32, i32),
}

/// Maps a global pointer position into the stream's pixels, the space the
/// portal's own cursor metadata uses and `emit_sample` expects. The scale is
/// derived per axis from the two sizes, so a fractional monitor scale needs no
/// separate lookup.
pub fn to_stream_pixels(pointer: (f64, f64), placement: MonitorPlacement) -> Option<(i32, i32)> {
    let (logical_width, logical_height) = placement.logical_size;
    if logical_width <= 0 || logical_height <= 0 {
        return None;
    }
    let scale_x = f64::from(placement.pixel_size.0) / f64::from(logical_width);
    let scale_y = f64::from(placement.pixel_size.1) / f64::from(logical_height);
    let x = (pointer.0 - f64::from(placement.position.0)) * scale_x;
    let y = (pointer.1 - f64::from(placement.position.1)) * scale_y;
    Some((x.round() as i32, y.round() as i32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hyprlands_reply() {
        assert_eq!(
            parse_cursor("{\n    \"x\": 2911,\n    \"y\": 541\n}\n"),
            Ok((2911.0, 541.0))
        );
    }

    #[test]
    fn refuses_a_reply_that_is_not_a_position() {
        assert!(parse_cursor("unknown request").is_err());
    }

    #[test]
    fn maps_a_scaled_monitor_into_its_stream_pixels() {
        // A 3840x2160 monitor at scale 2, placed at the origin: 1920x1080 logical.
        let placement = MonitorPlacement {
            position: (0, 0),
            logical_size: (1920, 1080),
            pixel_size: (3840, 2160),
        };
        assert_eq!(
            to_stream_pixels((1007.0, 551.0), placement),
            Some((2014, 1102))
        );
    }

    #[test]
    fn subtracts_the_monitors_place_in_the_layout() {
        // The second monitor, right of a 1920-wide one, at scale 2.
        let placement = MonitorPlacement {
            position: (1920, 0),
            logical_size: (1536, 960),
            pixel_size: (3072, 1920),
        };
        assert_eq!(
            to_stream_pixels((2911.0, 541.0), placement),
            Some((1982, 1082))
        );
    }

    #[test]
    fn keeps_a_pointer_on_another_monitor_outside_the_stream() {
        // Reported, not clamped: emit_sample marks it invisible.
        let placement = MonitorPlacement {
            position: (1920, 0),
            logical_size: (1536, 960),
            pixel_size: (3072, 1920),
        };
        let (x, _) = to_stream_pixels((100.0, 100.0), placement).unwrap();
        assert!(x < 0);
    }

    #[test]
    fn handles_a_fractional_scale() {
        // 2880x1800 at scale 1.5: 1920x1200 logical.
        let placement = MonitorPlacement {
            position: (0, 0),
            logical_size: (1920, 1200),
            pixel_size: (2880, 1800),
        };
        assert_eq!(
            to_stream_pixels((1000.0, 600.0), placement),
            Some((1500, 900))
        );
    }

    fn monitors() -> Vec<Monitor> {
        // This machine's layout: a 4K monitor at scale 2, a 3072x1920 laptop panel
        // at scale 2 to its right.
        serde_json::from_str(
            r#"[{"name":"HDMI-A-1","x":0,"y":0,"width":3840,"height":2160,"scale":2.0,"transform":0},
                {"name":"eDP-1","x":1920,"y":0,"width":3072,"height":1920,"scale":2.0,"transform":0}]"#,
        )
        .unwrap()
    }

    #[test]
    fn finds_the_granted_monitor_by_its_place_in_the_layout() {
        assert_eq!(
            granted_monitor(&monitors(), Some((1920, 0)), Some((3072, 1920))),
            Some(((1920, 0), (1536, 960)))
        );
    }

    #[test]
    fn takes_the_scale_from_hyprland_not_from_the_portals_physical_size() {
        // The portal reports 3840x2160 for the 4K monitor; the layout is 1920x1080.
        let (position, logical_size) =
            granted_monitor(&monitors(), Some((0, 0)), Some((3840, 2160))).unwrap();
        let placement = MonitorPlacement {
            position,
            logical_size,
            pixel_size: (3840, 2160),
        };
        // Measured: the pointer painted at (3670, 2090) of the frame, Hyprland at (1835, 1045).
        assert_eq!(
            to_stream_pixels((1835.0, 1045.0), placement),
            Some((3670, 2090))
        );
    }

    #[test]
    fn falls_back_to_the_size_when_the_position_matches_nothing() {
        assert_eq!(
            granted_monitor(&monitors(), None, Some((3072, 1920))),
            Some(((1920, 0), (1536, 960)))
        );
        assert_eq!(
            granted_monitor(&monitors(), Some((5, 5)), Some((1536, 960))),
            Some(((1920, 0), (1536, 960)))
        );
    }

    #[test]
    fn gives_up_rather_than_guess_between_two_matching_monitors() {
        let twins: Vec<Monitor> = serde_json::from_str(
            r#"[{"x":0,"y":0,"width":1920,"height":1080,"scale":1.0},
                {"x":1920,"y":0,"width":1920,"height":1080,"scale":1.0}]"#,
        )
        .unwrap();
        assert_eq!(granted_monitor(&twins, None, Some((1920, 1080))), None);
        assert_eq!(
            granted_monitor(&twins, Some((1920, 0)), Some((1920, 1080))),
            Some(((1920, 0), (1920, 1080)))
        );
    }

    #[test]
    fn swaps_the_sides_of_a_rotated_monitor() {
        let rotated: Vec<Monitor> = serde_json::from_str(
            r#"[{"x":0,"y":0,"width":2560,"height":1440,"scale":1.0,"transform":1}]"#,
        )
        .unwrap();
        assert_eq!(
            granted_monitor(&rotated, Some((0, 0)), None),
            Some(((0, 0), (1440, 2560)))
        );
    }

    #[test]
    fn refuses_an_empty_logical_size() {
        let placement = MonitorPlacement {
            position: (0, 0),
            logical_size: (0, 0),
            pixel_size: (3840, 2160),
        };
        assert_eq!(to_stream_pixels((10.0, 10.0), placement), None);
    }
}
