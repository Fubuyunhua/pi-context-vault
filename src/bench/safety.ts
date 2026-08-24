const CREDENTIAL_LABEL =
  /(?:^|[^a-z0-9])(?:api[_-]?key|(?:access|auth|authorization|refresh)[_-]?token|authorization|token|bearer|password|passwd|secret|credentials?|private[_-]?key|userinfo)(?:$|[^a-z0-9])/iu;

const BARE_SECRET_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:A3T|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{20,})\b/u,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
] as const;

const HOST_PATH_PATTERNS = [
  /file:(?:\/{2,}|\\{2,})/iu,
  /(?:^|[^A-Za-z0-9/])\/{1,}[^\s"')\]}]*/u,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/][^\s"']*/u,
  /(?:^|[^\\])\\\\(?:[?.]\\)?[^\s"']+/u,
] as const;

export function containsCredentialMaterial(value: string): boolean {
  return CREDENTIAL_LABEL.test(value) || BARE_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export function containsHostPath(value: string): boolean {
  return HOST_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

export function assertSafePersistedIdentifier(value: string, label: string): string {
  if (/\p{Cc}/u.test(value)) throw new Error(`${label} contains control characters`);
  if (containsHostPath(value)) throw new Error(`${label} contains a host path or file URL`);
  if (containsCredentialMaterial(value))
    throw new Error(`${label} contains credential, token, or private-key material`);
  return value;
}
