import { AcousticFrameType } from '../protocol/frame'

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
    if (frameType === AcousticFrameType.SESSION_HEADER) return true
    const transfer = [AcousticFrameType.DATA, AcousticFrameType.END, AcousticFrameType.TEST_FILE_START, AcousticFrameType.TEST_FILE_COMPLETE]
    if (!transfer.includes(frameType)) return true
    return this.activeTransferSessionId !== null && this.activeTransferSessionId === sessionId
  }

  acquireSessionHeader(sessionId: number): boolean {
    this.activeTransferSessionId = sessionId
    return true
  }
}
