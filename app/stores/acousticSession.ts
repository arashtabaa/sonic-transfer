import { defineStore } from 'pinia'
import { appendFileHeaderMetaToBuffer, readFileHeaderMetaFromBuffer } from 'luby-transform'
import {
  AcousticFrameType,
  AcousticPacketizer,
  AudioReceiver,
  AudioTransmitter,
  BFSKAcousticModem,
  decodeTestFileComplete,
  encodeFrame,
  encodeTestFileComplete,
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

export enum ReceiveMode {
  IDLE = 'IDLE',
  NORMAL_RECEIVE = 'NORMAL_RECEIVE',
  LINK_ACK_WAIT = 'LINK_ACK_WAIT',
  LINK_PROBE_LISTEN = 'LINK_PROBE_LISTEN',
  TEST_COMPLETE_WAIT = 'TEST_COMPLETE_WAIT',
  TEST_DATA_RECEIVE = 'TEST_DATA_RECEIVE',
  FREQUENCY_PROBE_LISTEN = 'FREQUENCY_PROBE_LISTEN',
  FREQUENCY_REPORT_WAIT = 'FREQUENCY_REPORT_WAIT',
}

export enum TransferPhase {
  IDLE = 'IDLE',
  DATA_TX = 'DATA_TX',
  TX_DRAIN = 'TX_DRAIN',
  TURNAROUND_TO_RX = 'TURNAROUND_TO_RX',
  ACK_WINDOW = 'ACK_WINDOW',
  TURNAROUND_TO_TX = 'TURNAROUND_TO_TX',
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

  // --- Workflow & Dispatcher State ---
  const sessionStep = ref<SessionStep>(SessionStep.NOT_READY)
  const receiveMode = ref<ReceiveMode>(ReceiveMode.IDLE)
  const transferPhase = ref<TransferPhase>(TransferPhase.IDLE)
  const dspStage = ref<DspStage>('MICROPHONE_READY')
  const linkCheckMessage = ref<string | null>(null)

  // Canonical Session ID & Nonce for Active Transfer (Requirement 4 & 5 & 6)
  const transferSessionId = ref<number | null>(null)
  const activeProbeNonce = ref<number | null>(null)
  const activeTestTransferId = ref<number | null>(null)

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

  // Singletons & Audio Contexts
  let transmitter: AudioTransmitter | null = null
  let receiver: AudioReceiver | null = null
  let packetizer: AcousticPacketizer | null = null
  let decoderWorker: ReturnType<typeof createLTDecodeWorker> | null = null
  const metricsCollector = new MetricsCollector()
  const liveStats = ref(metricsCollector.getStats())
  let statsInterval: any = null
  let wakeLock: any = null

  // Modems: Dedicated ROBUST controlModem vs negotiated dataModem (Requirement 3 & 8)
  function getControlModem(sampleRate?: number): BFSKAcousticModem {
    const rate = sampleRate || transmitter?.getSampleRate() || receiver?.getSampleRate() || 48000
    const config = getProfileConfig(ModemProfileKey.ROBUST, rate)
    config.gain = outputGain.value
    return new BFSKAcousticModem(config)
  }

  function getDataModem(sampleRate?: number): BFSKAcousticModem {
    const rate = sampleRate || transmitter?.getSampleRate() || receiver?.getSampleRate() || 48000
    const config = getProfileConfig(selectedProfile.value, rate)
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

  function generateSecureRandomUint32(): number {
    const arr = new Uint32Array(1)
    crypto.getRandomValues(arr)
    return arr[0]!
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

  // --- Central AudioReceiver Dispatcher (Requirement 3) ---
  function processCentralAudioData(samples: Float32Array) {
    liveSamples.value = samples

    // 1. Control channel decode (ROBUST modem)
    const controlModem = getControlModem()
    const controlPackets = controlModem.decode(samples)
    for (const pkt of controlPackets) {
      handleIncomingPacket(pkt)
    }

    // 2. Data channel decode (negotiated dataModem)
    if (receiveMode.value === ReceiveMode.NORMAL_RECEIVE || receiveMode.value === ReceiveMode.TEST_DATA_RECEIVE) {
      const dataModem = getDataModem()
      const dataPackets = dataModem.decode(samples)
      if (dataPackets.length > 0) {
        dspStage.value = 'CARRIER_LOCKED'
      }
      for (const pkt of dataPackets) {
        handleIncomingPacket(pkt)
      }
    }
  }

  // --- Real Half-Duplex Acoustic Link Probe & ACK Verification (Requirement 4 & 5) ---
  async function runAcousticLinkCheck() {
    if (isTransmitting.value) return
    sessionStep.value = SessionStep.VERIFYING_LINK
    linkCheckMessage.value = 'Transmitting LINK_PROBE...'

    // Requirement 4 & 5: One canonical Session ID and nonce generated via crypto.getRandomValues()
    transferSessionId.value = generateSecureRandomUint32()
    activeProbeNonce.value = generateSecureRandomUint32()
    packetizer = new AcousticPacketizer(transferSessionId.value)

    const probeFrame = AcousticLinkTester.createProbeFrame(transferSessionId.value, activeProbeNonce.value)

    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()

    const controlModem = getControlModem(transmitter.getSampleRate())
    const audioFrame = controlModem.encode(probeFrame)

    // Step 1: Play frame and WAIT for real audio queue drain (Requirement 1 & 4)
    isTransmitting.value = true
    await transmitter.playFrame(audioFrame)
    await transmitter.waitUntilDrained()

    // Step 2: Half-duplex turnaround - stop TX before starting RX
    transmitter.stop()
    isTransmitting.value = false
    linkCheckMessage.value = 'LINK_PROBE finished playback. Half-duplex turnaround: Listening for LINK_ACK...'

    // Step 3: Switch central receiver mode to LINK_ACK_WAIT
    receiveMode.value = ReceiveMode.LINK_ACK_WAIT
    if (!receiver) {
      receiver = new AudioReceiver({ onAudioData: processCentralAudioData })
    } else {
      receiver.setOnAudioDataCallback(processCentralAudioData)
    }
    await receiver.start(selectedMicId.value || undefined)

    // Timeout handler for LINK_ACK window
    setTimeout(() => {
      if (sessionStep.value === SessionStep.VERIFYING_LINK) {
        sessionStep.value = SessionStep.NOT_READY
        linkCheckMessage.value = 'Link Verification Failed: ACK Timeout. Ensure receiver is listening.'
        if (receiver) receiver.stop()
        receiveMode.value = ReceiveMode.IDLE
        transferSessionId.value = null
        activeProbeNonce.value = null
      }
    }, 10000)
  }

  // --- Real Finite DATA Bursts + ACK Control Windows (Requirement 5 & 6) ---
  async function runTestFileTransfer() {
    sessionStep.value = SessionStep.TEST_TRANSFERRING
    transferPhase.value = TransferPhase.DATA_TX

    // Generate test session ID and testTransferId
    transferSessionId.value = generateSecureRandomUint32()
    activeTestTransferId.value = generateSecureRandomUint32()
    packetizer = new AcousticPacketizer(transferSessionId.value)

    const testPayload = generateTestPayload()
    sendSha256.value = EXPECTED_TEST_SHA256
    sendFilename.value = 'sonic-test-fixture.bin'

    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()

    const dataModem = getDataModem(transmitter.getSampleRate())
    const { createEncoder } = await import('luby-transform')
    const canonicalPayload = appendFileHeaderMetaToBuffer(testPayload, {
      filename: sendFilename.value,
      contentType: 'application/octet-stream',
    })
    const encoder = createEncoder(canonicalPayload, sliceSize.value, true)
    const fountain = encoder.fountain()

    let sequence = 0
    isTransmitting.value = true
    activePage.value = 'send'
    await requestWakeLock()

    // Finite Fountain DATA burst loop (10 frames per burst)
    const runBurst = async () => {
      if (!isTransmitting.value || sessionStep.value !== SessionStep.TEST_TRANSFERRING) return

      transferPhase.value = TransferPhase.DATA_TX
      for (let i = 0; i < 10; i++) {
        let frameBuffer: Uint8Array
        if (sequence % 10 === 0) {
          frameBuffer = packetizer!.createSessionHeaderFrame({
            protocolVersion: 1,
            sessionId: transferSessionId.value!,
            filename: sendFilename.value!,
            contentType: 'application/octet-stream',
            originalSize: testPayload.length,
            encodedSize: encoder.compressed.length,
            fileChecksum: encoder.checksum,
            sha256Hex: sendSha256.value!,
            totalFountainK: encoder.k,
            modemProfile: selectedProfile.value,
          })
        } else {
          const block = fountain.next().value
          const blockBytes = blockToBinary(block)
          frameBuffer = encodeFrame(transferSessionId.value!, AcousticFrameType.DATA, sequence, blockBytes)
        }

        const audioFrame = dataModem.encode(frameBuffer)
        transmitter!.enqueueFrame(audioFrame)
        sequence++
      }

      // Requirement 1 & 5: Wait for audio queue drain before half-duplex turnaround
      transferPhase.value = TransferPhase.TX_DRAIN
      await transmitter!.waitUntilDrained()

      // Half-duplex turnaround to RX
      transferPhase.value = TransferPhase.TURNAROUND_TO_RX
      transmitter!.stop()

      // Listen for TEST_FILE_COMPLETE frame in ACK window
      receiveMode.value = ReceiveMode.TEST_COMPLETE_WAIT
      if (!receiver) {
        receiver = new AudioReceiver({ onAudioData: processCentralAudioData })
      } else {
        receiver.setOnAudioDataCallback(processCentralAudioData)
      }
      await receiver.start(selectedMicId.value || undefined)

      transferPhase.value = TransferPhase.ACK_WINDOW

      // ACK Window timeout: Resume next DATA burst if not complete
      setTimeout(async () => {
        if (sessionStep.value === SessionStep.TEST_TRANSFERRING && isTransmitting.value) {
          if (receiver) receiver.stop()
          receiveMode.value = ReceiveMode.IDLE
          transferPhase.value = TransferPhase.TURNAROUND_TO_TX
          await transmitter!.start()
          runBurst()
        }
      }, 3000)
    }

    runBurst()
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

    // Requirement 4: Canonical session ID per transfer
    transferSessionId.value = generateSecureRandomUint32()
    packetizer = new AcousticPacketizer(transferSessionId.value)

    // Requirement 8: Prepare canonical transfer payload = appendFileHeaderMetaToBuffer(rawData, meta)
    const canonicalPayload = appendFileHeaderMetaToBuffer(rawData, {
      filename: sendFilename.value,
      contentType: sendContentType.value,
    })

    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()
    const dataModem = getDataModem(transmitter.getSampleRate())

    const { createEncoder } = await import('luby-transform')
    const encoder = createEncoder(canonicalPayload, sliceSize.value, true)
    const fountain = encoder.fountain()

    let sequence = 0
    isTransmitting.value = true
    activePage.value = 'send'
    await requestWakeLock()

    const step = async () => {
      if (!isTransmitting.value) return

      let frameBuffer: Uint8Array
      if (sequence % 10 === 0) {
        frameBuffer = packetizer!.createSessionHeaderFrame({
          protocolVersion: 1,
          sessionId: transferSessionId.value!,
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
        frameBuffer = encodeFrame(transferSessionId.value!, AcousticFrameType.DATA, sequence, blockBytes)
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
    receiveMode.value = ReceiveMode.NORMAL_RECEIVE
    metricsCollector.start()

    if (!receiver) {
      receiver = new AudioReceiver({ onAudioData: processCentralAudioData })
    } else {
      receiver.setOnAudioDataCallback(processCentralAudioData)
    }

    await receiver.start(selectedMicId.value || undefined)
    isListening.value = true
    activePage.value = 'receive'
    await requestWakeLock()

    statsInterval = setInterval(() => {
      liveStats.value = metricsCollector.getStats()
    }, 250)
  }

  async function handleIncomingPacket(packetBuffer: Uint8Array) {
    if (!packetizer) return

    const parsed = packetizer.parseIncomingBuffer(packetBuffer)
    if (!parsed.frame) {
      metricsCollector.recordPacket(0, false)
      return
    }

    // Requirement 4: Reject foreign session packets once locked
    if (transferSessionId.value && parsed.frame.sessionId !== transferSessionId.value) {
      console.warn('Rejected foreign session frame', parsed.frame.sessionId)
      return
    }

    dspStage.value = 'CRC_VALID'
    metricsCollector.recordPacket(parsed.frame.payload.length, true)

    // Requirement 4 & 5: Handle LINK_PROBE and send LINK_ACK with half-duplex turnaround
    if (parsed.frame.frameType === AcousticFrameType.LINK_PROBE) {
      const probePayload = AcousticLinkTester.parseProbePayload(parsed.frame.payload)
      if (probePayload) {
        // Half-duplex turnaround: stop RX before transmitting LINK_ACK
        if (receiver) receiver.stop()

        setTimeout(async () => {
          const ackFrame = AcousticLinkTester.createAckFrame(probePayload.sessionId, probePayload.nonce, liveStats.value.snrDb)
          if (!transmitter) transmitter = new AudioTransmitter()
          await transmitter.start()

          const controlModem = getControlModem(transmitter.getSampleRate())
          const audioFrame = controlModem.encode(ackFrame)
          await transmitter.playFrame(audioFrame)
          await transmitter.waitUntilDrained()
          transmitter.stop()

          if (isListening.value && receiver) {
            await receiver.start(selectedMicId.value || undefined)
          }
        }, 200)
      }
    }

    // Requirement 5: Handle LINK_ACK validation on Sender
    if (parsed.frame.frameType === AcousticFrameType.LINK_ACK) {
      const ack = AcousticLinkTester.parseAckPayload(parsed.frame.payload)
      if (
        ack &&
        transferSessionId.value !== null &&
        activeProbeNonce.value !== null &&
        ack.sessionId === transferSessionId.value &&
        ack.nonce === activeProbeNonce.value
      ) {
        sessionStep.value = SessionStep.LINK_VERIFIED
        linkCheckMessage.value = `LINK VERIFIED! Real acoustic ACK received (Session: ${ack.sessionId}, Nonce: ${ack.nonce}).`
        if (receiver) receiver.stop()
        receiveMode.value = ReceiveMode.IDLE
        activeProbeNonce.value = null
      }
    }

    // Requirement 6: Handle TEST_FILE_COMPLETE ACK validation on Sender
    if (parsed.frame.frameType === AcousticFrameType.TEST_FILE_COMPLETE) {
      const payload = decodeTestFileComplete(parsed.frame.payload)
      if (
        payload &&
        payload.protocolVersion === 1 &&
        payload.pass === true &&
        payload.expectedSha256 === EXPECTED_TEST_SHA256 &&
        payload.actualSha256 === EXPECTED_TEST_SHA256
      ) {
        // SENDER UNLOCKS TEST_TRANSFER_VERIFIED ONLY UPON RECEIVING REAL ACOUSTIC ACK!
        stopTransmission()
        if (receiver) receiver.stop()
        sessionStep.value = SessionStep.TEST_TRANSFER_VERIFIED
        transferPhase.value = TransferPhase.COMPLETE
      }
    }

    if (parsed.sessionHeader) {
      receiveHeader.value = parsed.sessionHeader
      transferSessionId.value = parsed.sessionHeader.sessionId
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

        if (!decoderWorker) decoderWorker = createLTDecodeWorker()
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
            isIntegrityVerified.value = false
          }

          if (isIntegrityVerified.value) {
            const blob = new Blob([originalBytes], { type: meta.contentType })
            downloadUrl.value = URL.createObjectURL(blob)
            downloadedFilename.value = meta.filename || 'received-file'
            downloadedContentType.value = meta.contentType
            dspStage.value = 'COMPLETE'

            // Requirement 6: Acoustically transmit strongly-validated TEST_FILE_COMPLETE ACK frame back to Sender!
            if (downloadedFilename.value === 'sonic-test-fixture.bin') {
              const completeBytes = encodeTestFileComplete({
                protocolVersion: 1,
                sessionId: receiveHeader.value?.sessionId || 999,
                testTransferId: activeTestTransferId.value || 888,
                expectedSha256: EXPECTED_TEST_SHA256,
                actualSha256: actualHash,
                pass: true,
              })
              const completeFrame = encodeFrame(
                receiveHeader.value?.sessionId || 999,
                AcousticFrameType.TEST_FILE_COMPLETE,
                1,
                completeBytes,
              )
              if (!transmitter) transmitter = new AudioTransmitter()
              await transmitter.start()
              const controlModem = getControlModem(transmitter.getSampleRate())
              const audioFrame = controlModem.encode(completeFrame)
              await transmitter.playFrame(audioFrame)
              await transmitter.waitUntilDrained()
              transmitter.stop()
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
    receiveMode,
    transferPhase,
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
