import { describe, expect, it } from 'vitest'
import { ProfileProbeLedger, ProfileVerificationRuntime } from '../app/acoustic'

const identity = { profile: 'turbo', configFingerprint: 'fingerprint-1', nonce: 10 }
const report = (valid: number, classification: 'READY' | 'MARGINAL' | 'FAILED' = valid >= 27 ? 'READY' : valid >= 18 ? 'MARGINAL' : 'FAILED') => ({ protocolVersion: 1, sessionId: 1, verificationNonce: 10, profile: 'turbo', attemptedProbes: 30, framesDetected: valid, crcValid: valid, crcInvalid: 30 - valid, per: 1 - valid / 30, classification, sampleRate: 44100, configFingerprint: 'fingerprint-1' })

describe('finite production verification lifecycle', () => {
  it('settles READY and FAILED reports only when identity and classification match', async () => {
    const runtime = new ProfileVerificationRuntime()
    const ready = runtime.begin(identity, 'ACCEPT', 1000)
    runtime.accept(identity)
    expect(runtime.report(report(30))).toBe(true)
    await expect(ready).resolves.toBe(true)

    const failed = runtime.begin(identity, 'ACCEPT', 1000)
    runtime.accept(identity)
    expect(runtime.report(report(5))).toBe(true)
    await expect(failed).resolves.toBe(false)
  })

  it('settles finite timeout, reject, and ignores stale reports', async () => {
    const runtime = new ProfileVerificationRuntime()
    const timeout = runtime.begin(identity, 'ACCEPT', 10)
    await expect(timeout).resolves.toBe(false)
    const rejected = runtime.begin(identity, 'ACCEPT', 1000)
    runtime.reject('PROFILE_REJECT')
    await expect(rejected).resolves.toBe(false)
    const stale = runtime.begin(identity, 'ACCEPT', 1000)
    expect(runtime.report({ ...report(30), verificationNonce: 99 })).toBe(false)
    runtime.cancel()
    expect(runtime.getIdentity()).toBeNull()
    await expect(stale).resolves.toBe(false)
  })

  it('counts unique probes and rejects wrong session, nonce, profile, and range', () => {
    const ledger = new ProfileProbeLedger(identity, 3)
    const probe = (sequence: number, overrides: Partial<{ sessionId: number; verificationNonce: number; profile: string }> = {}) => ({ sessionId: 1, verificationNonce: 10, profile: 'turbo', probeSequence: sequence, ...overrides })
    expect(ledger.record(probe(1), 1)).toBe('ACCEPTED')
    expect(ledger.record(probe(1), 1)).toBe('DUPLICATE')
    expect(ledger.record(probe(2, { verificationNonce: 99 }), 1)).toBe('REJECTED')
    expect(ledger.record(probe(2, { sessionId: 9 }), 1)).toBe('REJECTED')
    expect(ledger.record(probe(2, { profile: 'balanced' }), 1)).toBe('REJECTED')
    expect(ledger.record(probe(4), 1)).toBe('REJECTED')
    expect(ledger.uniqueDetected).toBe(1)
    expect(ledger.missing).toBe(2)
  })
})
