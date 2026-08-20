/**
 * Bounded runtime telemetry for Context Vault.
 *
 * Every metric is a plain JS number (counter, total, or last-value scalar).
 * No per-request records, no arrays, no raw content. `snapshot()` returns a
 * fresh copy so callers can never mutate the live counters. Recording is
 * plain arithmetic and cannot throw, so telemetry can never degrade the
 * extension.
 */

export interface TelemetrySnapshot {
  // Capsule (automatic context-hook injection)
  capsuleBuildCount: number;
  /** Bytes of the most recently built capsule (last value). */
  capsuleBytes: number;
  /** Builds whose content hash differs from the previous build (first build never counts). */
  capsuleHashChangeCount: number;
  /** Insertion index of the most recently built capsule (last value). */
  capsuleInsertionIndex: number;
  /** Queries issued by the automatic context-hook build path. */
  repoMapAutomaticQueryCount: number;
  // Repo Map
  repoMapQueryCount: number;
  repoMapQueryDurationMsTotal: number;
  ensureFreshCount: number;
  ensureFreshDurationMsTotal: number;
  /** Single-file indexing operations (fast-update and dirty reconciliation). */
  filesReindexed: number;
  /** MiniSearch index builds. */
  searchIndexBuildCount: number;
  // Generation
  generationCreatedCount: number;
  generationBytesWritten: number;
  /** Running estimate of generation bytes on disk; never scanned recursively. */
  repoMapTotalBytes: number;
  maintenanceFailureCount: number;
  // Observation archiving
  archiveAttemptCount: number;
  archiveSuccessCount: number;
  archiveFailureCount: number;
  archiveDeduplicatedCount: number;
  archiveDurationMsTotal: number;
  metadataReadDurationMsTotal: number;
  metadataWriteDurationMsTotal: number;
  // Context reduction
  reductionInvocationCount: number;
  reductionTriggeredCount: number;
  reducedObservationCount: number;
  estimatedTokensBeforeTotal: number;
  estimatedTokensAfterTotal: number;
  targetReachedCount: number;
  reductionDurationMsTotal: number;
}

export class Telemetry {
  #capsuleBuildCount = 0;
  #capsuleBytes = 0;
  #capsuleHashChangeCount = 0;
  #capsuleInsertionIndex = 0;
  #repoMapAutomaticQueryCount = 0;
  #repoMapQueryCount = 0;
  #repoMapQueryDurationMsTotal = 0;
  #ensureFreshCount = 0;
  #ensureFreshDurationMsTotal = 0;
  #filesReindexed = 0;
  #searchIndexBuildCount = 0;
  #generationCreatedCount = 0;
  #generationBytesWritten = 0;
  #repoMapTotalBytes = 0;
  #maintenanceFailureCount = 0;
  #archiveAttemptCount = 0;
  #archiveSuccessCount = 0;
  #archiveFailureCount = 0;
  #archiveDeduplicatedCount = 0;
  #archiveDurationMsTotal = 0;
  #metadataReadDurationMsTotal = 0;
  #metadataWriteDurationMsTotal = 0;
  #reductionInvocationCount = 0;
  #reductionTriggeredCount = 0;
  #reducedObservationCount = 0;
  #estimatedTokensBeforeTotal = 0;
  #estimatedTokensAfterTotal = 0;
  #targetReachedCount = 0;
  #reductionDurationMsTotal = 0;
  #lastCapsuleHash: string | undefined;

  /** Fresh copy; mutations by the caller never affect the live counters. */
  snapshot(): TelemetrySnapshot {
    return {
      capsuleBuildCount: this.#capsuleBuildCount,
      capsuleBytes: this.#capsuleBytes,
      capsuleHashChangeCount: this.#capsuleHashChangeCount,
      capsuleInsertionIndex: this.#capsuleInsertionIndex,
      repoMapAutomaticQueryCount: this.#repoMapAutomaticQueryCount,
      repoMapQueryCount: this.#repoMapQueryCount,
      repoMapQueryDurationMsTotal: this.#repoMapQueryDurationMsTotal,
      ensureFreshCount: this.#ensureFreshCount,
      ensureFreshDurationMsTotal: this.#ensureFreshDurationMsTotal,
      filesReindexed: this.#filesReindexed,
      searchIndexBuildCount: this.#searchIndexBuildCount,
      generationCreatedCount: this.#generationCreatedCount,
      generationBytesWritten: this.#generationBytesWritten,
      repoMapTotalBytes: this.#repoMapTotalBytes,
      maintenanceFailureCount: this.#maintenanceFailureCount,
      archiveAttemptCount: this.#archiveAttemptCount,
      archiveSuccessCount: this.#archiveSuccessCount,
      archiveFailureCount: this.#archiveFailureCount,
      archiveDeduplicatedCount: this.#archiveDeduplicatedCount,
      archiveDurationMsTotal: this.#archiveDurationMsTotal,
      metadataReadDurationMsTotal: this.#metadataReadDurationMsTotal,
      metadataWriteDurationMsTotal: this.#metadataWriteDurationMsTotal,
      reductionInvocationCount: this.#reductionInvocationCount,
      reductionTriggeredCount: this.#reductionTriggeredCount,
      reducedObservationCount: this.#reducedObservationCount,
      estimatedTokensBeforeTotal: this.#estimatedTokensBeforeTotal,
      estimatedTokensAfterTotal: this.#estimatedTokensAfterTotal,
      targetReachedCount: this.#targetReachedCount,
      reductionDurationMsTotal: this.#reductionDurationMsTotal,
    };
  }

  recordCapsuleBuild(bytes: number, insertionIndex: number, contentHash: string): void {
    this.#capsuleBuildCount += 1;
    this.#capsuleBytes = bytes;
    this.#capsuleInsertionIndex = insertionIndex;
    if (this.#lastCapsuleHash !== undefined && this.#lastCapsuleHash !== contentHash) {
      this.#capsuleHashChangeCount += 1;
    }
    this.#lastCapsuleHash = contentHash;
  }

  recordAutomaticQuery(): void {
    this.#repoMapAutomaticQueryCount += 1;
  }

  recordRepoMapQuery(durationMs: number): void {
    this.#repoMapQueryCount += 1;
    this.#repoMapQueryDurationMsTotal += durationMs;
  }

  recordEnsureFresh(durationMs: number): void {
    this.#ensureFreshCount += 1;
    this.#ensureFreshDurationMsTotal += durationMs;
  }

  recordFileReindexed(): void {
    this.#filesReindexed += 1;
  }

  recordSearchIndexBuild(): void {
    this.#searchIndexBuildCount += 1;
  }

  recordGenerationCreated(bytesWritten: number): void {
    this.#generationCreatedCount += 1;
    this.#generationBytesWritten += bytesWritten;
    this.#repoMapTotalBytes += bytesWritten;
  }

  recordRepoMapTotalBytes(totalBytes: number): void {
    this.#repoMapTotalBytes = totalBytes;
  }

  recordMaintenanceFailure(): void {
    this.#maintenanceFailureCount += 1;
  }

  recordArchiveStarted(): void {
    this.#archiveAttemptCount += 1;
  }

  recordArchiveSucceeded(durationMs: number, deduplicated: boolean): void {
    this.#archiveSuccessCount += 1;
    this.#archiveDurationMsTotal += durationMs;
    if (deduplicated) this.#archiveDeduplicatedCount += 1;
  }

  recordArchiveFailed(durationMs: number): void {
    this.#archiveFailureCount += 1;
    this.#archiveDurationMsTotal += durationMs;
  }

  recordMetadataRead(durationMs: number): void {
    this.#metadataReadDurationMsTotal += durationMs;
  }

  recordMetadataWrite(durationMs: number): void {
    this.#metadataWriteDurationMsTotal += durationMs;
  }

  recordReduction(input: {
    durationMs: number;
    triggered: boolean;
    reducedCount: number;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    targetReached: boolean;
  }): void {
    this.#reductionInvocationCount += 1;
    if (input.triggered) this.#reductionTriggeredCount += 1;
    this.#reducedObservationCount += input.reducedCount;
    this.#estimatedTokensBeforeTotal += input.estimatedTokensBefore;
    this.#estimatedTokensAfterTotal += input.estimatedTokensAfter;
    if (input.targetReached) this.#targetReachedCount += 1;
    this.#reductionDurationMsTotal += input.durationMs;
  }
}
