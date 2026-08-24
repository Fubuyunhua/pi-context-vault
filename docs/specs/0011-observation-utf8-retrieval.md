# 0011: UTF-8-safe observation retrieval and complete-line search

## Status

Accepted for issue #35.

## Problem

Observation query mode previously clipped each line before testing it for a query. A match after the excerpt boundary was therefore invisible. Raw byte retrieval also decoded the requested byte range directly, so a range beginning or ending inside a multibyte UTF-8 sequence could fabricate a U+FFFD replacement character that was not present in the archived evidence.

## Byte-range retrieval

`context_vault_obs_get` continues to interpret `offset` and `limit` as UTF-8 byte positions when `query` is absent. `limit` remains capped at 32 KiB.

The requested half-open range is `[offset, offset + limit)`. Retrieval aligns inward without decoding partial code points:

- a start on a UTF-8 continuation byte advances to the next code-point boundary;
- an end inside a UTF-8 sequence retreats to the preceding boundary;
- returned text never exceeds the effective byte limit and never gains a fabricated U+FFFD;
- an effective limit too small for the next complete code point may return an empty range;
- `truncated` is true exactly when `byteEnd` is before the sanitized content's byte length.

The evidence object reports:

- `byteOffset`: the legacy alias retaining the requested offset;
- `requestedByteOffset`: the caller's requested offset;
- `byteStart`: the actual aligned inclusive byte start;
- `byteEnd`: the actual aligned exclusive byte end.

Callers should use `byteEnd` as the next page's offset. Requests at the exact content end return an empty, non-truncated page. Requests beyond the sanitized content byte length are rejected. In query mode, `offset` remains a zero-based match-page offset and may be beyond the number of matches.

## Query matching and excerpts

Both observation-local query mode and project-wide observation search test the complete sanitized line before producing an excerpt. A matching line is clipped only after the match is known. Oversized returned excerpts are centered around the first match where the match fits, are clipped only at UTF-8 boundaries, and remain capped at 2 KiB for `context_vault_obs_get` and 1 KiB per project-wide search match.

Local query pages remain capped at 20 matches. Project-wide search remains capped at 20 observations and five excerpts per observation. Implementations may stop after finding the first result beyond a requested page because that is sufficient to report `truncated`; they do not accumulate an unbounded match list. Result ordering remains archived-line order locally and reverse metadata order project-wide.

Search operates only on the persisted sanitized artifact. Match-centered excerpts cannot recover text removed by secret redaction.

## Compatibility and limits

Observation IDs, artifact-hash lookup, literal case-insensitive queries, line numbering, tool-name filtering, redaction, and existing input validation remain unchanged. `byteOffset` is retained for consumers of the old response shape; the additional range fields disambiguate requested and actual positions.

This change bounds returned evidence, not artifact size. Searching an individual stored artifact necessarily inspects its complete content so a late match is discoverable. Line scanning and output collection are deterministic and bounded by the persisted content, the requested page, and the fixed result caps.
