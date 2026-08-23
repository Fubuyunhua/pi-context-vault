# 0008: Observation archive policy and reference-safe GC

## Status

Accepted for issue #30.

## Problem

Context Vault previously archived every textual tool result and used `archiveThresholdBytes` only to decide whether the model-visible result should become a receipt. This durably stored low-value short results. Artifact garbage collection also ran without enumerating receipts in the active Pi session, so retention or quota pressure could create dangling receipts.

## Archive eligibility

The archive decision uses the original tool-result UTF-8 byte length and is made before secret redaction, hashing, metadata reads, or any storage call.

- `archivePolicy: "all"` archives every textual result. This is the default and preserves existing behavior.
- `archivePolicy: "errors-and-large"` archives results whose original byte length is greater than or equal to `archiveMinBytes`. It also archives shorter error results when `archiveErrorsAlways` is `true`.
- `archivePolicy: "off"` archives nothing. `off` is absolute, including for errors; `archiveErrorsAlways` does not override it.

`archiveMinBytes` defaults to 16 KiB and permits zero. `archiveErrorsAlways` defaults to `true`. Boundaries are measured with `Buffer.byteLength(text, "utf8")`, so multibyte text follows the same byte-exact rules as ASCII.

An ineligible result remains unchanged in Pi's canonical conversation. Because no artifact or metadata is created, that result cannot be found by Context Vault observation search/retrieval and cannot later be replaced by Context Vault context reduction. Choosing a selective or off policy therefore trades durable search and reduction capability for lower storage use.

## Replacement and durability

`replacementThresholdBytes` defaults to 16 KiB and is independent of archive eligibility. An eligible result is replaced only when its original UTF-8 byte length is strictly greater than this threshold. Equality is not replaced, preserving the former boundary behavior.

Replacement happens only after the artifact content and metadata record have been durably archived. If archival fails, or if receipt materialization fails after archival, Context Vault returns no replacement and Pi retains the original tool result. A result that is not eligible for archival is never replaced.

## Legacy configuration migration

`archiveThresholdBytes` remains a supported deprecated alias for `replacementThresholdBytes`; it never changes archive eligibility. This matches its historical behavior: all results are archived by the compatible default policy, while only results strictly above the configured legacy threshold are replaced.

The loader normalizes the deprecated and new fields to the same effective value so existing consumers reading `archiveThresholdBytes` continue to see the replacement threshold. Configuring both names in the same project file is rejected, even when their values are equal, rather than silently choosing precedence. Projects should remove the legacy field when adopting `replacementThresholdBytes`.

## Reference-safe artifact garbage collection

Each extension lifecycle registers an owner-tokened, project-local active-session lease under the artifact metadata lock before observation archiving becomes available. Session shutdown/reload releases only its matching owner token. Multiple processes or extension instances may therefore lease the same resumed session independently. Leases whose local process is demonstrably absent may be removed; uncertain liveness remains protected.

Before artifact GC, the extension also uses Pi's read-only session manager APIs:

- `getEntries()` enumerates the canonical append-only session tree, including receipts on non-current branches.
- `getBranch()` enumerates the current leaf path explicitly.
Every valid artifact hash referenced by a Context Vault receipt in those structures is protected. Under the same lock used for deletion, GC reads the lease registry and artifact metadata, then protects every artifact represented by every demonstrably live leased session. This includes metadata archived before a receipt appears in a session branch and concurrent active Pi sessions. Protection is by content hash, so all metadata records sharing a deduplicated artifact remain safe.

Explicit receipt enumeration completes before deletion begins. If receipt sources, lease state, or metadata cannot be read and validated, artifact GC fails without deleting anything. Retention and quota collection exclude protected hashes. When protected evidence alone exceeds the quota, GC returns `quotaSatisfied: false`; it does not delete protected evidence or create dangling receipts.

## Out of scope

Observation search's UTF-8 byte-offset behavior is tracked separately in issue #35. Stale file-lock TOCTOU hardening is tracked in issue #27. This change intentionally does not alter either subsystem.
