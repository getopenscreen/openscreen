//! xdg-desktop-portal ScreenCast negotiation.
//!
//! The five-call dance is CreateSession → SelectSources → Start →
//! OpenPipeWireRemote, each async call answering on a Request object's Response
//! signal. ashpd subscribes to that signal before issuing the call, which is
//! the part that is easy to get wrong by hand (subscribe after, and the reply
//! can land before the match rule exists).
//!
//! Two properties of the protocol shape this module:
//!
//!   * SelectSources may be called ONCE per session. A second call fails with
//!     `Sources already selected`. Everything — cursor mode, source types,
//!     persistence — has to be decided before the first call.
//!   * Start is what raises the compositor's source picker. It does not return
//!     until a human has clicked, so nothing downstream may hold a timeout.
//!
//! ashpd is used rather than raw zbus because it is pure Rust (no libdbus-1-dev)
//! and because its `pipewire` feature — which would drag in pipewire-rs and
//! therefore libpipewire-0.3-dev — is deliberately left off; the PipeWire half
//! lives in csrc/pw_shim.c instead.

use std::os::fd::OwnedFd;

use ashpd::desktop::screencast::{CursorMode as PortalCursorMode, Screencast, SourceType};
use ashpd::desktop::PersistMode;
use ashpd::enumflags2::BitFlags;
use ashpd::WindowIdentifier;

/// Which of the portal's three cursor modes to ask for.
///
/// This is the HUD's cursor-mode toggle, one layer down. `Metadata` is what
/// makes the editable cursor possible at all — the compositor keeps the pointer
/// out of the pixels and describes it separately — and `Embedded` is the
/// "system cursor" setting, where the compositor paints it in and the editor
/// leaves it alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorMode {
    Metadata,
    Embedded,
    Hidden,
}

impl CursorMode {
    fn to_portal(self) -> PortalCursorMode {
        match self {
            Self::Metadata => PortalCursorMode::Metadata,
            Self::Embedded => PortalCursorMode::Embedded,
            Self::Hidden => PortalCursorMode::Hidden,
        }
    }

    /// Only METADATA yields cursor samples; in the other modes the pointer is
    /// either painted into the frames or absent, and there is no metadata to
    /// read either way.
    pub fn reports_cursor(self) -> bool {
        matches!(self, Self::Metadata)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Metadata => "metadata",
            Self::Embedded => "embedded",
            Self::Hidden => "hidden",
        }
    }

    /// The mode to actually negotiate, given what the portal offers.
    ///
    /// Some portals offer no EMBEDDED at all (niri's, #1357). Refusing to record
    /// there leaves the user nothing, so EMBEDDED falls back to METADATA: the
    /// pointer stays out of the pixels and the editor draws it from the samples
    /// instead.
    ///
    /// Others offer no METADATA (xdg-desktop-portal-hyprland offers only HIDDEN
    /// and EMBEDDED). The same reasoning runs the other way for a session that
    /// writes video: METADATA falls back to EMBEDDED, and the recording gets the
    /// system cursor painted in rather than no recording at all. A cursor-only
    /// session (`records_video` false) has no frames to paint into, so it keeps
    /// METADATA and is refused. Any other miss is returned unchanged, for the
    /// negotiation to refuse with its own error.
    ///
    /// Before that last fallback, METADATA goes to HIDDEN when the compositor reports
    /// the pointer itself (`host_reports_pointer`, Hyprland's IPC): the pointer stays
    /// out of the pixels and the samples come from there, so the editor still draws
    /// it, the editable cursor the user asked for. Only for a recording, which has
    /// pixels to keep it out of.
    pub fn resolve(
        self,
        offered: &[CursorMode],
        records_video: bool,
        host_reports_pointer: bool,
    ) -> CursorMode {
        if self == Self::Metadata
            && records_video
            && host_reports_pointer
            && !offered.contains(&Self::Metadata)
            && offered.contains(&Self::Hidden)
        {
            return Self::Hidden;
        }
        if self == Self::Embedded
            && !offered.contains(&Self::Embedded)
            && offered.contains(&Self::Metadata)
        {
            return Self::Metadata;
        }
        if self == Self::Metadata
            && records_video
            && !offered.contains(&Self::Metadata)
            && offered.contains(&Self::Embedded)
        {
            return Self::Embedded;
        }
        self
    }
}

/// Which kind of source the compositor actually handed over.
///
/// This is the ONLY way the app can learn whether it got a window or a whole
/// monitor. `SelectSources` has no parameter naming a source, so a request can
/// never be compared against its grant — the reply is the first and last word.
/// Reported upward so the HUD can name what is really being recorded instead of
/// echoing a choice made in a modal that never reached this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Monitor,
    Window,
    Virtual,
}

impl SourceKind {
    fn from_portal(source_type: SourceType) -> Self {
        match source_type {
            SourceType::Monitor => Self::Monitor,
            SourceType::Window => Self::Window,
            SourceType::Virtual => Self::Virtual,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Monitor => "monitor",
            Self::Window => "window",
            Self::Virtual => "virtual",
        }
    }
}

/// Everything the PipeWire half needs, plus what the helper reports upward.
pub struct PortalStream {
    pub fd: OwnedFd,
    /// An independently opened remote for a one-time shared-memory retry.
    pub fallback_fd: Option<OwnedFd>,
    pub node_id: u32,
    pub position: Option<(i32, i32)>,
    pub size: Option<(i32, i32)>,
    /// `None` when the portal omits it — older backends do, and the spec makes
    /// it optional. Absent means "unknown", never "monitor".
    pub source_kind: Option<SourceKind>,
    /// Replays this grant without the picker. Only Restart may use it — see
    /// `negotiate`.
    pub restore_token: Option<String>,
}

#[derive(Debug)]
pub enum PortalError {
    /// The compositor's portal does not offer METADATA cursor mode, and the
    /// session cannot fall back to EMBEDDED: it records no video to paint the
    /// pointer into, or the portal offers no EMBEDDED either (see
    /// `CursorMode::resolve`).
    CursorMetadataUnsupported,
    /// The user dismissed the picker, or the portal refused.
    Cancelled,
    Failed(String),
}

impl PortalError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::CursorMetadataUnsupported => "cursor-metadata-unsupported",
            Self::Cancelled => "portal-cancelled",
            Self::Failed(_) => "portal-failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::CursorMetadataUnsupported => {
                "The ScreenCast portal does not advertise METADATA cursor mode, so real cursor \
                 positions cannot be obtained on this session."
                    .to_owned()
            }
            Self::Cancelled => "The screen capture request was cancelled.".to_owned(),
            Self::Failed(message) => message.clone(),
        }
    }
}

fn failed(context: &str, error: impl std::fmt::Display) -> PortalError {
    PortalError::Failed(format!("{context}: {error}"))
}

/// `Screencast::new()` fails when nothing answers on the ScreenCast D-Bus
/// interface. That is almost never a fault in the session: it is a machine with
/// no portal BACKEND installed — invisible on any desktop that ships one, which
/// every distro's desktop metapackage does, and the norm on a minimal install or
/// a hand-assembled compositor.
///
/// This message is not a log line. `message()` is what the helper emits on
/// `portal-failed`, what `handlers.ts` turns into the IPC error, and what the
/// recorder finally shows in a toast — so the raw zbus text ("A portal frontend
/// implementing org.freedesktop.portal.ScreenCast was not found") reached the
/// user verbatim and read as an internal fault to the one person able to fix it.
/// Name the package instead, the way `d3d_linux::diagnose` names Mesa.
///
/// The list has to be a list. `xdg-desktop-portal` on its own only dispatches;
/// which backend implements ScreenCast depends on the desktop, so naming the
/// frontend alone would send someone to install the package they already have.
fn portal_unavailable(error: impl std::fmt::Display) -> PortalError {
    PortalError::Failed(format!(
        "no ScreenCast portal is available on this session ({error}). Screen capture on Linux \
         goes through xdg-desktop-portal, which needs the backend matching your desktop: \
         xdg-desktop-portal-gnome (GNOME), xdg-desktop-portal-kde (KDE Plasma), \
         xdg-desktop-portal-hyprland (Hyprland), xdg-desktop-portal-wlr (Sway and other wlroots \
         compositors), or xdg-desktop-portal-gtk (anything else). Install one, then log out and \
         back in."
    ))
}

/// Cheap, non-interactive probe: which cursor modes does this portal offer?
///
/// Split out from [`negotiate`] so the helper can answer that question — and
/// emit `ready` — before anything raises a dialog.
pub async fn offered_cursor_modes() -> Result<Vec<CursorMode>, PortalError> {
    let proxy = Screencast::new().await.map_err(portal_unavailable)?;
    let cursor_modes = proxy
        .available_cursor_modes()
        .await
        .map_err(|error| failed("AvailableCursorModes", error))?;
    Ok([CursorMode::Metadata, CursorMode::Embedded, CursorMode::Hidden]
        .into_iter()
        .filter(|mode| cursor_modes.contains(mode.to_portal()))
        .collect())
}

/// Runs the negotiation to completion. Blocks on the user for as long as the
/// picker is up: `Start()` is what raises it.
///
/// The returned `PortalStream` outlives the ashpd `Session` object on purpose.
/// ashpd has no `Drop` impl for sessions and holds its D-Bus connection in a
/// process-global `OnceLock`, so the portal session stays open until this
/// process exits — which is exactly the lifetime we want.
pub async fn negotiate(
    cursor_mode: CursorMode,
    monitors_only: bool,
    restore_token: Option<&str>,
) -> Result<PortalStream, PortalError> {
    let proxy = Screencast::new().await.map_err(portal_unavailable)?;

    let cursor_modes = proxy
        .available_cursor_modes()
        .await
        .map_err(|error| failed("AvailableCursorModes", error))?;
    // Only METADATA is treated as mandatory, and only when it was asked for.
    // EMBEDDED is in the portal spec's baseline and every compositor implements
    // it; refusing to start because a mode we are not using is missing would be
    // the Stage 1 check applied where it no longer belongs.
    if !cursor_modes.contains(cursor_mode.to_portal()) {
        return Err(match cursor_mode {
            CursorMode::Metadata => PortalError::CursorMetadataUnsupported,
            other => PortalError::Failed(format!(
                "the ScreenCast portal does not offer the {other:?} cursor mode"
            )),
        });
    }

    let session = proxy
        .create_session()
        .await
        .map_err(|error| failed("CreateSession", error))?;

    // Monitors and windows both; the picker decides which. Virtual sources are
    // excluded — a virtual monitor has no cursor to report. Monitors only when the
    // pointer's positions come from the compositor (`monitors_only`): they can be
    // placed in a monitor, never in a window the portal does not name, and a window
    // recorded without the pointer in its pixels would have no cursor at all.
    let types: BitFlags<SourceType> = if monitors_only {
        SourceType::Monitor.into()
    } else {
        SourceType::Monitor | SourceType::Window
    };
    proxy
        .select_sources(
            &session,
            cursor_mode.to_portal(),
            types,
            false,
            // A TOKEN ONLY EVER REPLAYS THE SOURCE IT WAS MINTED FOR, which is
            // why a fresh recording never gets one: a token replayed on every
            // run used to turn "record this window" into a recording of the
            // whole screen, because the picker — the only source chooser
            // Wayland has — never came back. Restart is the one caller that
            // wants exactly that: the same source again, and no second picker.
            // That picker is not just a nuisance there. On Hyprland it opens
            // while the portal is still closing the discarded take's session,
            // that close stalls for its full 25 s timeout, and the picker waits
            // behind it — so the take is deleted and nothing appears.
            //
            // Persistent because a transient grant belongs to the process that
            // asked for it, and every take is a new helper. The caller keeps
            // the token in memory and hands it back once, for one Restart.
            restore_token,
            PersistMode::ExplicitlyRevoked,
        )
        .await
        .map_err(|error| failed("SelectSources", error))?
        .response()
        .map_err(|error| failed("SelectSources response", error))?;

    let streams = proxy
        .start(&session, &WindowIdentifier::default())
        .await
        .map_err(|error| failed("Start", error))?
        .response()
        .map_err(|error| match error {
            ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => {
                PortalError::Cancelled
            }
            other => failed("Start response", other),
        })?;

    let stream = streams
        .streams()
        .first()
        .ok_or_else(|| PortalError::Failed("the portal returned no stream".to_owned()))?;

    let fd = proxy
        .open_pipe_wire_remote(&session)
        .await
        .map_err(|error| failed("OpenPipeWireRemote", error))?;

    // A duplicated Unix fd would share one PipeWire protocol connection and
    // cannot be used by a second context. Ask the portal for a fresh remote
    // while this screen-cast session is still alive, for the allocation retry.
    let fallback_fd = proxy.open_pipe_wire_remote(&session).await.ok();

    Ok(PortalStream {
        fd,
        fallback_fd,
        node_id: stream.pipe_wire_node_id(),
        position: stream.position(),
        size: stream.size(),
        source_kind: stream.source_type().map(SourceKind::from_portal),
        restore_token: streams.restore_token().map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::CursorMode::{Embedded, Hidden, Metadata};

    #[test]
    fn embedded_falls_back_to_metadata_when_the_portal_lacks_it() {
        assert_eq!(Embedded.resolve(&[Metadata, Hidden], true, false), Metadata);
        assert_eq!(Embedded.resolve(&[Metadata, Hidden], false, false), Metadata);
    }

    #[test]
    fn metadata_falls_back_to_embedded_when_recording_video() {
        // xdg-desktop-portal-hyprland's offer.
        assert_eq!(Metadata.resolve(&[Embedded, Hidden], true, false), Embedded);
    }

    #[test]
    fn a_cursor_only_session_keeps_metadata_for_negotiation_to_refuse() {
        assert_eq!(Metadata.resolve(&[Embedded, Hidden], false, false), Metadata);
    }

    #[test]
    fn an_offered_mode_is_kept() {
        assert_eq!(Embedded.resolve(&[Metadata, Embedded], true, false), Embedded);
        assert_eq!(Metadata.resolve(&[Metadata, Embedded], true, false), Metadata);
        assert_eq!(Metadata.resolve(&[Metadata], false, false), Metadata);
    }

    #[test]
    fn metadata_goes_hidden_when_the_compositor_reports_the_pointer() {
        assert_eq!(Metadata.resolve(&[Embedded, Hidden], true, true), Hidden);
        // Nothing to keep the pointer out of without video, and no HIDDEN to ask for.
        assert_eq!(Metadata.resolve(&[Embedded, Hidden], false, true), Metadata);
        assert_eq!(Metadata.resolve(&[Embedded], true, true), Embedded);
        // A portal with METADATA reports the pointer itself.
        assert_eq!(Metadata.resolve(&[Metadata, Hidden], true, true), Metadata);
        // The system cursor stays painted in.
        assert_eq!(Embedded.resolve(&[Embedded, Hidden], true, true), Embedded);
    }

    #[test]
    fn a_miss_without_a_fallback_is_left_for_negotiation_to_refuse() {
        assert_eq!(Embedded.resolve(&[Hidden], true, false), Embedded);
        assert_eq!(Metadata.resolve(&[Hidden], true, false), Metadata);
    }
}
