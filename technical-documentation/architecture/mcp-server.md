# MCP server

OpenScreen can offer the in-app agent's tools to MCP clients the user runs themselves — Claude Code, Codex, Cursor, anything that speaks MCP over Streamable HTTP — on any of the user's projects, not only the one open in the editor. The client brings its own model and its own sign-in; OpenScreen never sees, stores or relays those credentials. It is off by default and turned on in **Settings → AI → MCP server**.

| File | Role |
|---|---|
| [`electron/mcp/openscreen-mcp-server.ts`](../../electron/mcp/openscreen-mcp-server.ts) | The MCP server and its local HTTP guard. Registers the tools, routes each call to the editor or a project file, runs it. |
| [`electron/mcp/editor-document-host.ts`](../../electron/mcp/editor-document-host.ts) | Main-process side of the live document: asks the editor window for a snapshot and hands edits back. |
| [`electron/mcp/mcp-controller.ts`](../../electron/mcp/mcp-controller.ts) | Lifecycle: start when enabled, restart on a port or token change, status for the settings UI. |
| [`electron/mcp/mcp-settings-store.ts`](../../electron/mcp/mcp-settings-store.ts) | `mcp-server.json` (enabled, port, allowEdits) and `mcp-token.enc` (bearer token, `safeStorage`). |
| [`src/lib/ai-edition/store/mcpDocumentHost.ts`](../../src/lib/ai-edition/store/mcpDocumentHost.ts) | Renderer side: answers snapshot / apply requests from the project store. Mounted by `NewEditorShell`. |
| [`src/components/ai-edition/McpServerSettings.tsx`](../../src/components/ai-edition/McpServerSettings.tsx) | The settings section: server toggle, its own Project edits toggle, port, token, copyable `claude mcp add` / `codex mcp add` commands. |

## One tool surface, two agents

Nothing about the tools is reimplemented. The server registers `TOOL_ARG_SCHEMAS` (names and zod schemas), `TOOL_DESCRIPTIONS`, and hands `buildSystemPrompt` to the client as the server `instructions` — all exported from [`deep-agent/service.ts`](../../electron/ai-edition/deep-agent/service.ts), where `buildTools` builds the in-app agent from the same table. Every call goes through `runDocumentTool`, the function the in-app agent's `documentTool` also calls: the cursor-telemetry read the zoom tools need, then `executeAgentTool`.

So a tool added to the agent appears over MCP with no further work, and the MCP test asserts the listed tools equal `listProjects`, then `OPENSCREEN_TOOL_NAMES`, then the two checkpoint tools below. What the server adds:

- **`listProjects`**, a tool of its own: every project's id, title, `updatedAt`, asset count, and `open` for the one in the editor.
- **An optional `projectId` on every agent tool and both checkpoint tools**, added to its schema with `.extend()` at registration and stripped again before the call reaches the executor, which never sees it. See [Which project a call acts on](#which-project-a-call-acts-on).
- **`createCheckpoint` / `restoreCheckpoint`**, see [Checkpoints](#checkpoints).
- MCP metadata: `readOnlyHint` for the reads (`!isMutatingTool`), `listProjects` and `createCheckpoint`, and `destructiveHint` for `replaceTimeline`, the three `remove*` tools and `restoreCheckpoint`.

**Writes are a second opt-in.** MCP clients have their own "Project edits" switch, `allowEdits` in `mcp-server.json`, **off by default** and independent of the in-app agent's `allowAgentEdits`. Turning the server on therefore grants read access only. The value is read on every call and passed to the executor as `editsAllowed`, the same gate the in-app agent's switch drives: while it is off every mutating tool is refused with the executor's consent message, and the consent block of the system prompt is in the instructions. It is independent because `allowAgentEdits` defaults to allowed and lives in the provider form, so a user with no provider configured could never have turned MCP writes off.

## Which project a call acts on

| `projectId` | Path |
|---|---|
| omitted | The project open in the editor, through the editor. With none open the call fails with "No project is open" and points at `listProjects`. |
| the open project's id | The same: through the editor, never its file. The file is read first all the same (see below). |
| any other id | That project's file, through the app's one `DocumentService` (`getProjectForUpdate` → tool → `saveProjectIfUnchanged`). Works with no editor window at all. A write needs a checkpoint of that project first. |

The open project is never written to disk from here because the editor holds it in memory and saves it as a whole: a file edit under it would be overwritten by the editor's next save, and the editor would never show it.

## Where the document comes from

### The open project

The in-app agent is handed a document snapshot per chat turn. An MCP client has no turn, so each call reads the **live** document from the editor window, which owns it (`useProjectStore`, with its `revision`):

1. `EditorDocumentHost.snapshot()` sends `{op: "snapshot"}` on `ai-edition.mcp-request` to the editor; it answers `{document, revision}` (or `null` with no project open).
2. `runDocumentTool` runs against that document.
3. If the tool changed it, `apply(document, revision)` sends it back; the editor applies it through `applyAgentDocumentIfCurrent` — the same revision-guarded apply an in-app chat turn uses — so it is saved and becomes **one undo step**.

A user edit that lands between 1 and 3 moves the revision and the apply is refused as a conflict; the client is told to re-read. The renderer also compares the project id, because the revision counter restarts at 0 when a project closes and a quick switch to another project could otherwise match. Calls are serialised in the main process so two of them never interleave.

Only the webContents that registered on `ai-edition.mcp-host` is asked, and only its replies count. An editor that unmounts or is destroyed stops being asked. A request unanswered for 30 s resolves to "no project" (reads) or `timeout` (writes, reported as "did not confirm", not as a failure, since the save may have landed).

### Any other project

Read with `DocumentService.getProjectForUpdate` (`getProject`, migrated and relinked like any open, plus a version) and, if the tool changed it, saved with `saveProjectIfUnchanged` — the same instance every other save in the app goes through. Reads and saves of one project share its queue, so a read returns only once every read and save asked for before it is done.

A call naming a project reads its file **before** asking the editor for a snapshot. An editor open of that project already under way has then returned, and the editor installs what it read before it answers, so the snapshot shows the project and the call goes through the editor.

There is no revision to guard the file with, so the save is refused with "NOT applied … re-read, then retry" when, since the call's read:

1. **Anything read the project.** This is the editor opening it: from that read on it holds a copy without the MCP edit, and its next save would drop the edit without a word. A snapshot cannot see this in time, since the editor installs what it read only after the read returns. `DocumentService` counts every read and save of a project instead, the open-file dialog's direct read of a project file included (`beforeProjectFileRead`). The client's retry, with the same `projectId`, then goes through the editor.
2. **Anything saved it, or its file changed.** The file must still be, byte for byte, the one the tool ran against. This also covers a writer outside the app (a sync tool, a restored copy) and a delete.

The check runs inside the project's queue, so nothing in the app reads or saves the project between the check and the write.

An edit made this way is saved, but it is not on any undo stack: the editor never held it. Its undo is a checkpoint, so the write is refused until the client has created one for that project (below).

## Checkpoints

A client chains several edits in one turn, and each is its own undo step, so reverting a turn by hand means one Ctrl+Z per call, interleaved with whatever the user did meanwhile. `createCheckpoint` saves the live document in the main process and returns a `checkpointId`; `restoreCheckpoint` applies that document back through the same revision-guarded apply, so the whole revert is **one undo step** the user can itself undo. The server instructions tell the client to checkpoint before a series of edits.

- They take `projectId` like every tool, so a project that is not open has them too: the checkpoint is read from its file, and the restore is saved to it with the same guard as any edit. That restore is not one undo step, since nothing holds the project's history.
- **A project that is not open cannot be edited without one.** Ctrl+Z cannot reach an edit to it, so a write there is refused until a checkpoint of that project is in memory, and the client is told to call `createCheckpoint` first. The server instructions say so up front.
- A restore is a write: refused while MCP "Project edits" is off, and refused when the checkpoint belongs to another project than the one the call acts on. That message names the checkpoint's `projectId`: restoring a closed project's checkpoint takes it explicitly.
- It discards every edit since the checkpoint, the user's included. The tool description says so.
- Checkpoints live in memory, the 20 most recent. They are lost when the app quits or the server is turned off. The in-app agent does not need them: its whole turn is a single apply.

## Transport and security

- Streamable HTTP, **stateless**: a fresh `McpServer` + transport per request, the SDK's documented shape for a server that keeps no session state.
- Bound to `127.0.0.1` only, endpoint `/mcp`, default port 47821 (configurable, 1024–65535).
- Every request needs `Authorization: Bearer <token>`, compared in constant time. The token is 32 random bytes, stored with `safeStorage`, and read only once the server is enabled, so users who never enable it never meet a Keychain prompt for it. Regenerating it restarts the server, so the old one stops working at once.
- The `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, and a request carrying any other `Origin` is refused — this blocks a web page from reaching the server through DNS rebinding.

## Lifecycle

`registerIpcHandlers` builds the `McpController` (it is where the agent's own dependencies — the cursor reader, the LLM config — live) and returns it; **`main.ts` starts it**. The headless CLI shares `registerIpcHandlers` and must never bind the port a running app is listening on, and a bench run has no use for it, so neither calls `startIfEnabled`.

## Connecting a client

The settings section shows both commands with the real URL, and copies them with the real token:

```sh
claude mcp add --transport http openscreen http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"

export OPENSCREEN_MCP_TOKEN=<token>
codex mcp add openscreen --url http://127.0.0.1:47821/mcp --bearer-token-env-var OPENSCREEN_MCP_TOKEN
```

## Known gaps

- **Only what the agent can do.** The server exposes the agent's timeline tools. Recording, export, import and project management are not tools, for MCP or for the in-app agent.
- **No Ctrl+Z for edits to closed projects.** Their undo is the checkpoint the write requires, which lives in memory: it is gone once the app quits or 20 newer ones push it out, and the edits stay.
- **An editor that stops answering looks closed.** A snapshot unanswered for 30 s reads as "no project open", so an edit naming the project that editor holds would go to its file, and the editor's next save would drop it. It takes a renderer hung for 30 s.
- **The open-file dialog saves back what it read.** Opening a project's own file through it reads the file, then saves that content as the project. An MCP edit landing between the read and that save is overwritten, as any other change would be. Closing it is the dialog's job (not saving back a file that already is the project), not the server's.
- **No project management.** Projects can be listed, read and edited, not created, renamed or deleted.
