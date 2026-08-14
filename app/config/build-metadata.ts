export interface BuildMetadata {
  version: string
  buildSha: string
  mode: string
}

export function normalizeBuildSha(commitSha?: string | null): string {
  const normalized = commitSha?.trim()
  return normalized ? normalized.slice(0, 7) : 'unknown'
}

export function createBuildMetadata(version: string, commitSha?: string | null, mode = 'unknown'): BuildMetadata {
  return {
    version,
    buildSha: normalizeBuildSha(commitSha),
    mode: mode || 'unknown',
  }
}
