import { describe, expect, it } from 'vitest'
import { buildVerifiedDataProfileConfig, fingerprintVerifiedDataProfile, getProfileConfig, ModemProfileKey } from '../app/acoustic'

describe('verified product DATA config', () => {
  it('keeps calibrated gain in the proposed and verified config fingerprint', () => {
    const profile = ModemProfileKey.BALANCED
    const config = buildVerifiedDataProfileConfig(profile, 48000, 0.42)
    const fingerprint = fingerprintVerifiedDataProfile(profile, 48000, config)
    expect(config.gain).toBe(0.42)
    expect(fingerprint).toContain('"gain":0.42')
    expect(fingerprintVerifiedDataProfile(profile, 48000, { ...getProfileConfig(profile, 48000), gain: 0.42 })).toBe(fingerprint)
  })
})
