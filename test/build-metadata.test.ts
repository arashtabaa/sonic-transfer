import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'
import { createBuildMetadata, normalizeBuildSha } from '../app/config/build-metadata'

describe('build metadata', () => {
  it('uses the root package version as the application version', () => {
    const metadata = createBuildMetadata(packageJson.version, '2958b86525095b564490cce6ed99e30071a4ce93')

    expect(metadata.version).toBe(packageJson.version)
    expect(`Sonic Transfer v${metadata.version}`).toContain(`v${packageJson.version}`)
  })

  it('injects the first seven characters of a provided commit SHA', () => {
    expect(normalizeBuildSha('2958b86525095b564490cce6ed99e30071a4ce93')).toBe('2958b86')
  })

  it('reports unknown when Git metadata is unavailable', () => {
    expect(createBuildMetadata(packageJson.version, undefined).buildSha).toBe('unknown')
    expect(normalizeBuildSha('')).toBe('unknown')
  })
})
