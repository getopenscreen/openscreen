# Google Drive sync

Optional, off until the user connects an account. When it is on, each new recording and each MP4 export is copied to the user's own Google Drive, in a folder named `OpenScreen`. The local files are untouched: Drive holds a copy, never the original, and a failed upload never fails the recording or the export.

**One Drive file per project.** The project's first upload creates the file; every later upload for the project replaces that file's content in place. The file id stays the same, so its link stays the same: a link shared after the recording opens the latest export of the project.

| File | Role |
|---|---|
| [`electron/drive/google-oauth.ts`](../../electron/drive/google-oauth.ts) | Sign-in: OAuth 2.0 for installed apps, PKCE, a one-shot loopback server on `127.0.0.1`. Token refresh and revoke. |
| [`electron/drive/google-drive-api.ts`](../../electron/drive/google-drive-api.ts) | The Drive v3 calls: the folder, the resumable upload (create, or replace in place), the *anyone with the link* permission. Plain `fetch`, no `googleapis`. |
| [`electron/drive/google-drive-store.ts`](../../electron/drive/google-drive-store.ts) | `google-drive.json` (sync switch, client ID, account email, folder id, each project's Drive file, unsynced projects) and `google-drive-credentials.enc` (refresh token and client secret, `safeStorage`). |
| [`electron/drive/google-drive-service.ts`](../../electron/drive/google-drive-service.ts) | The orchestration the bridge calls: status, connect, disconnect, the switch, `syncProject`, visibility, unsync. Built in `registerIpcHandlers` (`handlers.ts`) and handed to the bridge as `getGoogleDrive`. |
| [`src/lib/driveSync.ts`](../../src/lib/driveSync.ts) | The renderer's one call, `syncProjectVideoToDrive`: never throws, answers `uploaded`, `skipped` or `failed`. |
| [`src/components/ai-edition/GoogleDriveSettings.tsx`](../../src/components/ai-edition/GoogleDriveSettings.tsx) | The *Google Drive* dialog, opened from the app menu (`EditorDialogSection` `"drive"`). |
| [`src/components/ai-edition/ProjectDriveMenu.tsx`](../../src/components/ai-edition/ProjectDriveMenu.tsx) | The Drive badge and the row menu in **Load Project** (`OpenProjectModal`). |

## The OAuth client

No client ID ships with OpenScreen, for the reason the LLM providers' OAuth flows were removed in 1.8.0 ([LLM providers](llm-providers.md#removed-in-180)). The user brings a *Desktop app* client from their own Google Cloud project, either in the dialog or as `OPENSCREEN_GOOGLE_CLIENT_ID` / `OPENSCREEN_GOOGLE_CLIENT_SECRET`. The environment wins over the dialog, as `envKeys` do for the LLM keys. The client ID is not a secret and sits in the JSON; the client secret goes in the encrypted blob with the refresh token.

The scope is `drive.file` plus `openid email`: OpenScreen sees and changes only the files it created, and the email is only shown. A folder named `OpenScreen` that the user made themselves is invisible to it, so `ensureFolder` never adopts one.

The keychain is read lazily, on the first connect or upload. `getStatus` reads only the JSON, where the account email doubles as "connected", so opening the dialog or the project list never prompts for Keychain access on macOS.

## When an upload happens

| Trigger | Where | What is uploaded |
|---|---|---|
| A take is imported into a new project | `importPendingRecording` (`recordingImport.ts`) | The screen recording |
| An MP4 export finishes | `ExportDialog` | The exported file, replacing the project's Drive file |

A GIF export is not uploaded: the Drive file is the project's *video*, and replacing it with a GIF would change what a shared link shows. `syncProject` itself does nothing while the switch is off or for a project the user unsynced, so the callers never check either.

Uploads for one project are queued (`enqueue`): an export that finishes while the take is still uploading lands on top of it rather than racing it into a second file. Each upload is one resumable session sent in a single streamed `PUT`, because takes run to gigabytes and a multipart body would hold the whole file in memory.

If the file was deleted in Drive, replacing it answers 404, and the service uploads a new file. That is the one case where a project's link changes. A refresh token Google refuses (`invalid_grant`, revoked from the account page) disconnects the account instead of failing every later upload the same way.

## The project list

`OpenProjectModal` loads `drive.listProjects` when it opens. A row with a Drive file, an upload under way or a failed upload shows the badge and the ⋮ menu:

- **Share drive link** copies the file's `webViewLink`. While the file is private, the toast says only the owner can open it.
- **Edit drive visibility** switches between *Only you* (no `anyone` permission) and *Anyone with the link* (`anyone`, `reader`).
- **Unsync from drive** forgets the project's Drive file and adds the project to `excluded`, so its later exports stay local. The file stays in Drive, link and sharing included: unsyncing is not a delete.

**Disconnect** revokes the refresh token and turns the switch off, but keeps each project's record: the files are still in Drive and their links still work, so the list keeps the badge and *Share drive link*.
