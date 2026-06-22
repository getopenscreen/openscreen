# OpenScreen — Shared Team Memory

This file is the shared memory across all Mavis reins in this repo. Add durable facts here that the team should remember across sessions: build quirks, gotchas, environment-specific notes.

Format:
```
## <Topic> (<YYYY-MM-DD>)
<one-paragraph fact or gotcha>
```

---

## i18n: 13 locales must stay in sync (2026-06-21)
Any new user-facing string needs a key in all 13 locale files under `src/locales/`. The `npm run i18n:check` script validates structural consistency. Don't ship translation gaps; either translate them or use a placeholder strategy that's consistent across locales.

## Native helpers need manual smoke tests (2026-06-21)
CI runs on Linux only. The macOS (Swift/ScreenCaptureKit) and Windows (C++/WGC) native helpers cannot be auto-verified. Any change in `electron/macos-helper/` or `electron/windows-helper/` must include a manual smoke-test note in the PR description (recorded on a real host).

## Biome owns lint AND format (2026-06-21)
There's no Prettier/ESLint — Biome 2.4 does both. Config in `biome.json`: tabs, double quotes, 100-col width, LF line endings. Don't add `eslint`/`prettier` configs on top; that would fight Biome.

## `npm run build` is slow (2026-06-21)
`npm run build` runs tsc + vite build + electron-builder packaging. For renderer-only iteration use `npm run build-vite` (tsc + vite only, no packaging). Only run the full `build` when verifying a release artifact.
