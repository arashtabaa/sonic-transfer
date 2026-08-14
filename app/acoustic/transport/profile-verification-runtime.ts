import type { ChannelReportPayload, ProfileVerificationClass } from '../protocol/frame'

export type VerificationFailureReason = 'PROFILE_ACCEPT_TIMEOUT' | 'PROBE_WINDOW_TIMEOUT' | 'CHANNEL_REPORT_TIMEOUT' | string

export interface VerifiedProfileIdentity {
  profile: string
  configFingerprint: string
  nonce: number
}

export class ProfileProbeLedger {
  private readonly sequences = new Set<number>()
  constructor(private readonly identity: VerifiedProfileIdentity, private readonly total: number) {}
  record(probe: { sessionId: number; verificationNonce: number; profile: string; probeSequence: number }, sessionId: number): 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' {
    if (probe.sessionId !== sessionId || probe.verificationNonce !== this.identity.nonce || probe.profile !== this.identity.profile || probe.probeSequence < 1 || probe.probeSequence > this.total) return 'REJECTED'
    if (this.sequences.has(probe.probeSequence)) return 'DUPLICATE'
    this.sequences.add(probe.probeSequence)
    return 'ACCEPTED'
  }
  get uniqueDetected(): number { return this.sequences.size }
  get missing(): number { return this.total - this.sequences.size }
}

/** Testable lifecycle primitive used to keep production verification finite and identity-bound. */
export class ProfileVerificationRuntime {
  private timer: ReturnType<typeof setTimeout> | null = null
  private resolver: ((ready: boolean) => void) | null = null
  private identity: VerifiedProfileIdentity | null = null

  public begin(identity: VerifiedProfileIdentity, phase: 'ACCEPT' | 'REPORT', timeoutMs: number): Promise<boolean> {
    this.cancel()
    this.identity = identity
    const result = new Promise<boolean>(resolve => { this.resolver = resolve })
    this.timer = setTimeout(() => this.fail(phase === 'ACCEPT' ? 'PROFILE_ACCEPT_TIMEOUT' : 'CHANNEL_REPORT_TIMEOUT'), timeoutMs)
    return result
  }

  public accept(identity: VerifiedProfileIdentity): void {
    if (!this.matches(identity)) return
    this.clearTimer()
    this.timer = setTimeout(() => this.fail('PROBE_WINDOW_TIMEOUT'), 10000)
  }

  public report(report: ChannelReportPayload): boolean {
    if (!this.identity || report.profile !== this.identity.profile || report.configFingerprint !== this.identity.configFingerprint || report.verificationNonce !== this.identity.nonce) return false
    const expected: ProfileVerificationClass = report.crcValid / report.attemptedProbes >= 0.9 ? 'READY' : report.crcValid / report.attemptedProbes >= 0.6 ? 'MARGINAL' : 'FAILED'
    if (report.classification !== expected) return false
    this.finish(expected === 'READY')
    return true
  }

  public reject(reason: VerificationFailureReason): void { this.fail(reason) }
  public cancel(): void { this.clearTimer(); const resolver = this.resolver; this.resolver = null; this.identity = null; resolver?.(false) }
  public getIdentity(): VerifiedProfileIdentity | null { return this.identity }

  private fail(_reason: VerificationFailureReason): void { this.finish(false) }
  private finish(ready: boolean): void {
    this.clearTimer()
    const resolver = this.resolver
    this.resolver = null
    resolver?.(ready)
  }
  private matches(identity: VerifiedProfileIdentity): boolean { return !!this.identity && JSON.stringify(identity) === JSON.stringify(this.identity) }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }
}
