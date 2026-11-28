---
name: openscreen-deliver
description: Exports a finished OpenScreen video for where it is going and hands it over. Covers the shape, length, format and size budget per destination (pull request, README, X, LinkedIn, Discord, vertical shorts), what to lower first when a file is too big, GIFs for a README, attaching a video to a GitHub pull request with gh, and drafting a post for X or another network, with nothing ever posted, published or sent without the user's explicit yes for that one action. Use when the user asks to export, compress, shrink, convert to GIF, make a vertical or square version, attach a video to a pull request, comment with a video, share a demo, or draft or publish a post with it, or when a file is over a size limit ("too big for GitHub", "under 10 MB", "for Discord"). Not for recording, editing, effects or the quality review.
---

# Deliver an OpenScreen video

The film is edited and has passed the `openscreen-review` skill. Here you export it in the shape and size its destination wants, then hand it over. **Nothing is posted, published, commented or sent to anyone without the user's explicit yes for that one action**: a yes to an earlier step, to the video or to a draft is not a yes to post.

**Never commit a video to the repository.** It goes into the pull request, the post or the user's hands, not into the code. Keep exports out of `git add`. A README GIF goes into the repository only when the user asks for it there.

## Pick the settings for the destination

| Destination | Shape | Length | Export | Budget |
|---|---|---|---|---|
| Pull request | 16:9 | 10 to 30 s | MP4, `quality: "medium"` (720p) | 10 MB on a free plan, 100 MB on a paid one |
| README | 16:9 | 5 to 15 s, loops | GIF, `gifSize: "small"` (480p), `gifFrameRate: 15` | 5 MB |
| X | 16:9 | 20 to 60 s, at most 2 min 20 s | MP4, `quality: "good"` (1080p) | 512 MB without Premium |
| LinkedIn | 16:9, 1:1 or 4:5 | 30 to 90 s | MP4, `quality: "good"` | Plays muted: the callouts carry the story |
| Discord | 16:9 | under 30 s | MP4, `quality: "medium"` | 10 MB without Nitro |
| Shorts, Reels, TikTok, stories | 9:16 | under 60 s | MP4, `quality: "good"` | Plays muted |
| A page, a talk, a download | 16:9 | any | MP4, `quality: "good"` or `"source"` | none |

`quality` sets the height: `medium` 720 px, `good` 1080 px (the default), `source` the recording's own. `fps` is 24, 30 or 60 (default 60). For a GIF, end the path in `.gif`: then only `gifFrameRate` (15, 20, 25 or 30), `gifSize` (`small`, `medium`, `large`, `original`) and `gifLoop` apply, and `quality` and `fps` are refused.

## Export

1. Resolve an absolute path first, such as `demo/demo.mp4` against the working directory: the server in the app refuses a relative path.
2. `exportVideo` with the `projectId`, the `path` and the settings above. One export runs at a time.
3. Check the file's size on disk against the budget.
4. Look at the exported file as the `openscreen-review` skill's last step says, with `path`.

**Over budget? Lower in this order**, exporting and measuring after each:

1. Quality: `good` to `medium`.
2. Frame rate: `fps: 30` (a GIF: `gifFrameRate: 15`, `gifSize: "small"`).
3. Length: cut or speed up the weakest beat (`addTrims`, `addSpeed`), then review the changed stretch again.

Never trade sharpness of the product for a background effect: if a large soft gradient or grain costs bits, flatten it.

**Captions as a file,** for a platform that takes a subtitle track beside the video (YouTube, LinkedIn): `exportCaptions` with the `projectId` and a path ending in `.srt` or `.vtt` writes the captions timed on the exported video, cuts and speed changes included. Pass `language` for a translation layer. The burnt-in captions stay in the picture either way: turn them off with `setCaptionSettings` before the export when the file replaces them.

**A GIF for a README** stays under 5 MB, about 5 to 15 s of one beat that loops cleanly: end on a frame close to the first. Still too heavy at `small` and 15 fps: shorten it, or ask the user whether a short MP4 would do.

**Another shape for a second destination:** `createCheckpoint`, then `setAspectRatio` with the new shape (`9:16`, `1:1`, `4:5`), move the callouts that no longer fit (`setAnnotation`), review the film again, export it, then `restoreCheckpoint` to go back to the first shape.

## Attach it to a pull request

Only to a pull request the user asked for a video on, or one you open for them in this task.

1. **Check the size.** GitHub takes videos up to 10 MB in a repository on a free plan, 100 MB on a paid one. Over the limit, lower the export as above.
2. **Write the text around it** in a file, say `demo/pr-video.md`: one line saying what the video shows, then the video alone in its own paragraph, so GitHub shows a player and not a link:

   ```markdown
   **Demo:** the export dialog now remembers the last format.

   ![](demo/pr-video.mp4)
   ```

3. **Attach it with `gh`**, version 2.99.0 or later (`gh --version`). `gh` uploads the file and puts its URL in place of the path. You need push access to the repository.
   - On an existing pull request, as a comment: `gh pr comment <number> --body-file demo/pr-video.md --attach demo/pr-video.mp4`
   - On a pull request you are opening: put the same two lines in its body, and pass `--attach demo/pr-video.mp4` to `gh pr create`.
4. **With an older `gh`** (`unknown flag: --attach`), ask the user to update it. **On GitHub Enterprise Server,** where `gh` cannot attach files at all, skip `--attach`. In both cases, use a browser tool that can attach a file to the comment box on the pull request's page, or else give the user the file and the text to drop in themselves.
5. Report the comment's or the pull request's URL.

## Draft a post

### X

1. **Write the post.** At most 280 characters: the hook first, then what it does, then the link if there is one. One or two hashtags at most. Write what the video shows, in the product's own words: no claim the video does not back.
2. **Check X's limits.** The video must be an MP4 of at most 2 min 20 s and 512 MB for an account without Premium. A 1080p export of a demo fits.
3. **Ask the user.** Show the post text, the video path and one frame (`getFrames` with the exported `path`), and ask for an explicit yes. A "looks good" given to an earlier step is not one.
4. **Post, after the yes only.** Use a browser tool that can attach a file to the composer at https://x.com/compose/post, or the X API if the user has set one up. If you cannot attach a file, give the user the text and the file instead.
5. Report the post's URL.

### Anywhere else

LinkedIn, Discord, a forum, a newsletter, a chat channel: write the draft for that place, then the same steps 3 to 5. Read the place's rules on self-promotion first, and say when a draft might break them. Mentioning or messaging someone is sending on the user's behalf: it needs its own yes, and is never automated in bulk.

## What to report

The exported file's path, size, length and resolution, the destination it was made for, and the URL of anything posted or attached. When you stopped short of posting, give the user the file and the draft, ready to use.
