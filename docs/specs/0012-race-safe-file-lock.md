# 0012: Race-safe file locks

## Status

Accepted for implementation by GitHub issue #27.

## Problem

The former lock was a fixed file created before its metadata was durable. Stale recovery inspected that file and later unlinked the fixed pathname. Between those operations another process could replace the lock, allowing a stale recoverer to delete the new owner's lock and admit overlapping holders. An initializer crash could also expose missing or partial metadata.

## Publication protocol

`withFileLock` retains its public API, option validation, timeout error, heartbeat, and operation-release behavior. The fixed lock pathname is now a directory.

Each claimant generates an owner UUID and prepares a unique sibling directory. It creates exactly one immutable `owner-<UUID>.json` file containing the schema version, UUID, PID, hostname, and creation time. The claimant writes and fsyncs that file, closes it, and fsyncs the preparation directory where the platform supports directory sync. Only then does it atomically rename the non-empty preparation directory to the fixed lock pathname and sync the parent directory. Acquisition never publishes an empty directory or partially written owner record.

Before every publication attempt, the claimant uses `lstat` to inspect the fixed target. An existing real directory is contention and may be considered for owner-safe stale recovery. A legacy file, symlink, or any other object fails safe until timeout, and `rename` is not called while that object is observed. This preflight is required on Windows, where renaming a directory can replace a file at the destination.

A rename collision after a missing-target preflight is also contention. POSIX `EEXIST`, `ENOTEMPTY`, and `ENOTDIR` are recognized. Windows `EPERM` from directory publication is retried even if the winning target has already disappeared before inspection; repeated `EPERM` failures with no target remain bounded by the normal timeout, so a persistent permission failure cannot spin forever or enter the critical section. Preparation cleanup removes only the claimant's exact UUID file and its unique directory. A crashed preparation remains outside the fixed pathname and cannot block acquisition or cause another claimant to delete unrelated content.

Before preparing a claimant, acquisition conservatively reaps well-formed preparation directories older than 24 hours only when their metadata names this host and their PID is demonstrably dead. Fresh preparations, live or indeterminate PIDs, foreign hosts, malformed records, symlinks, and unexpected contents are retained. This bounds normal local crash debris without risking an active or unidentifiable preparation.

## Heartbeat and release

The owner record's contents never change. The heartbeat updates only the exact `owner-<UUID>.json` pathname. Release unlinks only that exact pathname and then removes the now-empty fixed directory.

If another process removes the empty directory and publishes a replacement between those steps, its owner filename differs. The old release cannot unlink it, and removal of the replacement non-empty directory fails safely. The same identity rule applies to delayed heartbeat calls. After release or stale recovery successfully removes the fixed lock directory, the parent directory is fsynced where supported so the removal cannot be resurrected by an otherwise-successful power-loss recovery.

## Stale recovery

A valid fixed lock directory contains exactly one non-symlink regular owner file whose UUID agrees with valid metadata. Before opening metadata, recovery uses `lstat` to reject every other object and records its identity and size. Metadata is limited to 4 KiB. Where supported, the handle is opened with no-follow and nonblocking flags; its post-open identity and type must still match, and parsing uses only a bounded handle read. This makes FIFO and symlink substitution fail safe and prevents pathname swaps from turning validation into an arbitrary-target read. Recovery uses the validated handle's owner-file mtime as the heartbeat age and considers takeover only after `staleMs`.

For metadata naming the local hostname, PID liveness is checked before takeover. Only `ESRCH` demonstrates that an owner is dead. A live PID is protected even if its heartbeat is old, covering suspension and host sleep. `EPERM`, other indeterminate liveness results, a hostname mismatch, PID reuse by a live process, malformed metadata, legacy fixed lock files, symlinks, and unexpected directory contents all fail safe until timeout. This deliberately bounded behavior never guesses that an unidentifiable owner is dead.

A stale recoverer unlinks only the exact old UUID filename and then removes the empty directory. Multiple recoverers may attempt those same operations. If one publishes a replacement before another's `rmdir`, the replacement is non-empty and survives. A crash after unlinking the old owner can leave an empty fixed directory; any waiter may remove that empty directory and retry. On POSIX the atomic rename may itself replace an empty directory, while the explicit empty-directory recovery supports Windows semantics.

## Durability and filesystem scope

The protocol targets local Linux, macOS, and Windows filesystems with atomic same-parent directory rename. File data is fsynced before publication. Directory fsync errors that indicate unsupported platform behavior are tolerated consistently with atomic state writes; other sync failures are surfaced and an acquired lock is released owner-safely.

All contenders must share the local filesystem, hostname view, and PID namespace used for liveness checks. Network/shared filesystems, containers with different PID namespaces, and filesystems with weaker rename or cache-coherency semantics are outside this guarantee. Malformed non-empty locks require operator intervention rather than unsafe age-only deletion.

The fixed-target preflight also defines the legacy migration boundary. It protects a legacy lock file that is already present when a new claimant inspects the path, but Node.js exposes no portable atomic rename-if-absent primitive. On Windows, an uncoordinated legacy writer that creates a fixed lock file in the interval between the new claimant's missing-target preflight and directory rename can still be replaced. Deployments must therefore avoid running legacy file-lock writers concurrently with directory-protocol writers during migration. Same-protocol claimants remain protected because their published targets are non-empty directories, which directory rename does not replace.

## Regression coverage

Tests cover non-empty publication, deterministic two-waiter stale recovery, replacement survival, empty-directory recovery, conservative preparation-orphan cleanup, live suspended owners, dead owners, conservative PID reuse, malformed/oversized metadata, FIFO and symlink rejection, file-swap races, timeout, heartbeat, owner-aware release, Linux collision codes, Windows-style legacy-file replacement, and mocked Windows `EEXIST`/`EPERM`/`ENOTEMPTY` behavior including a target that disappears after `EPERM`. Subprocess stress exercises the lock through artifact metadata writes and repository-map activation on Linux, macOS, and Windows CI.
