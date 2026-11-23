---
# No recording, project, edit or export: the names of OpenScreen's acting tools must not
# appear among the mocked calls. Reads (listProjects, getCurrentDocument) are tolerated.
type: regex
pattern: 'startRecording|stopRecording|createProject|exportVideo|setAspectRatio|setEditorSettings|add[A-Z]\w*|set[A-Z]\w*|remove[A-Z]\w*|restoreCheckpoint|importMedia'
match: not_contains
target: mock_calls
arm: both
---
