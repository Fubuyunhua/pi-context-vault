# 0006: Repository map file outcomes

## Status

Accepted for issue #28.

## Problem

A missing file, an excluded or Git-ignored path, a non-regular entry, binary content, an I/O failure, and a successfully indexed file currently collapse into an optional `file`. Incremental maintenance can therefore mistake a transient read failure or an inadmissible addition for deletion, discard coherent data, and publish an incorrect fresh generation.

## Decision

File indexing returns a discriminated outcome:

- `indexed`: a semantic or lexical file; parse failures are represented as lexical files with a bounded `parse-error` warning and `degradedReason`.
- `missing`: `lstat` confirmed `ENOENT`.
- `ignored`: built-in, configured, or Git ignore admission rejected the path.
- `non-regular`: `lstat` succeeded but the entry is not a regular file.
- `non-text`: a regular file contains binary content and includes its content hash.
- `read-error`: `lstat` or reading failed for any reason other than `ENOENT`, with a bounded warning.

Only an explicit watcher `unlink` or `missing` outcome is deletion. A transient `read-error` preserves the last coherent indexed file and dirty overlay, leaves the path pending, and makes runtime freshness `stale`; stale query evidence and messages remain bounded. A later successful reconciliation may recover.

An `indexed` parse-degraded file remains lexical and makes freshness `unsupported`, preserving existing TypeScript and Java degradation behavior. A confirmed transition from tracked text to binary removes the searchable file but records the binary content hash as the dirty overlay; an untracked binary or ignored addition changes neither overlay, workspace revision, nor generation.

## Admission

Built-in segment exclusions, configured exclusions, and Git ignore behavior form one admission policy used by initial enumeration, watcher updates, and Git dirty reconciliation. Git-backed initial enumeration provides the admitted starting set. Unknown post-start additions are checked against Git ignore rules when processed, not on each query. Git dirty reconciliation is still batched through `git status`, which already omits ignored untracked files.

Outside a Git worktree, initial enumeration and incremental processing both apply the configured policy plus cached root `.gitignore` rules. A `.gitignore` watcher event refreshes those rules through a full rebuild. Git exit 128 is not treated as admission: direct per-file indexing falls back to the same root rules.

Built-in excluded directory segments include `.git`, `.pi`, `.gradle`, `node_modules`, `dist`, `build`, `target`, `__pycache__`, `.pytest_cache`, `.tox`, `.venv`, `venv`, `.mypy_cache`, `.ruff_cache`, `_build`, and common tool caches. Matching is by complete path segment, so legitimate names such as `venv_notes.md`, `builder`, or `my__pycache__file.py` remain eligible.

## Durability

Generation activation remains semantic and bounded. Outcomes that do not alter snapshot, overlay, pending failures, or freshness do not create a generation. Stale and unsupported states are explicit and may be durably activated when their coherent state changes.

At startup, a valid active generation for the same project is hydrated before rebuilding, so a rebuild read failure can retain its coherent searchable evidence and dirty revision. If no valid prior generation exists, there is no coherent file to preserve: the path is absent from search results, freshness is `stale`, the bounded read warning remains pending, and query fallback explicitly directs the caller to filesystem search.
