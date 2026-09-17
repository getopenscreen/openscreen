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

## Adding music to the bundled library

Only **CC0 1.0** tracks are eligible, and the reason is not taste. A licence that merely
permits *use* (Pixabay, Mixkit, Bensound, Uppbeat and the like) forbids redistributing the
file, which is exactly what bundling does; CC-BY is worse for our users, because its
attribution obligation follows the video they export all the way to their viewers.

So a PR that adds a track must add, in the same commit:

1. The audio file under `public/music/`, **byte-for-byte as published upstream** — do not
   re-encode it, or the digest stops being checkable against the source.
2. A complete entry in `public/music/catalogue.json`, including `sourceUrl` and a
   `licenseSnapshotUrl` pointing at a [web.archive.org](https://web.archive.org) capture of
   the page that states the licence. The live page is not evidence; it can change.
3. A line in the track list in `THIRD-PARTY-NOTICES.md` — electron-builder strips every
   README from the package, so that file is the only provenance a user receives.

Run `node scripts/check-music-licences.mjs --update-digests` to fill in `sha256` and
`bytes`, then `npm run music:check`. CI runs the same guard, and it fails the build rather
than shipping a track whose licence nobody can verify.

## License

By contributing to this project, you agree that your contributions will be licensed under the [MIT License](./LICENSE).

Thank you for your contributions!
