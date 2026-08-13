import { blockToBinary, binaryToBlock, type EncodedBlock } from 'luby-transform'
import {
  AcousticFrameType,
  decodeFrame,
  encodeFrame,
  encodeSessionHeader,
  decodeSessionHeader,
  type AcousticFrame,
  type SessionHeaderPayload,
} from '../protocol/frame'

export class AcousticPacketizer {
  private sessionId: number
  private sequenceCounter = 0

  constructor(sessionId?: number) {
    this.sessionId = sessionId || Math.floor(Math.random() * 0xFFFFFFFF) >>> 0
  }

  public getSessionId(): number {
    return this.sessionId
  }

  /**
   * Packetize a Session Header Payload into an acoustic frame byte buffer.
   */
  public createSessionHeaderFrame(header: SessionHeaderPayload): Uint8Array {
    const payload = encodeSessionHeader(header)
    return encodeFrame(
      this.sessionId,
      AcousticFrameType.SESSION_HEADER,
      this.sequenceCounter++,
      payload,
    )
  }

  /**
   * Packetize a Fountain EncodedBlock into an acoustic frame byte buffer.
   */
  public createDataFrame(block: EncodedBlock): Uint8Array {
    const binaryBlock = blockToBinary(block)
    return encodeFrame(
      this.sessionId,
      AcousticFrameType.DATA,
      this.sequenceCounter++,
      binaryBlock,
    )
  }

  /**
   * Create an END signal acoustic frame.
   */
  public createEndFrame(): Uint8Array {
    return encodeFrame(
      this.sessionId,
      AcousticFrameType.END,
      this.sequenceCounter++,
      new Uint8Array(0),
    )
  }

  /**
   * Parse an incoming acoustic byte array into an EncodedBlock or SessionHeaderPayload.
   */
  public parseIncomingBuffer(
    buffer: Uint8Array,
  ): {
    frame: AcousticFrame | null
    sessionHeader?: SessionHeaderPayload | null
    fountainBlock?: EncodedBlock | null
  } {
    const frame = decodeFrame(buffer)
    if (!frame) {
      return { frame: null }
    }

    if (frame.frameType === AcousticFrameType.SESSION_HEADER) {
      const sessionHeader = decodeSessionHeader(frame.payload)
      return { frame, sessionHeader }
    } else if (frame.frameType === AcousticFrameType.DATA) {
      try {
        const fountainBlock = binaryToBlock(frame.payload)
        return { frame, fountainBlock }
      } catch (e) {
        console.warn('Failed to parse Fountain block from valid acoustic frame payload', e)
        return { frame, fountainBlock: null }
      }
    }

    return { frame }
  }
}
