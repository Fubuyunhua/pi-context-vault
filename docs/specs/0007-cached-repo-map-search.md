# 0007: Cached repository-map search

## Status

Accepted for issue #29.

## Problem

Every repository-map query rebuilt the MiniSearch index and also ran `ensureFresh`. Automatic capsule injection already refreshes the map in `before_agent_start`, so the context hook performed a second Git reconciliation. Dirty paths reported by Git were also reread and reparsed on every reconciliation even when their content had not changed.

## Decision

`RepoMapRuntime` owns an explicit, monotonic effective-content version. The version is runtime-local and advances only when the ordered `snapshot.files` content changes. It is never derived from snapshot object identity or durable generation number.

The runtime caches one `RepoMapSearch` together with the version from which it was built. A query reuses that search object while the effective-content version is unchanged. Indexed file additions, changed indexed content (including parse-degraded lexical content), and transitions that add or remove searchable files through deletion, binary content, or non-regular entries advance the version. Warning, pending, freshness, Git-status, activation-generation, provenance timestamp, and semantic no-op changes do not.

A cached search may retain an older snapshot object after a semantically identical rebuild. This is safe because version equality is based on the complete ordered file records, not object identity, and search does not consume snapshot warnings or provenance.

## Freshness paths

The runtime exposes two query paths:

- `query` is the live explicit-tool path. It calls `ensureFresh` and then queries the coherent snapshot.
- `queryCurrent` queries the current coherent snapshot without Git reconciliation.

`before_agent_start` performs the once-per-turn refresh. Automatic capsule injection then uses `queryCurrent`, avoiding a second reconciliation. Injected `RepoMapController` implementations may omit `queryCurrent`; the extension falls back to the existing `query` method to preserve controller testability and compatibility. The explicit `context_vault_repo_map` tool always uses `query`.

Both paths count repository-map queries. Only `ensureFresh` calls count freshness reconciliations, and `searchIndexBuildCount` advances only when a new `RepoMapSearch` is actually constructed.

A query captures its searchable files, results, freshness, generation, Git head, workspace revision, pending paths, and error synchronously before its first fallback `await`. Source excerpts and `git diff` are best-effort degraded evidence and may be read concurrently with a scheduled flush, but that flush cannot mix newer provenance or freshness fields into the already captured query result.

## Dirty-file outcome cache

Incremental reconciliation caches stable per-path indexing outcomes under a filesystem fingerprint containing entry type, size, modification and change times, mode, inode, and device where the filesystem provides them. Git status continues to discover dirty paths, and watcher events always discard the path cache and force indexing. A changed fingerprint therefore detects external edits even when a watcher event was missed, while an unchanged dirty path avoids another read and parse.

A fingerprint is cached only when it is stable across indexing. Environments that inject file operations without metadata safely fall back to reindexing. Read errors are never reused, so recovery is retried on each reconciliation. Ignored outcomes are not reused because admission rules can change independently of the path metadata. Missing, binary, non-regular, and indexed outcomes are reusable; their dirty-overlay semantics remain those specified in 0006.

When Git-ignore checking is requested, reusable outcomes still undergo a current, path-bounded admission check before reuse. This catches missed watcher delivery for root `.gitignore`, `.git/info/exclude`, and other ignore changes that make a previously dirty path disappear from current Git status. File metadata stability is never treated as evidence that admission rules are unchanged.

The fingerprint is a change detector, not repository content identity. Workspace revision remains based on content hashes/outcomes, and watcher delivery plus Git dirty discovery remain authoritative inputs. Filesystems that do not expose sufficiently precise metadata use the conservative reindex fallback.

## Bounded freshness reconciliation

A flush snapshots at most 64 queued watcher updates per pass and performs at most eight complete passes or 1,000 milliseconds of pass work, whichever budget is observed first. The runtime does not force-cancel an individual filesystem, Git, or activation operation already in progress; the budget is checked at pass boundaries.

Notifications received while a batch is processed remain queued for a later pass. If watcher production prevents quiescence within the budget, `flush` and `ensureFresh` return with `freshness: "stale"` and the queued paths retained in `pendingFiles`. The runtime schedules another debounced flush, so stopping the event storm permits eventual convergence without blocking `before_agent_start` indefinitely.
