import { defineStore } from 'pinia'
import { appendFileHeaderMetaToBuffer, readFileHeaderMetaFromBuffer } from 'luby-transform'
import {
  AcousticFrameType,
  AcousticPacketizer,
  AudioReceiver,
  AudioTransmitter,
  BFSKAcousticModem,
  encodeFrame,
  getProfileConfig,
  MetricsCollector,
  ModemProfileKey,
  type AudioDiagnosticsInfo,
  type SessionHeaderPayload,
} from '~/acoustic'
import { AcousticLinkTester } from '~/acoustic/transport/link-test'
import { createLTDecodeWorker } from '~/composables/lt-decode'
import { EXPECTED_TEST_SHA256, generateTestPayload } from '~/constants/testPayload'

export enum SessionStep {
  NOT_READY = 'NOT_READY',
  HARDWARE_READY = 'HARDWARE_READY',
  VERIFYING_LINK = 'VERIFYING_LINK',
  LINK_VERIFIED = 'LINK_VERIFIED',
  TEST_TRANSFERRING = 'TEST_TRANSFERRING',
  TEST_TRANSFER_VERIFIED = 'TEST_TRANSFER_VERIFIED',
  READY_FOR_FILE = 'READY_FOR_FILE',
  FILE_SELECTED = 'FILE_SELECTED',
  TRANSFERRING = 'TRANSFERRING',
  COMPLETE = 'COMPLETE',
}

export type DspStage =
  | 'MICROPHONE_READY'
  | 'MEASURING_NOISE'
  | 'SEARCHING_FOR_SIGNAL'
  | 'CARRIER_LOCKED'
  | 'PREAMBLE_DETECTED'
  | 'FRAME_RECEIVING'
  | 'CRC_VALID'
  | 'FOUNTAIN_BLOCK_ACCEPTED'
  | 'RECONSTRUCTING'
  | 'COMPLETE'

async function computeSha256Hex(buffer: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

export const useAcousticSessionStore = defineStore('acousticSession', () => {
  // --- Persistent Preferences ---
  const selectedProfile = useLocalStorage<ModemProfileKey>('sonic-profile', ModemProfileKey.BALANCED)
  const outputGain = useLocalStorage<number>('sonic-gain', 0.7)
  const selectedMicId = useLocalStorage<string>('sonic-mic-id', '')
  const selectedSpeakerId = useLocalStorage<string>('sonic-speaker-id', '')
  const sliceSize = useLocalStorage<number>('sonic-slice-size', 200)

  // --- Workflow Gating State ---
  const sessionStep = ref<SessionStep>(SessionStep.NOT_READY)
  const dspStage = ref<DspStage>('MICROPHONE_READY')
  const linkCheckMessage = ref<string | null>(null)

  // --- Live Runtime State (Survives SPA Navigation) ---
  const isTransmitting = ref(false)
  const isListening = ref(false)
  const liveSamples = ref<Float32Array | null>(null)
  const activePage = ref<'send' | 'receive' | 'idle'>('idle')

  // Stored File (Survives SPA Navigation)
  const storedData = ref<Uint8Array | null>(null)
  const sendFilename = ref<string | null>(null)
  const sendContentType = ref<string | null>(null)
  const sendTotalBytes = ref(0)
  const sendSha256 = ref<string | null>(null)
  const framesSent = ref(0)
  const bytesSent = ref(0)

  // Receiver Session State
  const receiveHeader = ref<SessionHeaderPayload | null>(null)
  const fountainK = ref(0)
  const decodedCount = ref(0)
  const totalBlocksReceived = ref(0)
  const downloadUrl = ref<string | null>(null)
  const downloadedFilename = ref<string | null>(null)
  const downloadedContentType = ref<string | null>(null)
  const expectedSha256 = ref<string | null>(null)
  const receivedSha256 = ref<string | null>(null)
  const isIntegrityVerified = ref(false)

  // Active Link Verification Session & Nonce (Requirement 5)
  let activeProbeSessionId: number | null = null
  let activeProbeNonce: number | null = null

  // Singletons
  let transmitter: AudioTransmitter | null = null
  let receiver: AudioReceiver | null = null
  let packetizer: AcousticPacketizer | null = null
  let decoderWorker: ReturnType<typeof createLTDecodeWorker> | null = null
  const metricsCollector = new MetricsCollector()
  const liveStats = ref(metricsCollector.getStats())
  let statsInterval: any = null
  let wakeLock: any = null

  // Modems: Dedicated ROBUST controlModem vs negotiated dataModem (Requirement 3)
  function getControlModem(sampleRate = 48000): BFSKAcousticModem {
    const config = getProfileConfig(ModemProfileKey.ROBUST, sampleRate)
    config.gain = outputGain.value
    return new BFSKAcousticModem(config)
  }

  function getDataModem(sampleRate = 48000): BFSKAcousticModem {
    const config = getProfileConfig(selectedProfile.value, sampleRate)
    config.gain = outputGain.value
    return new BFSKAcousticModem(config)
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && (navigator as any).wakeLock) {
        wakeLock = await (navigator as any).wakeLock.request('screen')
      }
    } catch {}
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {})
      wakeLock = null
    }
  }

  async function setFile(data: Uint8Array, filename: string, contentType: string) {
    storedData.value = data
    sendFilename.value = filename
    sendContentType.value = contentType
    sendTotalBytes.value = data.length
    sendSha256.value = await computeSha256Hex(data)

    if (sessionStep.value === SessionStep.READY_FOR_FILE || sessionStep.value === SessionStep.TEST_TRANSFER_VERIFIED) {
      sessionStep.value = SessionStep.FILE_SELECTED
    }
  }

  function skipVerification() {
    sessionStep.value = SessionStep.READY_FOR_FILE
  }

  // --- Real Half-Duplex Acoustic Link Probe & ACK Verification (Requirement 4 & 5) ---
  async function runAcousticLinkCheck() {
    if (isTransmitting.value) return
    sessionStep.value = SessionStep.VERIFYING_LINK
    linkCheckMessage.value = 'Transmitting LINK_PROBE...'

    // Requirement 5: Generate session ID and nonce using crypto.getRandomValues()
    const randomArray = new Uint32Array(2)
    crypto.getRandomValues(randomArray)
    activeProbeSessionId = randomArray[0]!
    activeProbeNonce = randomArray[1]!

    const probeFrame = AcousticLinkTester.createProbeFrame(activeProbeSessionId, activeProbeNonce)
    const controlModem = getControlModem(48000)

    if (!transmitter) transmitter = new AudioTransmitter({ sampleRate: 48000, gain: outputGain.value })

    // Step 1: Transmit LINK_PROBE frame
    await transmitter.start()
    const audioFrame = controlModem.encode(probeFrame)
    transmitter.enqueueFrame(audioFrame)

    // Step 2: Half-duplex turnaround - Wait for audio output to complete before switching to RX
    setTimeout(async () => {
      transmitter?.stop()
      linkCheckMessage.value = 'LINK_PROBE finished. Half-duplex turnaround: Listening for LINK_ACK...'

      if (!packetizer) packetizer = new AcousticPacketizer()
      if (!receiver) {
        receiver = new AudioReceiver({
          onAudioData: (samples) => {
            liveSamples.value = samples
            // Requirement 3: Always decode control frames using dedicated ROBUST controlModem!
            const packets = controlModem.decode(samples)
            for (const pkt of packets) {
              const parsed = packetizer?.parseIncomingBuffer(pkt)
              if (parsed?.frame && parsed.frame.frameType === AcousticFrameType.LINK_ACK) {
                const ack = AcousticLinkTester.parseAckPayload(parsed.frame.payload)
                // Requirement 5: Reject unless CRC valid, LINK_ACK, sessionId matches, nonce matches
                if (
                  ack &&
                  ack.sessionId === activeProbeSessionId &&
                  ack.nonce === activeProbeNonce
                ) {
                  sessionStep.value = SessionStep.LINK_VERIFIED
                  linkCheckMessage.value = `LINK VERIFIED! Acoustic ACK received (Session: ${ack.sessionId}, Nonce: ${ack.nonce}, SNR: ${ack.snrDb.toFixed(1)} dB).`
                  receiver?.stop()
                  activeProbeSessionId = null
                  activeProbeNonce = null
                }
              }
            }
          },
        })
      }

      await receiver.start(selectedMicId.value || undefined)

      // Timeout handler: 10s ACK Timeout -> FAILURE
      setTimeout(() => {
        if (sessionStep.value === SessionStep.VERIFYING_LINK) {
          sessionStep.value = SessionStep.NOT_READY
          linkCheckMessage.value = 'Link Verification Failed: ACK Timeout. Ensure receiver is listening.'
          if (receiver) receiver.stop()
          activeProbeSessionId = null
          activeProbeNonce = null
        }
      }, 10000)
    }, audioFrame.durationMs + 200)
  }

  // --- Real Test File Transfer (Requirement 7) ---
  async function runTestFileTransfer() {
    sessionStep.value = SessionStep.TEST_TRANSFERRING

    const testPayload = generateTestPayload()
    sendSha256.value = EXPECTED_TEST_SHA256

    // Start transmission of deterministic test payload
    await startTransmission(testPayload, 'sonic-test-fixture.bin', 'application/octet-stream')

    // Start receiver listening for TEST_FILE_COMPLETE frame from receiver!
    const controlModem = getControlModem(48000)
    if (!receiver) {
      receiver = new AudioReceiver({
        onAudioData: (samples) => {
          const packets = controlModem.decode(samples)
          for (const pkt of packets) {
            const parsed = packetizer?.parseIncomingBuffer(pkt)
            if (parsed?.frame && parsed.frame.frameType === AcousticFrameType.TEST_FILE_COMPLETE) {
              // TEST_FILE_COMPLETE ACK RECEIVED ACOUSTICALLY FROM RECEIVER!
              stopTransmission()
              receiver?.stop()
              sessionStep.value = SessionStep.TEST_TRANSFER_VERIFIED
            }
          }
        },
      })
    }
    await receiver.start(selectedMicId.value || undefined)
  }

  // --- Sender Transmission ---
  async function startTransmission(data?: Uint8Array, filename?: string, contentType?: string) {
    if (isTransmitting.value) return

    const rawData = data || storedData.value
    if (!rawData) return

    sendFilename.value = filename || sendFilename.value || 'file.bin'
    sendContentType.value = contentType || sendContentType.value || 'application/octet-stream'
    sendTotalBytes.value = rawData.length

    // Requirement 8: Compute SHA-256 over ORIGINAL FILE BYTES!
    sendSha256.value = await computeSha256Hex(rawData)
    framesSent.value = 0
    bytesSent.value = 0

    // Requirement 8: Prepare canonical transfer payload = appendFileHeaderMetaToBuffer(rawData, meta)
    const canonicalPayload = appendFileHeaderMetaToBuffer(rawData, {
      filename: sendFilename.value,
      contentType: sendContentType.value,
    })

    if (!transmitter) transmitter = new AudioTransmitter({ sampleRate: 48000, gain: outputGain.value })
    if (!packetizer) packetizer = new AcousticPacketizer()

    await transmitter.start()
    const dataModem = getDataModem(transmitter.getSampleRate())

    const { createEncoder } = await import('luby-transform')
    const encoder = createEncoder(canonicalPayload, sliceSize.value, true)
    const fountain = encoder.fountain()

    let sequence = 0
    const sessionId = Math.floor(Math.random() * 1000000)

    isTransmitting.value = true
    activePage.value = 'send'
    await requestWakeLock()

    const step = async () => {
      if (!isTransmitting.value) return

      let frameBuffer: Uint8Array
      if (sequence % 10 === 0) {
        frameBuffer = packetizer!.createSessionHeaderFrame({
          protocolVersion: 1,
          sessionId,
          filename: sendFilename.value || 'file.bin',
          contentType: sendContentType.value || 'application/octet-stream',
          originalSize: rawData.length,
          encodedSize: encoder.compressed.length,
          fileChecksum: encoder.checksum,
          sha256Hex: sendSha256.value || undefined,
          totalFountainK: encoder.k,
          modemProfile: selectedProfile.value,
        })
      } else {
        const block = fountain.next().value
        const blockBytes = blockToBinary(block)
        frameBuffer = encodeFrame(sessionId, AcousticFrameType.DATA, sequence, blockBytes)
      }

      const audioFrame = dataModem.encode(frameBuffer)
      liveSamples.value = audioFrame.samples
      transmitter!.enqueueFrame(audioFrame)

      framesSent.value++
      bytesSent.value += frameBuffer.length
      sequence++

      if (isTransmitting.value) {
        setTimeout(step, dataModem.config.symbolDurationMs * 2)
      }
    }

    step()
  }

  function stopTransmission() {
    isTransmitting.value = false
    if (transmitter) transmitter.stop()
    releaseWakeLock()
    if (!isListening.value) activePage.value = 'idle'
  }

  // --- Receiver Controls ---
  async function startListening() {
    if (isListening.value) return

    if (!packetizer) packetizer = new AcousticPacketizer()
    if (!decoderWorker) decoderWorker = createLTDecodeWorker()

    downloadUrl.value = null
    downloadedFilename.value = null
    downloadedContentType.value = null
    expectedSha256.value = null
    receivedSha256.value = null
    isIntegrityVerified.value = false
    receiveHeader.value = null
    fountainK.value = 0
    decodedCount.value = 0
    totalBlocksReceived.value = 0
    dspStage.value = 'SEARCHING_FOR_SIGNAL'
    metricsCollector.start()

    const controlModem = getControlModem(48000)
    const dataModem = getDataModem(48000)

    if (!receiver) {
      receiver = new AudioReceiver({
        onAudioData: (samples) => {
          liveSamples.value = samples

          // Requirement 3: First try controlModem (ROBUST), then dataModem
          const controlPackets = controlModem.decode(samples)
          for (const pkt of controlPackets) {
            processIncomingPacket(pkt)
          }

          const dataPackets = dataModem.decode(samples)
          if (dataPackets.length > 0) {
            dspStage.value = 'CARRIER_LOCKED'
          }
          for (const pkt of dataPackets) {
            processIncomingPacket(pkt)
          }
        },
      })
    }

    await receiver.start(selectedMicId.value || undefined)
    isListening.value = true
    activePage.value = 'receive'
    await requestWakeLock()

    statsInterval = setInterval(() => {
      liveStats.value = metricsCollector.getStats()
    }, 250)
  }

  async function processIncomingPacket(packetBuffer: Uint8Array) {
    if (!packetizer || !decoderWorker) return

    const parsed = packetizer.parseIncomingBuffer(packetBuffer)
    if (!parsed.frame) {
      metricsCollector.recordPacket(0, false)
      return
    }

    dspStage.value = 'CRC_VALID'
    metricsCollector.recordPacket(parsed.frame.payload.length, true)

    // Requirement 4: Real Half-Duplex Turnaround on LINK_PROBE!
    if (parsed.frame.frameType === AcousticFrameType.LINK_PROBE) {
      const probePayload = AcousticLinkTester.parseProbePayload(parsed.frame.payload)
      if (probePayload) {
        // Step 1: Stop receiver temporarily
        if (receiver) receiver.stop()

        // Step 2: Short guard interval before transmitting LINK_ACK
        setTimeout(async () => {
          const ackFrame = AcousticLinkTester.createAckFrame(probePayload.sessionId, probePayload.nonce, liveStats.value.snrDb || 0)
          if (!transmitter) transmitter = new AudioTransmitter({ sampleRate: 48000, gain: outputGain.value })
          await transmitter.start()
          const controlModem = getControlModem(transmitter.getSampleRate())
          const audioFrame = controlModem.encode(ackFrame)
          transmitter.enqueueFrame(audioFrame)

          // Step 3: Wait for ACK playback to finish, then return to RX
          setTimeout(async () => {
            transmitter?.stop()
            if (isListening.value && receiver) {
              await receiver.start(selectedMicId.value || undefined)
            }
          }, audioFrame.durationMs + 200)
        }, 200)
      }
    }

    if (parsed.sessionHeader) {
      receiveHeader.value = parsed.sessionHeader
      fountainK.value = parsed.sessionHeader.totalFountainK
      expectedSha256.value = parsed.sessionHeader.sha256Hex || null
      dspStage.value = 'FRAME_RECEIVING'
      if (decoderWorker) {
        await decoderWorker.createDecoder()
      }
    } else if (parsed.frame.frameType === AcousticFrameType.DATA) {
      try {
        const { binaryToBlock } = await import('luby-transform')
        const block = binaryToBlock(parsed.frame.payload)
        totalBlocksReceived.value++
        dspStage.value = 'FOUNTAIN_BLOCK_ACCEPTED'

        const success = await decoderWorker.addBlock(block)
        const status = await decoderWorker.getStatus()
        decodedCount.value = status.decodedCount

        if (success && !downloadUrl.value) {
          dspStage.value = 'RECONSTRUCTING'
          const decodedMerged = (await decoderWorker.getDecoded())!
          const [originalBytes, meta] = readFileHeaderMetaFromBuffer(decodedMerged)

          // Requirement 8: Compute SHA-256 over ORIGINAL FILE BYTES!
          const actualHash = await computeSha256Hex(originalBytes)
          receivedSha256.value = actualHash

          // Requirement 8: Missing expected SHA-256 results in INTEGRITY UNVERIFIED!
          if (expectedSha256.value) {
            isIntegrityVerified.value = (actualHash === expectedSha256.value)
          } else {
            isIntegrityVerified.value = false // UNVERIFIED!
          }

          if (isIntegrityVerified.value) {
            const blob = new Blob([originalBytes], { type: meta.contentType })
            downloadUrl.value = URL.createObjectURL(blob)
            downloadedFilename.value = meta.filename || 'received-file'
            downloadedContentType.value = meta.contentType
            dspStage.value = 'COMPLETE'

            // Requirement 7: Acoustically transmit TEST_FILE_COMPLETE ACK frame back to Sender!
            if (downloadedFilename.value === 'sonic-test-fixture.bin') {
              const completeFrame = encodeFrame(
                receiveHeader.value?.sessionId || 999,
                AcousticFrameType.TEST_FILE_COMPLETE,
                1,
                new TextEncoder().encode(actualHash),
              )
              if (!transmitter) transmitter = new AudioTransmitter({ sampleRate: 48000, gain: outputGain.value })
              await transmitter.start()
              const controlModem = getControlModem(transmitter.getSampleRate())
              transmitter.enqueueFrame(controlModem.encode(completeFrame))
            }
          }
        }
      } catch (e) {
        console.error('Failed to process Fountain block', e)
      }
    }
  }

  function stopListening() {
    isListening.value = false
    if (receiver) receiver.stop()
    if (statsInterval) {
      clearInterval(statsInterval)
      statsInterval = null
    }
    releaseWakeLock()
    if (!isTransmitting.value) activePage.value = 'idle'
  }

  function blockToBinary(block: any): Uint8Array {
    const { k, bytes, checksum, indices, data } = block
    const header = new Uint32Array([indices.length, ...indices, k, bytes, checksum])
    const binary = new Uint8Array(header.length * 4 + data.length)
    let offset = 0
    binary.set(new Uint8Array(header.buffer), offset)
    offset += header.length * 4
    binary.set(data, offset)
    return binary
  }

  return {
    selectedProfile,
    outputGain,
    selectedMicId,
    selectedSpeakerId,
    sliceSize,
    sessionStep,
    dspStage,
    linkCheckMessage,
    isTransmitting,
    isListening,
    liveSamples,
    activePage,
    storedData,
    sendFilename,
    sendContentType,
    sendTotalBytes,
    sendSha256,
    framesSent,
    bytesSent,
    receiveHeader,
    fountainK,
    decodedCount,
    totalBlocksReceived,
    downloadUrl,
    downloadedFilename,
    downloadedContentType,
    expectedSha256,
    receivedSha256,
    isIntegrityVerified,
    liveStats,
    setFile,
    skipVerification,
    runAcousticLinkCheck,
    runTestFileTransfer,
    startTransmission,
    stopTransmission,
    startListening,
    stopListening,
  }
})
