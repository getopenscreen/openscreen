---
# The review looks at the export after it is made: by the file's path, or by projectId,
# which shows the project's last export (the demo skill asks for that sheet). A sheet over
# the project before the export is right too, and a tool_order grader takes the first
# match, so a judge reads the order instead. mock_calls, not trace: the trace may list
# every tool the session was offered.
type: llm
focus: mock_calls
arm: with-only
---

Among these mock calls, find each exportVideo call that writes ledger-pdf.mp4 for the project p_demo.

PASS if a getContactSheet call comes after one of them and looks at that export, in either way:

- with a path ending in ledger-pdf.mp4, and no projectId;
- with projectId p_demo, no path, and no add…, set… or remove… call between that export and the sheet: the tool then shows the export, not the project rendered anew.

FAIL if there is no such export, or if no getContactSheet call after it looks at it in one of these ways. A getContactSheet call made before the export does not count.
