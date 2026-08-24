# 0013 — Append-only observation metadata

Status: accepted

## Decision

`metadata/observations.jsonl` is an append-only recovery log. `ArtifactMetadata` remains the public schema-version-1 API object, while new writers emit version-2 envelopes:

```json
{"schemaVersion":2,"recordType":"upsert","metadata":{"schemaVersion":1,"...":"..."}}
{"schemaVersion":2,"recordType":"tombstone","observationId":"...","artifactId":"<sha256>","deletedAt":"...","reason":"garbage-collection"}
```

Existing version-1 metadata lines are implicit upserts and remain readable. State is keyed by `observationId`; the last committed record wins. A matching tombstone hides an observation, and a later upsert may resurrect it. Secondary artifact, session, and `(sessionId, toolCallId)` lookups follow the same live state.

LF is the commit delimiter. A final byte suffix without LF is uncommitted and ignored by readers. Before mutation, the writer holding the artifact lock truncates such a suffix. Malformed, unsupported, or semantically inconsistent LF-terminated records are committed corruption and fail closed.

## Synchronization and durability

Each `ArtifactStore` maintains the opened file's device/inode identity, validated complete byte offset, record counts, and live indexes. Reads open and stat one handle and consume only bytes after the cached complete offset. Identity replacement or shrink forces a full rebuild. Index publication occurs only after the complete prefix validates. An in-process mutex serializes cache access; mutating paths always acquire the cross-process file lock before that mutex.

Archive publishes the content-addressed artifact first, then appends exactly one v2 upsert and LF, and syncs the metadata handle. It never rewrites the full log. Artifact publication without a committed metadata record leaves a safe orphan.

Garbage collection protects hashes, not individual observations: an explicit reference or any demonstrably active session protects every observation sharing that content hash. For selected hashes, GC appends and syncs tombstones for all live observations in one batch before unlinking artifacts. Orphan files without live metadata need no tombstone. Thus a crash cannot leave durable live metadata pointing to a GC-deleted artifact.

## Compaction

Compaction runs under the artifact lock only when all defaults are met:

- log size at least 4 MiB;
- at least 1024 obsolete records; and
- obsolete records are at least 25% of committed records.

It atomically replaces the log with one v2 upsert per live observation in current live order and fully rebuilds indexes from the replacement. Thresholds and durability fault hooks are constructor-level test seams, not user configuration. A compaction failure after a committed archive or GC tombstone batch is non-fatal maintenance failure; subsequent identity synchronization recovers authoritative state.

## Upgrade boundary

Upgrade all writer processes together. New code can read old v1 logs and migrates lazily through normal v2 appends (or compaction); no eager rewrite is required. Old binaries do not understand v2 envelopes or tombstones, so concurrent old/new writers are unsupported. Rollback to an old writer requires first stopping all writers and exporting the current live state in the legacy format.

## Telemetry

Metadata telemetry is bounded numeric state only: tail sync/read bytes, rebuild count/duration, append count/bytes, tombstones, torn-tail recovery/discarded bytes, and compaction count/failures/duration/before-after bytes. It never records paths, identifiers, or content.
