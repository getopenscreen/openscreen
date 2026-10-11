 # Contribution Guidelines

Thank you for considering contributing to this project! By contributing, you help make this project better for everyone. Please take a moment to review these guidelines to ensure a smooth contribution process.

## How to Contribute

1. **Fork the Repository**
   - Click the "Fork" button at the top right of this repository to create your own copy.

2. **Clone Your Fork**
   - Clone your forked repository to your local machine:
     ```bash
     git clone https://github.com/your-username/openscreen.git
     ```

3. **Create a New Branch**
   - Create a branch for your feature or bug fix:
     ```bash
     git checkout -b feature/your-feature-name
     ```

4. **Make Changes**
   - Make your changes.

5. **Test Your Changes**
   - Test your changes thoroughly to ensure they work as expected and do not break existing functionality.

6. **Commit Your Changes**
   - Commit your changes with a clear and concise commit message:
     ```bash
     git add .
     git commit -m "Add a brief description of your changes"
     ```

7. **Push Your Changes**
   - Push your branch to your forked repository:
     ```bash
     git push origin feature/your-feature-name
     ```

8. **Open a Pull Request**
   - Go to the original repository and open a pull request from your branch. Provide a clear description of your changes and the problem they solve.

## First-time setup on macOS

### Prerequisites

- **Node 22.22.1 and npm 10.9.4**, the versions pinned in `package.json`. With nvm, run `nvm use` in the repository root. Use npm, not another package manager.
- **Full Xcode**, not only the Command Line Tools. After installing it:
  ```bash
  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept
  ```
- **Rust, installed with [rustup](https://rustup.rs)**. The build script looks for `cargo` at `~/.cargo/bin/cargo`, so a Homebrew-installed Rust is not found.

### Build the native binaries

Run these once from the repository root, in this order:

```bash
npm install
npm run build:native:mac             # Swift capture and cursor helpers
npm run fetch:ffmpeg:mac             # builds an LGPL ffmpeg from source, about five minutes
npm run build:native:compositor:mac  # Rust compositor addon, links the ffmpeg above
npm run fetch:onnxruntime            # optional, see below
npm run dev
```

| Command | What it produces | Without it |
|---|---|---|
| `build:native:mac` | `openscreen-screencapturekit-helper` and `openscreen-macos-cursor-helper` | Native screen capture is unavailable |
| `fetch:ffmpeg:mac` | An ffmpeg 8.1.2 tree in `crates/thirdparty/` | The compositor addon cannot be built |
| `build:native:compositor:mac` | `compositor_view.node` | The editor preview is blank and exports render nothing |
| `fetch:onnxruntime` | The ONNX Runtime library | The webcam background cutout, blur and custom modes are off; everything else works |

`fetch:ffmpeg:mac` compiles ffmpeg rather than downloading a binary because the prebuilt macOS builds, Homebrew's included, are GPL and cannot be linked into this MIT app. Do not point the build at a Homebrew ffmpeg.

Transcription and captions need a further binary, `whisper-stt-server`. See [`technical-documentation/engineering/build-and-packaging.md`](technical-documentation/engineering/build-and-packaging.md) for that and for packaging a release build.

### When to rebuild

The binaries stay at whatever you last built, and nothing warns you when they fall behind the source.

- After changing Swift code in `electron/native/screencapturekit/`, run `npm run build:native:mac`.
- After changing Rust code in `crates/`, run `npm run build:native:compositor:mac`.
- After switching to a branch that changes either, run the matching command before testing.

A git worktree starts with none of these binaries, because git does not copy gitignored files.

## Reporting Issues

If you encounter a bug or have a feature request, please open an issue in the [Issues](https://github.com/EtienneLescot/openscreen/issues) section of this repository. Provide as much detail as possible to help us address the issue effectively.

## Issue lifecycle

Issues are closed when the corresponding fix or feature is merged into `main`.

For desktop users, this does not always mean the change is already available in the latest downloadable release. When relevant, closed issues are marked as `status: fixed in main` and `status: pending release`.

Once a GitHub Release containing the change is published, the issue can be marked as `status: released`.

The next version number is not always known when a PR is merged. In that case, issues are assigned to the `Next Release` milestone. When preparing a release, this milestone can be renamed to the actual version, such as `v1.6.0` or `v2.0.0`, and a new `Next Release` milestone can be created.

When a PR fully resolves an issue, link it with a GitHub closing keyword:

```txt
Fixes #123
Closes #123
Resolves #123
```

If a PR only partially addresses an issue, use a non-closing reference instead:

```txt
Refs #123
Part of #123
Related to #123
```

## Style Guide

- Write clear, concise, and descriptive commit messages.
- Include comments where necessary to explain complex code.

## License

By contributing to this project, you agree that your contributions will be licensed under the [MIT License](./LICENSE).

Thank you for your contributions!
