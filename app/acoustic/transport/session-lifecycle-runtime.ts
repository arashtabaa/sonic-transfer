import { AcousticFrameType, decodeTransferEnd, decodeTransferPoll, decodeTransferStatus, type AcousticFrame } from '../protocol/frame'

export interface CachedTransferCompletion {
  transferSessionId: number
  expectedSha256: string
  actualSha256: string
  blocksReceived: number
  completedAt: number
}

export class TransferCompletionCache {
  private completion: CachedTransferCompletion | null = null
  constructor(private readonly graceMs = 30_000, private readonly now: () => number = () => Date.now()) {}
  remember(completion: CachedTransferCompletion): void { this.completion = { ...completion } }
  forPoll(outerSessionId: number, pollSessionId: number): CachedTransferCompletion | null {
    if (!this.completion || this.now() - this.completion.completedAt > this.graceMs || outerSessionId !== pollSessionId || pollSessionId !== this.completion.transferSessionId) return null
    return { ...this.completion }
  }
  activateNewSession(sessionId: number): void { if (this.completion && this.completion.transferSessionId !== sessionId) this.completion = null }
  clear(): void { this.completion = null }
}

export class SessionLifecycleRuntime {
  controlSessionId: number | null = null
  verificationSessionId: number | null = null
  activeTransferSessionId: number | null = null

  beginControl(sessionId: number): void { this.controlSessionId = sessionId }
  bindVerification(sessionId: number): void { this.verificationSessionId = sessionId }
  beginTransfer(sessionId: number): void { this.activeTransferSessionId = sessionId }

  acceptFrame(sessionId: number, frameType: AcousticFrameType): boolean {
    if (frameType === AcousticFrameType.LINK_PROBE || frameType === AcousticFrameType.LINK_ACK) return this.controlSessionId === null || this.controlSessionId === sessionId
    const verification = [AcousticFrameType.PROFILE_PROPOSE, AcousticFrameType.PROFILE_ACCEPT, AcousticFrameType.PROFILE_REJECT, AcousticFrameType.PROFILE_PROBE_END, AcousticFrameType.CHANNEL_REPORT]
    if (verification.includes(frameType)) return this.verificationSessionId === null || this.verificationSessionId === sessionId
    if (frameType === AcousticFrameType.SESSION_HEADER) return this.activeTransferSessionId === null || this.activeTransferSessionId === sessionId
    const transfer = [AcousticFrameType.DATA, AcousticFrameType.END, AcousticFrameType.TEST_FILE_START, AcousticFrameType.TEST_FILE_COMPLETE, AcousticFrameType.TRANSFER_POLL, AcousticFrameType.TRANSFER_STATUS, AcousticFrameType.TRANSFER_END]
    if (!transfer.includes(frameType)) return true
    return this.activeTransferSessionId !== null && this.activeTransferSessionId === sessionId
  }

  acceptFeedbackFrame(frame: AcousticFrame): boolean {
    if (![AcousticFrameType.TRANSFER_POLL, AcousticFrameType.TRANSFER_STATUS, AcousticFrameType.TRANSFER_END].includes(frame.frameType)) return false
    if (this.activeTransferSessionId === null || frame.sessionId !== this.activeTransferSessionId) return false
    const payload = frame.frameType === AcousticFrameType.TRANSFER_POLL
      ? decodeTransferPoll(frame.payload)
      : frame.frameType === AcousticFrameType.TRANSFER_STATUS ? decodeTransferStatus(frame.payload) : decodeTransferEnd(frame.payload)
    return payload !== null && payload.transferSessionId === this.activeTransferSessionId
  }

  acquireSessionHeader(sessionId: number): boolean {
    this.activeTransferSessionId = sessionId
    return true
  }

  acceptSenderCompletion(frame: AcousticFrame, expectedSha256: string): boolean {
    if (frame.frameType !== AcousticFrameType.TRANSFER_END || this.activeTransferSessionId === null || frame.sessionId !== this.activeTransferSessionId) return false
    const payload = decodeTransferEnd(frame.payload)
    return !!payload && payload.transferSessionId === this.activeTransferSessionId && payload.expectedSha256 === expectedSha256 && payload.actualSha256 === expectedSha256 && payload.pass
  }
}
