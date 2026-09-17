# Translating the website

The site is translated into `fr`, `es`, `pt-BR`, `ja`, `zh-CN`, `zh-TW` and `de`. Everything you edit lives under `website/i18n/<locale>/`. Nothing else needs to change.

**The rule: say exactly what the English says.** No added claims, no dropped caveats, no marketing polish. The English pages are fact-checked; a translation that says more or less than them is wrong even when it reads better.

## What is translated, and what is not

- **Translated:** everything but the blog: the landing page, `/download/`, the docs, the comparison, platform and feature pages (`src/pages/**/*.mdx`), the navbar, the docs sidebar, the footer and the theme (404 page, pagination, "last updated"…). The translated 404 page only shows after a click inside the site: GitHub Pages answers every missing URL, `/fr/…` included, with the English one.
- **English only:** the blog, a dated development journal. A translated build does not contain it, and links to it from translated pages go to the English blog (see below).
- **The build enforces it:** a locale missing any doc or `.mdx` page fails `npm run build`, because Docusaurus would otherwise publish the English file under `/<locale>/` marked as your language.

## Files to fill, per locale

Replace `<locale>` with `fr`, `es`, `pt-BR`, `ja`, `zh-CN`, `zh-TW` or `de`.

1. **`i18n/<locale>/code.json`**: the landing page, `/download/`, the footer and the theme.
   - Translate each `"message"`. Never change a key or a `{placeholder}`. Read the `"description"` when there is one.
   - `theme.*` entries come pre-translated by Docusaurus: review them. `theme.blog.*` is unused (no blog in translated builds).
2. **`i18n/<locale>/docusaurus-theme-classic/navbar.json`**: navbar labels. Keep them short: the navbar has little room.
3. **`i18n/<locale>/docusaurus-plugin-content-docs/current.json`**: sidebar category and link labels. `version.label` is not shown.
4. **`i18n/<locale>/docusaurus-plugin-content-docs/current/`**: one translated copy of each doc, same file name and folder:
   - `intro.md`, `installation.md`, `quick-start.md`, `faq.md`
   - `recording.md`, `media-library.md`, `editing-timeline.md`, `captions.md`, `ai-editing.md`, `export.md`, `cli.md`
   - `guides/product-demo-video.md`

   Start from a copy of `website/docs/<file>`. In the front matter, translate `title`, `description`, `sidebar_label` and `keywords`. Leave `id`, `slug` and `sidebar_position` as they are.
5. **`i18n/<locale>/docusaurus-plugin-content-pages/`**: one translated copy of each `website/src/pages/**/*.mdx`, same path (`alternatives/screen-studio.mdx`, `screen-recorder-linux.mdx`…). Translate `title`, `description` and `keywords` in the front matter. Prices, plan limits and "checked September 2026" dates are facts: copy them as they are, in your language's number and currency format. Keep the Sources list's URLs, and translate the trademark note.

**All 12 docs of a locale land together.** The docs link to each other with relative paths (`./captions.md`), and Docusaurus only resolves those between files in the same folder: with some docs translated and others not, the build fails on broken links. A doc missing from a finished locale would also be published under `/<locale>/docs/` in English, marked as your language.

## Keep every heading's English anchor

Links such as `./captions.md#translation` and `/docs/installation#system-requirements` point at heading anchors, and a translated heading would change its anchor. Give **every** section heading (`##` and below) an explicit id: the anchor of the English heading.

```md
## Traduction {#translation}
```

The fastest way: right after copying the English file, and **before** translating it, run from `website/`:

```sh
npx docusaurus write-heading-ids . i18n/<locale>/docusaurus-plugin-content-docs/current/<file>.md
```

It appends `{#…}` to each `##` to `######` heading (the `#` page title has no anchor to keep), computed from the English text: the same anchors the English pages have. Then translate the heading text and leave the `{#…}` alone. The build fails on a broken anchor.

## Links

Keep Markdown links as they are. Links to translated pages (`/docs/…`, `/download/`, `/features/…`, `./other-doc.md`) get the `/<locale>/` prefix automatically, so do not add "(in English)" to them.

A link to the blog, the one English-only page, is rendered as a plain link to the English page, with `hreflang="en"` and without the prefix. Say in the link text that it is in English where the reader would not expect it:

```md
[journal de développement (en anglais)](/blog/)
```

In `code.json`, a description that mentions an English-only page means the same thing for that label.

## Never translate

- The product name **OpenScreen**, and other product and brand names (Screen Studio, Whisper, PipeWire, ScreenCaptureKit…).
- Commands, flags, options, file names, extensions, paths and anything in `code` or a code block (`winget install --source msstore OpenScreen`, `--auto-zoom`, `.dmg`, `.openscreen`).
- `{placeholders}` in `code.json`, and URLs.
- The quoted words in the `showcase.*.label` entries: they describe drawings of the app, which stay in English.

## Interface labels

When a text names something in the OpenScreen interface (a button, a panel, a setting, in **bold** in the docs), use **the app's own translation**, not your own. They are in the app repository: `src/i18n/locales/<app-locale>/*.json`. The app locale is `fr`, `es`, `pt-BR`, `ja-JP`, `zh-CN` or `zh-TW`.

The same goes for operating-system labels (SmartScreen's *More info* and *Run anyway*, macOS's *Screen Recording* and *Accessibility*): use the words the system shows in your language.

### German: English interface labels, for now

No OpenScreen release has a German interface yet. It was added by [pull request #672](https://github.com/getopenscreen/openscreen/pull/672), which no release includes, so German users see the English interface. Until a release ships it:

- German docs keep every OpenScreen interface label in English, exactly as the app shows it, in **bold**, with German text around it.
- Do not take labels from that pull request or from `main`: they are not what German users see.
- Operating-system labels are not affected: use the German ones.

Once a release includes the German interface, switch the German docs to the app's own labels, from `src/i18n/locales/de/*.json` at that release.

## Check your work

From `website/`:

- **While translating:** `npm run dev -- --locale <locale>`, then open the URL it prints.
- **Before a pull request:** `npm run build`, which builds every locale as CI does, then `npm run serve` and open `/fr/`, `/es/`, `/ja/`, `/de/`, or the lowercase `/pt-br/`, `/zh-cn/` or `/zh-tw/`.

## Keeping translations up to date

The English changes; the translations follow. Translate **what changed**, not the whole page again.

1. **See what is behind:** `npm run i18n:check` (CI runs it and prints the same list as warnings; it never fails the build).
   - A Markdown translation is behind when its English source has a newer commit. `git log -p <source>` since the translation's last commit shows exactly what to carry over.
   - `code.json` is behind when a `<Translate>` string changed or was added in the English source; the ids are listed.
2. **Refresh the string files:** `npm run i18n:sync`. It adds new ids to every `code.json` (with the English text as a placeholder), drops removed ones and copies the English descriptions. Existing translations are kept.
3. **Translate the changes** in every locale: the diff of each stale file, and the listed `code.json` ids. One pass per locale, by a translator or an agent given this file, the English diff and the locale's files.
4. **Record it:** `npm run i18n:sync -- --accept` once every locale has the new strings. It stores the English strings the translations now match in `i18n/code.source.json`. Commit the translations and that file together: committing a translated `.md`/`.mdx` is what marks it up to date.
5. **Check:** `npm run build`. A new English page or doc with no translation fails here; add the translated file in every locale (the same pass as step 3, for the whole file).

One blind spot: the check compares commit order, so a branch of translations rebased on top of a newer English change looks up to date. When you rebase translation work, run `git log -p <base>..` on the English sources it now sits on and carry those changes over by hand.

A new page gets a full review in each language before it ships. An update to an existing page does not need one: the diff is small, and the build checks links and anchors.
