//! Cooperative GIF cancellation and publication of a completed output only.

use anyhow::{bail, Context, Result};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::Arc;

const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const COMMITTING: u8 = 2;

#[derive(Clone, Default)]
pub struct GifExportControl(Arc<AtomicU8>);

#[derive(Debug)]
pub struct GifExportCancelled;

impl std::fmt::Display for GifExportCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GIF export cancelled")
    }
}

impl std::error::Error for GifExportCancelled {}

impl GifExportControl {
    /// False means publication has already won the race. Repeated cancellation
    /// of the same pending job is harmless.
    pub fn cancel(&self) -> bool {
        match self.0.compare_exchange(RUNNING, CANCELLED, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) | Err(CANCELLED) => true,
            Err(_) => false,
        }
    }

    pub fn check(&self) -> Result<()> {
        if self.0.load(Ordering::Acquire) == CANCELLED {
            return Err(GifExportCancelled.into());
        }
        Ok(())
    }

    fn begin_commit(&self) -> Result<()> {
        match self.0.compare_exchange(RUNNING, COMMITTING, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => Ok(()),
            Err(CANCELLED) => Err(GifExportCancelled.into()),
            Err(_) => bail!("GIF export control has already been used"),
        }
    }
}

static NEXT_OUTPUT: AtomicU64 = AtomicU64::new(0);

struct StagedGif {
    path: PathBuf,
    published: bool,
}

impl Drop for StagedGif {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Keep the destination intact until rendering and flushing have succeeded.
/// `render` owns the file so it is closed before rename/cleanup on Windows.
pub(crate) fn with_gif_output<T>(
    target: &Path,
    control: &GifExportControl,
    render: impl FnOnce(File, &Path) -> Result<T>,
) -> Result<T> {
    control.check()?;
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let (mut staged, file) = loop {
        let nonce = NEXT_OUTPUT.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".openscreen-gif-{}-{nonce}.partial", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => break (StagedGif { path, published: false }, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).context("creating temporary GIF output"),
        }
    };
    let result = render(file, &staged.path).and_then(|stats| {
        control.begin_commit()?;
        fs::rename(&staged.path, target).context("publishing completed GIF output")?;
        staged.published = true;
        Ok(stats)
    });
    if result.is_err() && !staged.published {
        if let Err(cleanup) = fs::remove_file(&staged.path) {
            if cleanup.kind() != std::io::ErrorKind::NotFound {
                // A failed cleanup is an error, even if cancellation caused it.
                // Do not report a clean cancellation while leaving an output.
                bail!("could not remove partial GIF {}: {cleanup}", staged.path.display());
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Barrier;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let nonce = NEXT_OUTPUT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("openscreen-gif-test-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn assert_only(&self, name: &str) {
            let names: Vec<_> = fs::read_dir(&self.0).unwrap().map(|p| p.unwrap().file_name()).collect();
            assert_eq!(names, vec![std::ffi::OsString::from(name)]);
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn cancellation_before_rendering_never_opens_output() {
        let dir = TestDir::new();
        let control = GifExportControl::default();
        assert!(control.cancel());
        let result = with_gif_output(&dir.0.join("out.gif"), &control, |_, _| -> Result<()> {
            panic!("cancelled job must not render");
        });
        assert!(result.unwrap_err().is::<GifExportCancelled>());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[test]
    fn cancellation_discards_partial_output_and_preserves_destination() {
        let dir = TestDir::new();
        let target = dir.0.join("out.gif");
        fs::write(&target, b"original GIF").unwrap();
        let control = GifExportControl::default();
        let result = with_gif_output(&target, &control, |mut file, _| {
            file.write_all(b"partial replacement")?;
            assert!(control.cancel());
            // Even a renderer that has just completed cannot publish now.
            Ok(42)
        });
        assert!(result.unwrap_err().is::<GifExportCancelled>());
        assert_eq!(fs::read(&target).unwrap(), b"original GIF");
        dir.assert_only("out.gif");
    }

    #[test]
    fn successful_publication_replaces_destination_and_rejects_late_cancel() {
        let dir = TestDir::new();
        let target = dir.0.join("out.gif");
        fs::write(&target, b"original").unwrap();
        let control = GifExportControl::default();
        assert_eq!(with_gif_output(&target, &control, |mut file, _| {
            file.write_all(b"finished GIF")?;
            Ok(7)
        }).unwrap(), 7);
        assert!(!control.cancel());
        assert_eq!(fs::read(&target).unwrap(), b"finished GIF");
        dir.assert_only("out.gif");
    }

    #[test]
    fn render_failure_is_not_misreported_as_cancellation() {
        let dir = TestDir::new();
        let target = dir.0.join("out.gif");
        let control = GifExportControl::default();
        let result = with_gif_output(&target, &control, |mut file, _| -> Result<()> {
            file.write_all(b"partial")?;
            control.cancel();
            bail!("encoder failed")
        });
        assert_eq!(result.unwrap_err().to_string(), "encoder failed");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[test]
    fn publication_failure_cleans_up_staging() {
        let dir = TestDir::new();
        let target = dir.0.join("destination-directory");
        fs::create_dir(&target).unwrap();
        let control = GifExportControl::default();
        assert!(with_gif_output(&target, &control, |mut file, _| {
            file.write_all(b"finished GIF")?;
            Ok(())
        }).is_err());
        assert!(target.is_dir());
        dir.assert_only("destination-directory");
    }

    #[test]
    fn cancellation_and_commit_have_exactly_one_winner() {
        for _ in 0..64 {
            let control = GifExportControl::default();
            let cancel_control = control.clone();
            let barrier = Arc::new(Barrier::new(2));
            let cancel_barrier = barrier.clone();
            let cancel = std::thread::spawn(move || {
                cancel_barrier.wait();
                cancel_control.cancel()
            });
            barrier.wait();
            let committed = control.begin_commit().is_ok();
            assert_ne!(committed, cancel.join().unwrap());
        }
    }
}
