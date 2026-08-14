import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AcousticFrameType, AcousticLinkTester, AcousticPacketizer, SessionLifecycleRuntime, createDataRxPhy, createDataTxPhy, decodeTransferEnd, decodeTransferPoll, encodeFrame, encodeTransferEnd, encodeTransferPoll, encodeTransferStatus, getPilotMultitoneConfig, getProfileConfig, ModemProfileKey, renderFastPayloadToPcm } from '../app/acoustic'
import { createDecoder, readFileHeaderMetaFromBuffer } from '../packages/luby-transform/src'
import { generateTestPayload } from '../app/constants/testPayload'

function resample(pcm: Float32Array, sourceRate: number, destinationRate: number): Float32Array {
  const output = new Float32Array(Math.round(pcm.length * destinationRate / sourceRate))
  for (let i = 0; i < output.length; i++) { const source = i * sourceRate / destinationRate; const left = Math.floor(source); const fraction = source - left; output[i] = (pcm[left] || 0) * (1 - fraction) + (pcm[Math.min(left + 1, pcm.length - 1)] || 0) * fraction }
  return output
}

function robustRoundTrip(frame: Uint8Array, sourceRate: number, destinationRate: number) {
  const tx = createDataTxPhy(ModemProfileKey.ROBUST, sourceRate, getProfileConfig(ModemProfileKey.ROBUST, sourceRate))
  const rx = createDataRxPhy(ModemProfileKey.ROBUST, destinationRate, getProfileConfig(ModemProfileKey.ROBUST, destinationRate))
  return rx.pushSamples(resample(tx.encode(frame).samples, sourceRate, destinationRate))[0] || null
}

describe('deterministic two-device synthetic acoustic harness', () => {
  it('completes link, cross-rate V2 data, polled feedback, and SHA verification through PCM', () => {
    const senderRate = 48000
    const receiverRate = 44100
    const linkSession = 0x11112222
    const verificationSession = 0x33334444
    const transferSession = 0x55556666
    const senderRuntime = new SessionLifecycleRuntime()
    const receiverRuntime = new SessionLifecycleRuntime()
    senderRuntime.beginControl(linkSession)
    receiverRuntime.beginControl(linkSession)

    const robustTx = createDataTxPhy(ModemProfileKey.ROBUST, senderRate, getProfileConfig(ModemProfileKey.ROBUST, senderRate))
    const robustRx = createDataRxPhy(ModemProfileKey.ROBUST, receiverRate, getProfileConfig(ModemProfileKey.ROBUST, receiverRate))
    const probe = AcousticLinkTester.createProbeFrame(linkSession, 0xabcdef01)
    const probeFrames = robustRx.pushSamples(resample(robustTx.encode(probe).samples, senderRate, receiverRate))
    expect(probeFrames).toHaveLength(1)
    expect(AcousticLinkTester.parseProbePayload(probeFrames[0]!.payload)?.nonce).toBe(0xabcdef01)
    const ack = AcousticLinkTester.createAckFrame(linkSession, 0xabcdef01, 30)
    const ackFrames = createDataRxPhy(ModemProfileKey.ROBUST, senderRate, getProfileConfig(ModemProfileKey.ROBUST, senderRate)).pushSamples(resample(createDataTxPhy(ModemProfileKey.ROBUST, receiverRate, getProfileConfig(ModemProfileKey.ROBUST, receiverRate)).encode(ack).samples, receiverRate, senderRate))
    expect(ackFrames).toHaveLength(1)

    senderRuntime.bindVerification(verificationSession)
    receiverRuntime.bindVerification(verificationSession)
    expect(senderRuntime.acceptFrame(verificationSession, AcousticFrameType.PROFILE_ACCEPT)).toBe(true)
    receiverRuntime.beginTransfer(transferSession)
    senderRuntime.beginTransfer(transferSession)

    const payload = generateTestPayload()
    const rendered = renderFastPayloadToPcm(payload, 'sonic-test-fixture.bin', 'application/octet-stream', senderRate, 10, getPilotMultitoneConfig(senderRate))
    const dataRx = createDataRxPhy(ModemProfileKey.FAST_DATA_EXPERIMENTAL, receiverRate, getPilotMultitoneConfig(receiverRate))
    const packetizer = new AcousticPacketizer()
    const fountain = createDecoder()
    const received = resample(rendered.pcm, senderRate, receiverRate)
    let reconstructed: Uint8Array | null = null
    for (const frame of dataRx.pushSamples(received)) {
      expect(frame.frameType === AcousticFrameType.DATA || frame.frameType === AcousticFrameType.SESSION_HEADER).toBe(true)
      const parsed = packetizer.parseIncomingBuffer(encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload))
      if (parsed.fountainBlock && fountain.addBlock(parsed.fountainBlock)) { const [bytes] = readFileHeaderMetaFromBuffer(fountain.getDecoded()!); reconstructed = bytes; break }
    }
    expect(reconstructed).not.toBeNull()
    const sha = createHash('sha256').update(reconstructed!).digest('hex')
    expect(sha).toBe(createHash('sha256').update(payload).digest('hex'))

    const pollPayload = encodeTransferPoll({ protocolVersion: 1, transferSessionId: transferSession, pollSequence: 1, framesPlayed: rendered.totalFrames, lastDataSequence: rendered.transmittedBlocks })
    const poll = encodeFrame(transferSession, AcousticFrameType.TRANSFER_POLL, 1, pollPayload)
    const pollFrame = robustRoundTrip(poll, senderRate, receiverRate)
    const pollDecoded = decodeTransferPoll(pollFrame?.payload || new Uint8Array())
    expect(pollFrame && receiverRuntime.acceptFeedbackFrame(pollFrame)).toBe(true)
    expect(pollDecoded?.framesPlayed).toBe(rendered.totalFrames)

    const statusPayload = encodeTransferStatus({ protocolVersion: 1, transferSessionId: transferSession, blocksReceived: rendered.transmittedBlocks, decodedCount: rendered.sourceBlocks, complete: false })
    const statusFrame = robustRoundTrip(encodeFrame(transferSession, AcousticFrameType.TRANSFER_STATUS, 1, statusPayload), receiverRate, senderRate)
    expect(statusFrame && senderRuntime.acceptFeedbackFrame(statusFrame)).toBe(true)
    const endPayload = encodeTransferEnd({ protocolVersion: 1, transferSessionId: transferSession, expectedSha256: sha, actualSha256: sha, pass: true, blocksReceived: rendered.transmittedBlocks })
    expect(decodeTransferEnd(endPayload)).not.toBeNull()
    const endFrame = robustRoundTrip(encodeFrame(transferSession, AcousticFrameType.TRANSFER_END, 2, endPayload), receiverRate, senderRate)
    expect(endFrame && senderRuntime.acceptFeedbackFrame(endFrame)).toBe(true)
    expect(decodeTransferEnd(encodeTransferEnd({ ...decodeTransferEnd(endPayload)!, expectedSha256: 'bad' }))).toBeNull()
    expect(senderRuntime.acceptFeedbackFrame({ version: 1, sessionId: transferSession + 1, frameType: AcousticFrameType.TRANSFER_END, sequence: 2, payload: endPayload, checksum: 0 })).toBe(false)
  }, 180000)
})
