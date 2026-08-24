/**
 * Bounded runtime telemetry for Context Vault.
 *
 * Every metric is a plain JS number (counter, total, or last-value scalar).
 * No per-request records, no arrays, no raw content. `snapshot()` returns a
 * fresh copy so callers can never mutate the live counters. Recording is
 * plain arithmetic and cannot throw, so telemetry can never degrade the
 * extension.
 */

function finiteNonnegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

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
  /** Git HEAD subprocess attempts, including failures. */
  gitHeadCount: number;
  gitHeadDurationMsTotal: number;
  /** Git dirty/status subprocess attempts, including failures. */
  gitDirtyCount: number;
  gitDirtyDurationMsTotal: number;
  /** Git diff subprocess attempts, including failures. */
  gitDiffCount: number;
  gitDiffDurationMsTotal: number;
  /** MiniSearch index builds, including failed construction attempts. */
  searchIndexBuildCount: number;
  searchIndexBuildDurationMsTotal: number;
  // Generation
  /** Generation file plus active-pointer write attempts, including failures. */
  generationWriteCount: number;
  generationWriteDurationMsTotal: number;
  /** Generations whose active pointer was successfully persisted. */
  generationCreatedCount: number;
  /** Cumulative bytes of successfully persisted generation files, including later orphans. */
  generationBytesWritten: number;
  /** Running estimate of generation bytes on disk; reconciled using the flat generation directory. */
  repoMapTotalBytes: number;
  /** Generation-pruning attempts, including failures. */
  generationPruneCount: number;
  generationPruneDurationMsTotal: number;
  generationPrunedFiles: number;
  generationPrunedBytes: number;
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
  #gitHeadCount = 0;
  #gitHeadDurationMsTotal = 0;
  #gitDirtyCount = 0;
  #gitDirtyDurationMsTotal = 0;
  #gitDiffCount = 0;
  #gitDiffDurationMsTotal = 0;
  #searchIndexBuildCount = 0;
  #searchIndexBuildDurationMsTotal = 0;
  #generationWriteCount = 0;
  #generationWriteDurationMsTotal = 0;
  #generationCreatedCount = 0;
  #generationBytesWritten = 0;
  #repoMapTotalBytes = 0;
  #generationPruneCount = 0;
  #generationPruneDurationMsTotal = 0;
  #generationPrunedFiles = 0;
  #generationPrunedBytes = 0;
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
      gitHeadCount: this.#gitHeadCount,
      gitHeadDurationMsTotal: this.#gitHeadDurationMsTotal,
      gitDirtyCount: this.#gitDirtyCount,
      gitDirtyDurationMsTotal: this.#gitDirtyDurationMsTotal,
      gitDiffCount: this.#gitDiffCount,
      gitDiffDurationMsTotal: this.#gitDiffDurationMsTotal,
      searchIndexBuildCount: this.#searchIndexBuildCount,
      searchIndexBuildDurationMsTotal: this.#searchIndexBuildDurationMsTotal,
      generationWriteCount: this.#generationWriteCount,
      generationWriteDurationMsTotal: this.#generationWriteDurationMsTotal,
      generationCreatedCount: this.#generationCreatedCount,
      generationBytesWritten: this.#generationBytesWritten,
      repoMapTotalBytes: this.#repoMapTotalBytes,
      generationPruneCount: this.#generationPruneCount,
      generationPruneDurationMsTotal: this.#generationPruneDurationMsTotal,
      generationPrunedFiles: this.#generationPrunedFiles,
      generationPrunedBytes: this.#generationPrunedBytes,
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

  recordGitHead(durationMs: number): void {
    this.#gitHeadCount += 1;
    this.#gitHeadDurationMsTotal += finiteNonnegative(durationMs);
  }

  recordGitDirty(durationMs: number): void {
    this.#gitDirtyCount += 1;
    this.#gitDirtyDurationMsTotal += finiteNonnegative(durationMs);
  }

  recordGitDiff(durationMs: number): void {
    this.#gitDiffCount += 1;
    this.#gitDiffDurationMsTotal += finiteNonnegative(durationMs);
  }

  recordSearchIndexBuild(durationMs = 0): void {
    this.#searchIndexBuildCount += 1;
    this.#searchIndexBuildDurationMsTotal += finiteNonnegative(durationMs);
  }

  recordGenerationWrite(durationMs: number): void {
    this.#generationWriteCount += 1;
    this.#generationWriteDurationMsTotal += finiteNonnegative(durationMs);
  }

  recordGenerationFileWritten(bytesWritten: number): void {
    const bytes = finiteNonnegative(bytesWritten);
    this.#generationBytesWritten += bytes;
    this.#repoMapTotalBytes += bytes;
  }

  recordGenerationActivated(): void {
    this.#generationCreatedCount += 1;
  }

  /** Backward-compatible combined success recorder for callers that activate immediately after writing. */
  recordGenerationCreated(bytesWritten: number): void {
    this.recordGenerationFileWritten(bytesWritten);
    this.recordGenerationActivated();
  }

  recordRepoMapTotalBytes(totalBytes: number): void {
    this.#repoMapTotalBytes = finiteNonnegative(totalBytes);
  }

  recordGenerationPrune(durationMs: number, filesPruned: number, bytesPruned: number): void {
    const files = finiteNonnegative(filesPruned);
    const bytes = finiteNonnegative(bytesPruned);
    this.#generationPruneCount += 1;
    this.#generationPruneDurationMsTotal += finiteNonnegative(durationMs);
    this.#generationPrunedFiles += files;
    this.#generationPrunedBytes += bytes;
    this.#repoMapTotalBytes = Math.max(0, this.#repoMapTotalBytes - bytes);
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
