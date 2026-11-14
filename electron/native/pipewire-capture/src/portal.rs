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
    /// instead. Any other miss is returned unchanged, for the negotiation to
    /// refuse with its own error.
    ///
    /// A portal that offers no mode at all is a version 1 ScreenCast (#1537): it
    /// predates cursor modes and draws the pointer however it does. That is not
    /// METADATA, so the take records as EMBEDDED rather than failing.
    pub fn resolve(self, offered: &[CursorMode]) -> CursorMode {
        if offered.is_empty() {
            return Self::Embedded;
        }
        if self == Self::Embedded
            && !offered.contains(&Self::Embedded)
            && offered.contains(&Self::Metadata)
        {
            return Self::Metadata;
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
}

#[derive(Debug)]
pub enum PortalError {
    /// The compositor's portal does not offer METADATA cursor mode. Nothing
    /// this helper does can work without it, and falling back to EMBEDDED would
    /// bake the cursor into the pixels, which is the opposite of what the
    /// editor needs.
    CursorMetadataUnsupported,
    /// The user dismissed the picker, or the portal refused.
    Cancelled,
    /// Nothing answers on the ScreenCast interface: no portal on this session.
    Unavailable(String),
    Failed(String),
}

impl PortalError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::CursorMetadataUnsupported => "cursor-metadata-unsupported",
            Self::Cancelled => "portal-cancelled",
            Self::Unavailable(_) | Self::Failed(_) => "portal-failed",
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
            Self::Unavailable(message) | Self::Failed(message) => message.clone(),
        }
    }
}

fn failed(context: &str, error: impl std::fmt::Display) -> PortalError {
    PortalError::Failed(format!("{context}: {error}"))
}

/// Only a portal that is not there is `Unavailable`, which the helper may answer
/// with direct X11 capture: no frontend implementing ScreenCast, or no portal
/// service at all (ashpd then succeeds in `Screencast::new()` and the first call
/// fails). Anything else, a session bus that cannot be reached for one, keeps its
/// own error.
fn screencast_error(context: &str, error: ashpd::Error) -> PortalError {
    match &error {
        ashpd::Error::PortalNotFound(_) => portal_unavailable(error),
        ashpd::Error::Zbus(ashpd::zbus::Error::MethodError(name, ..))
            if name.as_str() == "org.freedesktop.DBus.Error.ServiceUnknown" =>
        {
            portal_unavailable(error)
        }
        _ => failed(context, error),
    }
}

/// Nothing answering on the ScreenCast D-Bus interface is almost never a fault
/// in the session: it is a machine with no portal BACKEND installed — invisible
/// on any desktop that ships one, which every distro's desktop metapackage does,
/// and the norm on a minimal install or a hand-assembled compositor.
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
    PortalError::Unavailable(format!(
        "no ScreenCast portal is available on this session ({error}). Screen capture on Linux \
         goes through xdg-desktop-portal, which needs the backend matching your desktop: \
         xdg-desktop-portal-gnome (GNOME), xdg-desktop-portal-kde (KDE Plasma), \
         xdg-desktop-portal-hyprland (Hyprland), xdg-desktop-portal-wlr (Sway and other wlroots \
         compositors), or xdg-desktop-portal-gtk (anything else). Install one, then log out and \
         back in."
    ))
}

/// `AvailableCursorModes` and the `cursor_mode` option both came with version 2
/// of the ScreenCast portal.
const CURSOR_MODES_VERSION: u32 = 2;

/// Whether this portal has cursor modes. ashpd keeps its own copy of the
/// version private, so the property is read again (zbus serves it from cache).
async fn has_cursor_modes(proxy: &Screencast<'_>) -> Result<bool, PortalError> {
    let version: u32 = proxy
        .get_property("version")
        .await
        .map_err(|error| failed("ScreenCast version", error))?;
    Ok(version >= CURSOR_MODES_VERSION)
}

/// `SelectSources` for a version 1 portal, which ashpd cannot send: it always
/// sets `cursor_mode`, and xdg-desktop-portal rejects any cursor mode its v1
/// backend did not advertise ("Unavailable cursor mode"), which is all of them.
/// The same request, minus that option, answered on its Request object.
async fn select_sources_without_cursor_mode<S>(
    proxy: &Screencast<'_>,
    session: &S,
    types: BitFlags<SourceType>,
) -> Result<(), PortalError>
where
    S: serde::Serialize + ashpd::zvariant::Type,
{
    use ashpd::zbus::export::futures_util::StreamExt;
    use ashpd::zvariant::{OwnedValue, Value};
    use std::collections::HashMap;

    let token = format!("openscreen{}", std::process::id());
    let sender = proxy
        .connection()
        .unique_name()
        .ok_or_else(|| PortalError::Failed("SelectSources: no D-Bus unique name".to_owned()))?;
    let request = ashpd::zbus::Proxy::new(
        proxy.connection(),
        "org.freedesktop.portal.Desktop",
        request_path(sender.as_str(), &token),
        "org.freedesktop.portal.Request",
    )
    .await
    .map_err(|error| failed("SelectSources", error))?;
    // Subscribed before the call, or the response can land before the match rule.
    let mut responses = request
        .receive_signal("Response")
        .await
        .map_err(|error| failed("SelectSources", error))?;

    let options: HashMap<&str, Value> = HashMap::from([
        ("handle_token", Value::from(token.as_str())),
        ("types", Value::from(types.bits())),
        ("multiple", Value::from(false)),
    ]);
    proxy
        .call_method("SelectSources", &(session, options))
        .await
        .map_err(|error| failed("SelectSources", error))?;

    let message = responses
        .next()
        .await
        .ok_or_else(|| PortalError::Failed("SelectSources: no response".to_owned()))?;
    let (code, _): (u32, HashMap<String, OwnedValue>) = message
        .body()
        .deserialize()
        .map_err(|error| failed("SelectSources response", error))?;
    match code {
        0 => Ok(()),
        1 => Err(PortalError::Cancelled),
        _ => Err(PortalError::Failed(
            "SelectSources response: Portal request didn't succeed: Other".to_owned(),
        )),
    }
}

/// Where the portal publishes the Request for a call made with `token`.
fn request_path(unique_name: &str, token: &str) -> String {
    let sender = unique_name.trim_start_matches(':').replace('.', "_");
    format!("/org/freedesktop/portal/desktop/request/{sender}/{token}")
}

/// Cheap, non-interactive probe: which cursor modes does this portal offer?
///
/// Split out from [`negotiate`] so the helper can answer that question — and
/// emit `ready` — before anything raises a dialog.
///
/// A version 1 portal has no `AvailableCursorModes` (it came with version 2), so
/// it offers none: reading the property there failed every take (#1537).
pub async fn offered_cursor_modes() -> Result<Vec<CursorMode>, PortalError> {
    let proxy = Screencast::new()
        .await
        .map_err(|error| screencast_error("ScreenCast", error))?;
    if !has_cursor_modes(&proxy).await? {
        return Ok(Vec::new());
    }
    let cursor_modes = proxy
        .available_cursor_modes()
        .await
        .map_err(|error| screencast_error("AvailableCursorModes", error))?;
    Ok([CursorMode::Metadata, CursorMode::Embedded, CursorMode::Hidden]
        .into_iter()
        .filter(|mode| cursor_modes.contains(mode.to_portal()))
        .collect())
}

/// Whether the portal answers but refuses a session outright, as KDE's does on
/// X11: its ScreenCast offers cursor modes there, then every take died on
/// "CreateSession: Portal request didn't succeed: Other" (#1491). Only asking
/// tells, and asking raises no dialog: `Start()` is what raises the picker.
pub async fn refuses_sessions() -> bool {
    let Ok(proxy) = Screencast::new().await else {
        return false;
    };
    match proxy.create_session().await {
        Ok(session) => {
            let _ = session.close().await;
            false
        }
        Err(error) => is_refusal(&error),
    }
}

/// A response is the portal saying no. Anything else, a bus that cannot be
/// reached for one, is not an answer, and the take keeps that error.
fn is_refusal(error: &ashpd::Error) -> bool {
    matches!(error, ashpd::Error::Response(_))
}

/// Runs the negotiation to completion. Blocks on the user for as long as the
/// picker is up: `Start()` is what raises it.
///
/// The returned `PortalStream` outlives the ashpd `Session` object on purpose.
/// ashpd has no `Drop` impl for sessions and holds its D-Bus connection in a
/// process-global `OnceLock`, so the portal session stays open until this
/// process exits — which is exactly the lifetime we want.
pub async fn negotiate(cursor_mode: CursorMode) -> Result<PortalStream, PortalError> {
    let proxy = Screencast::new()
        .await
        .map_err(|error| screencast_error("ScreenCast", error))?;

    let cursor_modes = if has_cursor_modes(&proxy).await? {
        proxy
            .available_cursor_modes()
            .await
            .map_err(|error| screencast_error("AvailableCursorModes", error))?
    } else {
        BitFlags::empty()
    };
    // An empty mask is a version 1 backend, whatever version the frontend
    // reports: xdg-desktop-portal advertises its own version (5 since 1.18)
    // and forwards the backend's modes, which a v1 backend does not have.
    let has_cursor_modes = !cursor_modes.is_empty();
    // Only METADATA is treated as mandatory, and only when it was asked for.
    // EMBEDDED is in the portal spec's baseline and every compositor implements
    // it; refusing to start because a mode we are not using is missing would be
    // the Stage 1 check applied where it no longer belongs.
    if has_cursor_modes && !cursor_modes.contains(cursor_mode.to_portal()) {
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
    // excluded — a virtual monitor has no cursor to report.
    let types: BitFlags<SourceType> = SourceType::Monitor | SourceType::Window;
    if !has_cursor_modes {
        select_sources_without_cursor_mode(&proxy, &session, types).await?;
    } else {
        proxy
            .select_sources(
                &session,
                cursor_mode.to_portal(),
                types,
                false,
                // NO RESTORE TOKEN, AND NOTHING TO PERSIST. This used to replay a
                // token from the previous run so the picker would not reappear —
                // and that is precisely how "record this window" produced a
                // recording of the whole screen. A token is bound to the source it
                // was minted for, so once any monitor had been approved the portal
                // restored that monitor on every later run and never raised the
                // picker again; the app had no way to ask for anything else,
                // because `SelectSources` cannot name a source. The picker IS the
                // source chooser on Wayland, so suppressing it removed the only
                // control the user had. Asking every time is the cost of letting
                // them choose at all.
                None,
                PersistMode::DoNot,
            )
            .await
            .map_err(|error| failed("SelectSources", error))?
            .response()
            .map_err(|error| failed("SelectSources response", error))?;
    }

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
    })
}

#[cfg(test)]
mod tests {
    use super::CursorMode::{Embedded, Hidden, Metadata};

    #[test]
    fn embedded_falls_back_to_metadata_when_the_portal_lacks_it() {
        assert_eq!(Embedded.resolve(&[Metadata, Hidden]), Metadata);
    }

    #[test]
    fn only_a_portal_response_is_a_refusal() {
        use ashpd::desktop::ResponseError;
        assert!(super::is_refusal(&ashpd::Error::Response(
            ResponseError::Other
        )));
        assert!(!super::is_refusal(&ashpd::Error::NoResponse));
    }

    #[test]
    fn an_offered_mode_is_kept() {
        assert_eq!(Embedded.resolve(&[Metadata, Embedded]), Embedded);
        assert_eq!(Metadata.resolve(&[Metadata]), Metadata);
    }

    #[test]
    fn a_v1_portal_offering_no_mode_records_embedded() {
        assert_eq!(Metadata.resolve(&[]), Embedded);
        assert_eq!(Embedded.resolve(&[]), Embedded);
    }

    #[test]
    fn the_request_path_follows_the_sender_name() {
        assert_eq!(
            super::request_path(":1.42", "openscreen7"),
            "/org/freedesktop/portal/desktop/request/1_42/openscreen7"
        );
    }

    #[test]
    fn a_miss_without_a_fallback_is_left_for_negotiation_to_refuse() {
        assert_eq!(Embedded.resolve(&[Hidden]), Embedded);
        assert_eq!(Metadata.resolve(&[Embedded]), Metadata);
    }
}
