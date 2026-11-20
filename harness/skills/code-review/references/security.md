# Security checklist for code review

Check each item that applies to the change:

- **Shell commands**: is any user- or model-controlled string concatenated into a shell command? Prefer passing an argument array (`execFile`, `spawn` without `shell: true`) over building a command string.
- **File paths**: can a path contain `..` or be absolute and escape the intended directory? Resolve it and compare against the base directory, as `safePath()` does.
- **Secrets**: are API keys, tokens or `.env` contents logged, written to traces, returned in error messages or committed?
- **Untrusted content as instructions**: is text from files, web pages or tool output treated as instructions to the agent? It should be treated as data.
- **Regex as a security boundary**: string matching on shell commands can be bypassed (`r''m`, base64, variables); it guards against mistakes, not attacks.
- **Dependencies**: new packages from unknown publishers, or install scripts that run code.
