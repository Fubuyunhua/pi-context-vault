/** Bounded Vault-only runtime telemetry. No repository content or per-request rows are retained. */
function finiteNonnegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface TelemetrySnapshot {
  archiveAttemptCount: number;
  archiveSuccessCount: number;
  archiveFailureCount: number;
  archiveDeduplicatedCount: number;
  archiveDurationMsTotal: number;
  metadataReadDurationMsTotal: number;
  metadataWriteDurationMsTotal: number;
  metadataTailSyncCount: number;
  metadataTailBytesRead: number;
  metadataFullRebuildCount: number;
  metadataFullRebuildDurationMsTotal: number;
  metadataAppendCount: number;
  metadataBytesAppended: number;
  metadataTombstoneCount: number;
  metadataTornTailRecoveryCount: number;
  metadataTornBytesDiscarded: number;
  metadataCompactionCount: number;
  metadataCompactionFailureCount: number;
  metadataCompactionDurationMsTotal: number;
  metadataCompactionBytesBefore: number;
  metadataCompactionBytesAfter: number;
  artifactGcFailureCount: number;
  observationSearchCount: number;
  observationSearchCandidateCount: number;
  observationSearchArtifactReadCount: number;
  observationSearchUnavailableCount: number;
  observationSearchHydrationReadCount: number;
  observationSearchDurationMsTotal: number;
  reductionInvocationCount: number;
  reductionTriggeredCount: number;
  reducedObservationCount: number;
  estimatedTokensBeforeTotal: number;
  estimatedTokensAfterTotal: number;
  targetReachedCount: number;
  reductionDurationMsTotal: number;
}

export class Telemetry {
  #values: TelemetrySnapshot = {
    archiveAttemptCount: 0,
    archiveSuccessCount: 0,
    archiveFailureCount: 0,
    archiveDeduplicatedCount: 0,
    archiveDurationMsTotal: 0,
    metadataReadDurationMsTotal: 0,
    metadataWriteDurationMsTotal: 0,
    metadataTailSyncCount: 0,
    metadataTailBytesRead: 0,
    metadataFullRebuildCount: 0,
    metadataFullRebuildDurationMsTotal: 0,
    metadataAppendCount: 0,
    metadataBytesAppended: 0,
    metadataTombstoneCount: 0,
    metadataTornTailRecoveryCount: 0,
    metadataTornBytesDiscarded: 0,
    metadataCompactionCount: 0,
    metadataCompactionFailureCount: 0,
    metadataCompactionDurationMsTotal: 0,
    metadataCompactionBytesBefore: 0,
    metadataCompactionBytesAfter: 0,
    artifactGcFailureCount: 0,
    observationSearchCount: 0,
    observationSearchCandidateCount: 0,
    observationSearchArtifactReadCount: 0,
    observationSearchUnavailableCount: 0,
    observationSearchHydrationReadCount: 0,
    observationSearchDurationMsTotal: 0,
    reductionInvocationCount: 0,
    reductionTriggeredCount: 0,
    reducedObservationCount: 0,
    estimatedTokensBeforeTotal: 0,
    estimatedTokensAfterTotal: 0,
    targetReachedCount: 0,
    reductionDurationMsTotal: 0,
  };

  snapshot(): TelemetrySnapshot {
    return { ...this.#values };
  }
  recordArchiveStarted(): void {
    this.#values.archiveAttemptCount += 1;
  }
  recordArchiveSucceeded(durationMs: number, deduplicated: boolean): void {
    this.#values.archiveSuccessCount += 1;
    this.#values.archiveDurationMsTotal += finiteNonnegative(durationMs);
    if (deduplicated) this.#values.archiveDeduplicatedCount += 1;
  }
  recordArchiveFailed(durationMs: number): void {
    this.#values.archiveFailureCount += 1;
    this.#values.archiveDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordMetadataRead(durationMs: number): void {
    this.#values.metadataReadDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordMetadataWrite(durationMs: number): void {
    this.#values.metadataWriteDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordMetadataTailSync(bytesRead: number): void {
    this.#values.metadataTailSyncCount += 1;
    this.#values.metadataTailBytesRead += finiteNonnegative(bytesRead);
  }
  recordMetadataFullRebuild(durationMs: number): void {
    this.#values.metadataFullRebuildCount += 1;
    this.#values.metadataFullRebuildDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordMetadataAppend(bytesAppended: number, tombstones: number): void {
    this.#values.metadataAppendCount += 1;
    this.#values.metadataBytesAppended += finiteNonnegative(bytesAppended);
    this.#values.metadataTombstoneCount += finiteNonnegative(tombstones);
  }
  recordMetadataTornTailRecovery(bytesDiscarded: number): void {
    this.#values.metadataTornTailRecoveryCount += 1;
    this.#values.metadataTornBytesDiscarded += finiteNonnegative(bytesDiscarded);
  }
  recordMetadataCompaction(durationMs: number, bytesBefore: number, bytesAfter: number): void {
    this.#values.metadataCompactionCount += 1;
    this.#values.metadataCompactionDurationMsTotal += finiteNonnegative(durationMs);
    this.#values.metadataCompactionBytesBefore = finiteNonnegative(bytesBefore);
    this.#values.metadataCompactionBytesAfter = finiteNonnegative(bytesAfter);
  }
  recordMetadataCompactionFailure(): void {
    this.#values.metadataCompactionFailureCount += 1;
  }
  recordArtifactGcFailure(): void {
    this.#values.artifactGcFailureCount += 1;
  }
  recordObservationSearch(input: {
    durationMs: number;
    candidates: number;
    artifactReads: number;
    unavailable: number;
    hydrationReads: number;
  }): void {
    this.#values.observationSearchCount += 1;
    this.#values.observationSearchCandidateCount += finiteNonnegative(input.candidates);
    this.#values.observationSearchArtifactReadCount += finiteNonnegative(input.artifactReads);
    this.#values.observationSearchUnavailableCount += finiteNonnegative(input.unavailable);
    this.#values.observationSearchHydrationReadCount += finiteNonnegative(input.hydrationReads);
    this.#values.observationSearchDurationMsTotal += finiteNonnegative(input.durationMs);
  }
  recordReduction(input: {
    durationMs: number;
    triggered: boolean;
    reducedCount: number;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    targetReached: boolean;
  }): void {
    this.#values.reductionInvocationCount += 1;
    if (input.triggered) this.#values.reductionTriggeredCount += 1;
    this.#values.reducedObservationCount += finiteNonnegative(input.reducedCount);
    this.#values.estimatedTokensBeforeTotal += finiteNonnegative(input.estimatedTokensBefore);
    this.#values.estimatedTokensAfterTotal += finiteNonnegative(input.estimatedTokensAfter);
    if (input.targetReached) this.#values.targetReachedCount += 1;
    this.#values.reductionDurationMsTotal += finiteNonnegative(input.durationMs);
  }
}
