// Bounds on how many words one caption shows at once. The editor's caption settings and the
// CLI's `--min-words` / `--max-words` both read them, so a CLI run cannot ask for a line the
// editor would refuse. Dependency-free on purpose: the Electron main process imports it.

export const CAPTION_WORDS_PER_LINE_MIN = 1;
export const CAPTION_WORDS_PER_LINE_MAX = 12;
