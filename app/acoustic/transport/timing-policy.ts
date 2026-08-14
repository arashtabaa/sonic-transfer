export interface HalfDuplexTimingPolicy {
  TX_TO_RX_GUARD_MS: number
  RX_TO_TX_GUARD_MS: number
  POLL_RESPONSE_DELAY_MS: number
  CONTROL_WINDOW_MS: number
  PROFILE_RESPONSE_DELAY_MS: number
}

export const HALF_DUPLEX_TIMING: Readonly<HalfDuplexTimingPolicy> = Object.freeze({
  TX_TO_RX_GUARD_MS: 200,
  RX_TO_TX_GUARD_MS: 200,
  POLL_RESPONSE_DELAY_MS: 200,
  CONTROL_WINDOW_MS: 3000,
  PROFILE_RESPONSE_DELAY_MS: 200,
})

export interface TurnaroundEvent { kind: 'SENDER_RX_READY' | 'FEEDBACK_START'; atMs: number }

export function feedbackStartsAfterSenderReady(senderRxReadyMs: number, feedbackStartMs: number, policy = HALF_DUPLEX_TIMING): boolean {
  return feedbackStartMs >= senderRxReadyMs + policy.RX_TO_TX_GUARD_MS
}
