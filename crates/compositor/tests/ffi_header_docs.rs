//! C-header prose/examples must remain visible docs, not implicit Rust examples.
use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn generated_header_docs_do_not_disable_real_rust_doctests() {
    let bindings = include_str!(concat!(env!("OUT_DIR"), "/ffi.rs"));
    let docs = bindings
        .lines()
        .map(str::trim_start)
        .filter(|line| line.starts_with("#[doc = "))
        .collect::<Vec<_>>();
    assert!(docs.len() > 100, "keep upstream header documentation");
    assert!(docs
        .join("\n")
        .contains("Return an informative version string"));
    let dir = std::env::temp_dir().join(format!(
        "openscreen-ffi-docs-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&dir).unwrap();
    let fixture = dir.join("foreign_docs.rs");
    fs::write(
        &fixture,
        format!(
            "{}\npub struct ForeignHeader;\n\
        /// A genuine Rust example must still execute.\n\
        /// ```rust\n\
        /// assert_eq!(2 + 2, 4);\n\
        /// ```\n\
        pub struct RustExample;\n",
            docs.join("\n")
        ),
    )
    .unwrap();
    let output = Command::new(std::env::var_os("RUSTDOC").unwrap_or_else(|| "rustdoc".into()))
        .args(["--test", "--edition=2021"])
        .arg(&fixture)
        .output()
        .unwrap();
    let report = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "{report}");
    assert!(report.contains("1 passed; 0 failed; 0 ignored"), "{report}");
    // A broken *Rust* example must still fail: no global doctest disable/ignore.
    let source = fs::read_to_string(&fixture)
        .unwrap()
        .replace("assert_eq!(2 + 2, 4)", "assert_eq!(2 + 2, 5)");
    fs::write(&fixture, source).unwrap();
    let broken = Command::new(std::env::var_os("RUSTDOC").unwrap_or_else(|| "rustdoc".into()))
        .args(["--test", "--edition=2021"])
        .arg(&fixture)
        .output()
        .unwrap();
    fs::remove_dir_all(&dir).unwrap();
    assert!(
        !broken.status.success(),
        "real Rust doctests must not be skipped"
    );
    assert!(String::from_utf8_lossy(&broken.stdout).contains("1 failed"));
}
