# OpenScreen plugin evals

A suite for `claude plugin eval`. It checks three things for each skill: that it fires on the right requests, that the agent then does the right things in the right order, and how far the plugin beats an agent without it.

## What it covers

| Case | Skill | What it protects |
|---|---|---|
| `review-finds-planted-defects` | review | Looks at the whole film, the frames and the measured sound, and names three planted defects with their times: a callout over its button, a silence in the music, -23.4 LUFS |
| `demo-from-take` | demo | Reads the project, sets the format before the text, cuts 34 s to about 20 s, places callouts, exports, looks at the exported file, asks before posting |
| `effects-click-ring` | effects | WGSL that defines `effect` and reads `ctx.clicks`, then a contact sheet just after a click |
| `effects-compile-error-repaired` | effects | A compile error from `addEffect` gets fixed and sent again, not given up on |
| `sound-duck-and-measure` | sound | `importMedia`, `addAudio` with the bed 6 dB or more under the voice, `getAudioReport`, and the measured numbers quoted back |
| `motion-dizzying-zooms` | motion | Eight zooms a second apart go down to four or fewer, then the result is checked |
| `deliver-pr-comment` | deliver | A 720p MP4 for a pull request, the 10 MB budget named, nothing claimed as posted, nothing committed |
| `capture-headless-plan` | capture | A localhost web app with nothing on screen: `capture.mjs`, then `createProject`, then `setPointerTrack`, and a question before any install |
| `negative-shell-script` | none | No OpenScreen skill or tool on an unrelated coding request |
| `negative-frame-rate-question` | none | A general video question gets an answer, with nothing recorded or edited |

Each case's `prompt.md` opens with a comment saying what it protects.

**MCP tools are mocked.** The real server never starts. `mocks/openscreen/` answers the tools these cases call, not every tool the skills name: the caption tools, the style presets, `setSpeed`, `getBeforeAfter`, `getEffect` and a few more have no mock, and a tool without one is not offered to the model. `mocks/openscreen/_tools.json` gives the mocked tools their real descriptions and input schemas. Some cases override a few answers in their own `mocks/` folder.

- An eval agent cannot see pictures, so the frame tools answer in words. That is how the defects are planted.
- Where the agent reads the project back after editing it, the answer comes from an agent mock (`type: agent`) that applies the edits. A fixed snapshot would never change, and a careful agent then stops because its edits seem not to land.

**No case grants Bash, Write or Edit.** Shell tools need an OS sandbox, which native Windows lacks.

## Run it

Run from the repository root. Always pin both models and set a cost cap:

```sh
# One case, with-plugin arm only: the cheap check while you work
claude plugin eval plugin --case review-finds-planted-defects --runs 1 --ablation none \
  --model claude-opus-5-5 --judge-model claude-opus-5-5 --no-publish --max-cost-usd 1

# The whole suite, with the no-plugin baseline
claude plugin eval plugin --runs 1 \
  --model claude-opus-5-5 --judge-model claude-opus-5-5 --no-publish --max-cost-usd 6
```

- **In CI,** add `--trust-plugin` and `--json results.json`.
- **Results** go to `plugin/evals/results/<timestamp>/` (`report.html`, `aggregate-result.json`), which git ignores.
- **Agent-mock recordings:** a run lists them, and they can be copied into a case's `mocks/.replay/` so later runs replay them with no model call.

## What a run costs

Measured on Claude Opus 5.5, one run per case, at list price:

| Case | With plugin |
|---|---|
| demo | $0.48 |
| motion (agent mocks) | $0.40 |
| click ring, compile error, review | $0.27 to $0.29 each |
| sound | $0.23 |
| deliver, capture | $0.16 to $0.17 each |
| negatives | $0.08 each |

The no-plugin arm is cheaper, about $0.10 a case, because it has no OpenScreen tools to call.

**About $3.50 for the whole suite with the baseline at `--runs 1`, and about $10 at the default 3 runs.** Only `llm` graders and agent mocks add judge cost. Every other grader is free.

These figures were measured before seven `llm` graders (`cuts-to-length`, `says-placed`, `answers`, `looks-after-export`, `keeps-the-shader`, `gives-script`, `looks-just-after-a-click`) and three agent mocks (`setZoom`, `setEditorSettings`, `removeModifier`) replaced fixed ones. Expect somewhat more, and measure again on the next full run.

## Read the with/without difference

The report has three columns: `WITH` (plugin score), `W/OUT` (score without the plugin) and `Δ` (the difference).

- **Graders marked `arm: with-only` are left out of the score in a two-arm run.** These are skill-fired checks and checks on OpenScreen's own tools, which only exist with the plugin. They show the plugin working, but they measure nothing against the baseline.
- **Δ therefore comes from what both arms can do:** the words of the answer (regex and `llm` graders) and the negative checks (`arm: both`).
- **A positive Δ means the plugin's skills changed the outcome.** For example, the baseline does not know about `capture.mjs`, the 10 MB budget or the defects it never measured.
- **A negative case should score 1 in both arms.** If it drops with the plugin, a skill fires where it should not.
