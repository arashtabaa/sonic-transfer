import { defineStore } from 'pinia'
import { appendFileHeaderMetaToBuffer, readFileHeaderMetaFromBuffer } from 'luby-transform'
import {
  AcousticFrameType,
  AcousticPacketizer,
  AudioReceiver,
  AudioTransmitter,
  BFSKAcousticModem,
  decodeTestFileComplete,
  decodeTestFileStart,
  encodeFrame,
  encodeTestFileComplete,
  encodeTestFileStart,
  getProfileConfig,
  MetricsCollector,
  ModemProfileKey,
  BFSKStreamDecoder,
  validateTestFileCompleteFrame,
  createProfileProbeFrame,
  createChannelReportFrame,
  decodeProfileProposal,
  decodeProfileAccept,
  decodeChannelReport,
  encodeProfileProposal,
  encodeProfileAccept,
  validateProfileProposal,
  classifyProfileReport,
  decodeProfileProbe,
  encodeProfileProbeEnd,
  decodeProfileProbeEnd,
  encodeProfileReject,
  decodeProfileReject,
  getFastDataConfig,
  ParallelMultitoneStreamDecoder,
  createDataTxPhy,
  createDataRxPhy,
  encodeWithDataTxPhy,
  type DataPhyConfig,
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
  PROFILE_PROBE_LISTEN = 'PROFILE_PROBE_LISTEN',
  PROFILE_REPORT_WAIT = 'PROFILE_REPORT_WAIT',
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
  const profileVerificationStatus = ref<'UNVERIFIED' | 'READY' | 'MARGINAL' | 'FAILED'>('UNVERIFIED')
  const profileVerificationReport = ref<any>(null)
  const profileVerificationNonce = ref<number | null>(null)
  const profileProbeValid = ref(0)
  const receivedProbeSequences = new Set<number>()
  const verifiedProfile = ref<ModemProfileKey | null>(null)
  const verifiedConfigFingerprint = ref<string | null>(null)
  const verifiedAt = ref<number | null>(null)
  let profileVerificationResolver: ((ready: boolean) => void) | null = null
  let profileVerificationTimer: ReturnType<typeof setTimeout> | null = null
  let profileVerificationPhase: 'ACCEPT' | 'REPORT' | null = null

  // Receiver Learned Test State (Requirement 4 & 6 - NO 888/999 Fallbacks)
  const incomingTestSessionId = ref<number | null>(null)
  const incomingTestTransferId = ref<number | null>(null)
  const incomingExpectedSha256 = ref<string | null>(null)

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
  let controlRxDecoder: BFSKStreamDecoder | null = null
  let dataRxDecoder: BFSKStreamDecoder | null = null
  let fastDataRxDecoder: ParallelMultitoneStreamDecoder | null = null
  let negotiatedDataRxPhy: BFSKStreamDecoder | ParallelMultitoneStreamDecoder | null = null
  const verifiedDataConfig = ref<DataPhyConfig | null>(null)
  const activeVerificationModulation = ref<'MFSK' | 'MULTITONE'>('MFSK')
  let rxSampleRateOverride: number | null = null

  // Modems: Dedicated ROBUST controlModem vs negotiated dataModem (Requirement 3 & 8)
  function getControlModem(sampleRate?: number): BFSKAcousticModem {
    const rate = sampleRate || transmitter?.getSampleRate() || receiver?.getSampleRate() || 48000
    const config = getProfileConfig(ModemProfileKey.ROBUST, rate)
    config.gain = outputGain.value
    return new BFSKAcousticModem(config)
  }

  function getDataTxPhy(sampleRate?: number) {
    const rate = sampleRate || transmitter?.getSampleRate() || receiver?.getSampleRate() || 48000
    return createDataTxPhy(selectedProfile.value, rate, verifiedDataConfig.value || undefined)
  }

  function currentProfileFingerprint(profile = selectedProfile.value, sampleRate = transmitter?.getSampleRate() || 48000): string {
    if (profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL) {
      const config = getFastDataConfig(sampleRate)
      config.gain = outputGain.value
      return JSON.stringify({ protocolVersion: 1, modulation: 'GUARDED_MULTITONE_V1', profile, startFreq: config.startFreq, endFreq: config.endFreq, carrierCount: config.carrierCount, symbolDurationMs: config.symbolDurationMs, guardMs: config.guardMs, gain: config.gain, txSampleRate: sampleRate })
    }
    const config = getProfileConfig(profile === ModemProfileKey.AUTO ? ModemProfileKey.BALANCED : profile, sampleRate)
    config.gain = outputGain.value
    return JSON.stringify({ protocolVersion: 1, modulation: 'MFSK-FSK-v1', profile, startFreq: config.startFreq, endFreq: config.endFreq, carrierCount: config.carrierCount, symbolDurationMs: config.symbolDurationMs, guardMs: config.guardMs, gain: config.gain, txSampleRate: sampleRate })
  }

  function invalidateVerifiedProfile() {
    if (profileVerificationStatus.value === 'READY') profileVerificationStatus.value = 'UNVERIFIED'
    verifiedProfile.value = null
    verifiedConfigFingerprint.value = null
    verifiedDataConfig.value = null
    verifiedAt.value = null
  }

  watch([selectedProfile, outputGain], invalidateVerifiedProfile)

  function ensureRxDecoders() {
    const rate = receiver?.getSampleRate() || rxSampleRateOverride || 48000
    if (!controlRxDecoder || controlRxDecoder.getSampleRate() !== rate) {
      controlRxDecoder = new BFSKStreamDecoder(getControlModem(rate))
    }
    const profile = verifiedProfile.value || selectedProfile.value
    if (profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL) {
      if (!negotiatedDataRxPhy || !(negotiatedDataRxPhy instanceof ParallelMultitoneStreamDecoder)) negotiatedDataRxPhy = createDataRxPhy(profile, rate, verifiedDataConfig.value || undefined)
      fastDataRxDecoder = negotiatedDataRxPhy as ParallelMultitoneStreamDecoder
    } else if (!dataRxDecoder || dataRxDecoder.getSampleRate() !== rate) {
      dataRxDecoder = createDataRxPhy(profile, rate, verifiedDataConfig.value || undefined) as BFSKStreamDecoder
      negotiatedDataRxPhy = dataRxDecoder
    }
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
    ensureRxDecoders()

    // 1. Control channel decode (ROBUST modem)
    const controlFrames = controlRxDecoder!.pushSamples(samples)
    for (const frame of controlFrames) {
      handleIncomingPacket(encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload))
    }

    // 2. Data channel decode (negotiated dataModem)
    if (receiveMode.value === ReceiveMode.NORMAL_RECEIVE || receiveMode.value === ReceiveMode.TEST_DATA_RECEIVE || receiveMode.value === ReceiveMode.PROFILE_PROBE_LISTEN) {
      const dataFrames = (receiveMode.value === ReceiveMode.PROFILE_PROBE_LISTEN && activeVerificationModulation.value === 'MULTITONE') || verifiedProfile.value === ModemProfileKey.FAST_DATA_EXPERIMENTAL
        ? fastDataRxDecoder!.pushSamples(samples)
        : dataRxDecoder!.pushSamples(samples)
      if (dataFrames.length > 0) {
        dspStage.value = 'CARRIER_LOCKED'
      }
      for (const frame of dataFrames) {
        handleIncomingPacket(encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload))
      }
    }
  }

  function prepareArtifactDecoding(sampleRate = 48000) {
    if (!packetizer) packetizer = new AcousticPacketizer()
    if (!decoderWorker) decoderWorker = createLTDecodeWorker()
    controlRxDecoder = null
    dataRxDecoder = null
    fastDataRxDecoder = null
    negotiatedDataRxPhy = null
    rxSampleRateOverride = sampleRate
    receiveMode.value = ReceiveMode.NORMAL_RECEIVE
    dspStage.value = 'SEARCHING_FOR_SIGNAL'
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
    rxSampleRateOverride = null

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

  // --- Real Finite DATA Bursts + ACK Control Windows (Requirement 1, 4, 5, 6) ---
  async function runTestFileTransfer() {
    sessionStep.value = SessionStep.TEST_TRANSFERRING
    transferPhase.value = TransferPhase.DATA_TX

    // Generate test session ID and testTransferId via crypto.getRandomValues()
    transferSessionId.value = generateSecureRandomUint32()
    activeTestTransferId.value = generateSecureRandomUint32()
    packetizer = new AcousticPacketizer(transferSessionId.value)

    const testPayload = generateTestPayload()
    sendSha256.value = EXPECTED_TEST_SHA256
    sendFilename.value = 'sonic-test-fixture.bin'

    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()

    const controlModem = getControlModem(transmitter.getSampleRate())
    const dataModem = getDataTxPhy(transmitter.getSampleRate())

    // Step 1: Transmit TEST_FILE_START over ROBUST control channel (Requirement 1 & 4)
    const startPayloadBytes = encodeTestFileStart({
      protocolVersion: 1,
      sessionId: transferSessionId.value,
      testTransferId: activeTestTransferId.value,
      payloadSize: testPayload.length,
      expectedSha256: EXPECTED_TEST_SHA256,
    })
    const startFrame = encodeFrame(transferSessionId.value, AcousticFrameType.TEST_FILE_START, 1, startPayloadBytes)
    const startAudioFrame = controlModem.encode(startFrame)
    await transmitter.playFrame(startAudioFrame)
    await transmitter.waitUntilDrained()

    // 200ms guard interval before starting test DATA bursts
    await new Promise(r => setTimeout(r, 200))

    const { createEncoder } = await import('luby-transform')
    const canonicalPayload = appendFileHeaderMetaToBuffer(testPayload, {
      filename: sendFilename.value,
      contentType: 'application/octet-stream',
    })
    const encoder = createEncoder(canonicalPayload, sliceSize.value, true)
    const fountain = encoder.fountain()

    let sequence = 2
    isTransmitting.value = true
    activePage.value = 'send'
    await requestWakeLock()

    // Finite Fountain DATA burst loop (10 frames per burst)
    const runBurst = async () => {
      if (!isTransmitting.value || sessionStep.value !== SessionStep.TEST_TRANSFERRING) return

      transferPhase.value = TransferPhase.DATA_TX
      const framePromises: Promise<void>[] = []

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

        const audioFrame = encodeWithDataTxPhy(dataModem, frameBuffer)
        framePromises.push(transmitter!.playFrame(audioFrame))
        sequence++
      }

      // Requirement 3: Track every frame promise and wait for queue drain!
      transferPhase.value = TransferPhase.TX_DRAIN
      await Promise.all(framePromises)
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

  async function transmitControlVerificationFrame(frame: Uint8Array) {
    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()
    const modem = getControlModem(transmitter.getSampleRate())
    await transmitter.playFrame(modem.encode(frame))
    await transmitter.waitUntilDrained()
    transmitter.stop()
  }

  async function transmitProfileProbes(proposal: any) {
    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()
    const modem = createDataTxPhy(proposal.profile, transmitter.getSampleRate(), proposal.config)
    for (let sequence = 1; sequence <= proposal.probeCount; sequence++) {
      const probe = { protocolVersion: 1, sessionId: proposal.sessionId, verificationNonce: proposal.verificationNonce, profile: proposal.profile, probeSequence: sequence, totalProbes: proposal.probeCount }
      await transmitter.playFrame(modem.encode(createProfileProbeFrame(probe, proposal.sessionId, sequence)))
    }
    await transmitter.waitUntilDrained()
    transmitter.stop()
    await new Promise(resolve => setTimeout(resolve, 200))
    await transmitControlVerificationFrame(encodeFrame(proposal.sessionId, AcousticFrameType.PROFILE_PROBE_END, proposal.probeCount + 1, encodeProfileProbeEnd({ protocolVersion: 1, sessionId: proposal.sessionId, verificationNonce: proposal.verificationNonce, profile: proposal.profile, attemptedProbes: proposal.probeCount })))
  }

  async function verifyDataProfile(profile = selectedProfile.value, probeCount = 30): Promise<boolean> {
    if (profile === ModemProfileKey.AUTO || profile === ModemProfileKey.NEAR_ULTRASONIC || profile === ModemProfileKey.ULTRASONIC_EXPERIMENTAL || transferSessionId.value === null) {
      profileVerificationStatus.value = 'FAILED'
      return false
    }
    const sampleRate = transmitter?.getSampleRate() || receiver?.getSampleRate() || 48000
    const verificationNonce = generateSecureRandomUint32()
    profileVerificationNonce.value = verificationNonce
    verifiedProfile.value = profile
    verifiedConfigFingerprint.value = currentProfileFingerprint(profile, sampleRate)
    profileVerificationStatus.value = 'UNVERIFIED'
    receivedProbeSequences.clear()
    profileVerificationReport.value = null
    const config = profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL ? getFastDataConfig(sampleRate) : getProfileConfig(profile, sampleRate)
    const proposal = { protocolVersion: 1, sessionId: transferSessionId.value, verificationNonce, profile, sampleRate, config, probeCount, configFingerprint: currentProfileFingerprint(profile, sampleRate) }
    proposal.config.gain = outputGain.value
    verifiedDataConfig.value = { ...proposal.config }
    await transmitControlVerificationFrame(encodeFrame(transferSessionId.value, AcousticFrameType.PROFILE_PROPOSE, 1, encodeProfileProposal(proposal)))
    receiveMode.value = ReceiveMode.PROFILE_REPORT_WAIT
    if (!receiver) receiver = new AudioReceiver({ onAudioData: processCentralAudioData })
    else receiver.setOnAudioDataCallback(processCentralAudioData)
    const result = new Promise<boolean>((resolve) => { profileVerificationResolver = resolve })
    await receiver.start(selectedMicId.value || undefined)
    profileVerificationPhase = 'ACCEPT'
    profileVerificationTimer = setTimeout(() => finishProfileVerification(false, 'PROFILE_ACCEPT_TIMEOUT'), 8000)
    return result
  }

  function finishProfileVerification(ready: boolean, reason?: string) {
    if (profileVerificationTimer) clearTimeout(profileVerificationTimer)
    profileVerificationTimer = null
    profileVerificationPhase = null
    if (!ready) {
      profileVerificationStatus.value = 'FAILED'
      verifiedProfile.value = null
      verifiedConfigFingerprint.value = null
      verifiedDataConfig.value = null
      if (reason) linkCheckMessage.value = `DATA profile verification failed: ${reason}`
      if (receiver) receiver.stop()
      receiveMode.value = ReceiveMode.IDLE
    }
    const resolver = profileVerificationResolver
    profileVerificationResolver = null
    resolver?.(ready)
  }

  async function verifyAutoProfile(probeCount = 30): Promise<ModemProfileKey | null> {
    for (const candidate of [ModemProfileKey.TURBO, ModemProfileKey.BALANCED, ModemProfileKey.ROBUST]) {
      if (await verifyDataProfile(candidate, probeCount)) {
        selectedProfile.value = candidate
        return candidate
      }
    }
    return null
  }

  // --- Sender Transmission ---
  async function startTransmission(data?: Uint8Array, filename?: string, contentType?: string) {
    if (isTransmitting.value) return
    if (profileVerificationStatus.value !== 'READY' || verifiedProfile.value !== selectedProfile.value || verifiedConfigFingerprint.value !== currentProfileFingerprint(selectedProfile.value, transmitter?.getSampleRate() || 48000)) {
      linkCheckMessage.value = `${selectedProfile.value} DATA profile is not READY; run production profile verification first.`
      return
    }

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
    const txPhy = getDataTxPhy(transmitter.getSampleRate())

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

      const audioFrame = encodeWithDataTxPhy(txPhy, frameBuffer)
      liveSamples.value = audioFrame.samples
      transmitter!.enqueueFrame(audioFrame)

      framesSent.value++
      bytesSent.value += frameBuffer.length
      sequence++

      if (isTransmitting.value) {
        setTimeout(step, txPhy.config.symbolDurationMs * 2)
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
    controlRxDecoder = null
    dataRxDecoder = null
    fastDataRxDecoder = null
    negotiatedDataRxPhy = null
    ensureRxDecoders()
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

    // Requirement 4: Reject foreign session packets once locked (NO FALLBACK IDs 888/999!)
    if (transferSessionId.value && parsed.frame.sessionId !== transferSessionId.value) {
      console.warn('Rejected foreign session frame', parsed.frame.sessionId)
      return
    }

    dspStage.value = 'CRC_VALID'
    metricsCollector.recordPacket(parsed.frame.payload.length, true)

    const profileProbe = parsed.frame.frameType === AcousticFrameType.LINK_PROBE ? decodeProfileProbe(parsed.frame.payload) : null
    if (profileProbe && receiveMode.value === ReceiveMode.PROFILE_PROBE_LISTEN && profileVerificationNonce.value === profileProbe.verificationNonce && profileProbe.sessionId === transferSessionId.value && profileProbe.profile === verifiedProfile.value) {
      if (!receivedProbeSequences.has(profileProbe.probeSequence)) receivedProbeSequences.add(profileProbe.probeSequence)
      profileProbeValid.value = receivedProbeSequences.size
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.PROFILE_PROBE_END) {
      const end = decodeProfileProbeEnd(parsed.frame.payload)
      if (end && end.sessionId === transferSessionId.value && end.verificationNonce === profileVerificationNonce.value && end.profile === verifiedProfile.value) {
        const stats = activeVerificationModulation.value === 'MULTITONE' ? null : dataRxDecoder?.getStats()
        const valid = Math.min(end.attemptedProbes, receivedProbeSequences.size)
        const report = {
          protocolVersion: 1,
          sessionId: end.sessionId,
          verificationNonce: end.verificationNonce,
          profile: end.profile,
          attemptedProbes: end.attemptedProbes,
          framesDetected: stats?.framesDetected || valid,
          crcValid: valid,
          crcInvalid: Math.max(0, end.attemptedProbes - valid),
          per: 1 - valid / end.attemptedProbes,
          classification: classifyProfileReport(valid, end.attemptedProbes),
          sampleRate: dataRxDecoder?.getSampleRate() || 48000,
          configFingerprint: verifiedConfigFingerprint.value || '',
        }
        if (receiver) receiver.stop()
        await transmitControlVerificationFrame(createChannelReportFrame(report, end.sessionId))
        profileVerificationReport.value = report
        profileVerificationStatus.value = report.classification
        profileVerificationResolver?.(report.classification === 'READY')
        profileVerificationResolver = null
        receiveMode.value = ReceiveMode.IDLE
      }
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.PROFILE_PROPOSE) {
      const proposal = decodeProfileProposal(parsed.frame.payload)
      const actualRate = receiver?.getSampleRate() || rxSampleRateOverride || 48000
      if (proposal && validateProfileProposal(proposal, actualRate)) {
        profileVerificationNonce.value = proposal.verificationNonce
        profileProbeValid.value = 0
        receivedProbeSequences.clear()
        verifiedProfile.value = proposal.profile as ModemProfileKey
        verifiedConfigFingerprint.value = proposal.configFingerprint
        activeVerificationModulation.value = proposal.profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL ? 'MULTITONE' : 'MFSK'
        if (receiver) receiver.stop()
        await transmitControlVerificationFrame(encodeFrame(proposal.sessionId, AcousticFrameType.PROFILE_ACCEPT, 1, encodeProfileAccept(proposal)))
        verifiedDataConfig.value = { ...proposal.config }
        if (activeVerificationModulation.value === 'MULTITONE') {
          fastDataRxDecoder = createDataRxPhy(proposal.profile, actualRate, proposal.config) as ParallelMultitoneStreamDecoder
          negotiatedDataRxPhy = fastDataRxDecoder
        } else {
          dataRxDecoder = createDataRxPhy(proposal.profile, actualRate, proposal.config) as BFSKStreamDecoder
          negotiatedDataRxPhy = dataRxDecoder
        }
        receiveMode.value = ReceiveMode.PROFILE_PROBE_LISTEN
        if (isListening.value && receiver) await receiver.start(selectedMicId.value || undefined)
      } else if (proposal) {
        const reason = proposal.config?.endFreq >= (actualRate / 2 - 1500) ? 'NYQUIST_INCOMPATIBLE' : 'INVALID_CONFIG'
        if (receiver) receiver.stop()
        await transmitControlVerificationFrame(encodeFrame(proposal.sessionId, AcousticFrameType.PROFILE_REJECT, 1, encodeProfileReject({ protocolVersion: 1, sessionId: proposal.sessionId, verificationNonce: proposal.verificationNonce, profile: proposal.profile, reason })))
        if (isListening.value && receiver) await receiver.start(selectedMicId.value || undefined)
      }
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.PROFILE_ACCEPT) {
      const proposal = decodeProfileAccept(parsed.frame.payload)
      if (proposal && proposal.verificationNonce === profileVerificationNonce.value && proposal.sessionId === transferSessionId.value) {
        if (profileVerificationTimer) clearTimeout(profileVerificationTimer)
        profileVerificationTimer = null
        profileVerificationPhase = null
        if (receiver) receiver.stop()
        await transmitProfileProbes(proposal)
        receiveMode.value = ReceiveMode.PROFILE_REPORT_WAIT
        if (receiver) await receiver.start(selectedMicId.value || undefined)
        profileVerificationPhase = 'REPORT'
        profileVerificationTimer = setTimeout(() => finishProfileVerification(false, 'CHANNEL_REPORT_TIMEOUT'), 10000)
      }
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.PROFILE_REJECT) {
      const rejection = decodeProfileReject(parsed.frame.payload)
      if (rejection && rejection.sessionId === transferSessionId.value && rejection.verificationNonce === profileVerificationNonce.value && rejection.profile === verifiedProfile.value) finishProfileVerification(false, rejection.reason)
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.CHANNEL_REPORT) {
      const report = decodeChannelReport(parsed.frame.payload)
      const expectedClass = report ? classifyProfileReport(report.crcValid, report.attemptedProbes) : null
      if (report && report.verificationNonce === profileVerificationNonce.value && report.sessionId === transferSessionId.value && report.profile === verifiedProfile.value && report.configFingerprint === verifiedConfigFingerprint.value && report.classification === expectedClass && report.crcValid + report.crcInvalid === report.attemptedProbes) {
        profileVerificationReport.value = report
        profileVerificationStatus.value = report.classification
        verifiedConfigFingerprint.value = currentProfileFingerprint(report.profile as ModemProfileKey, transmitter?.getSampleRate() || 48000)
        verifiedAt.value = Date.now()
        linkCheckMessage.value = `${report.profile} DATA verification: ${report.classification} (${report.crcValid}/${report.attemptedProbes} CRC-valid probes)`
        if (receiver) receiver.stop()
        receiveMode.value = ReceiveMode.IDLE
        finishProfileVerification(report.classification === 'READY')
      }
      return
    }

    // Handle TEST_FILE_START: Device B learns incoming test session details! (Requirement 1 & 4)
    if (parsed.frame.frameType === AcousticFrameType.TEST_FILE_START) {
      const startPayload = decodeTestFileStart(parsed.frame.payload)
      if (
        startPayload &&
        startPayload.protocolVersion === 1 &&
        startPayload.payloadSize === 8192 &&
        startPayload.expectedSha256 === EXPECTED_TEST_SHA256 &&
        parsed.frame.sessionId === startPayload.sessionId
      ) {
        incomingTestSessionId.value = startPayload.sessionId
        incomingTestTransferId.value = startPayload.testTransferId
        incomingExpectedSha256.value = startPayload.expectedSha256
        transferSessionId.value = startPayload.sessionId
        receiveMode.value = ReceiveMode.TEST_DATA_RECEIVE
      }
    }

    // Requirement 4 & 5: Handle LINK_PROBE and send LINK_ACK with half-duplex turnaround
    if (parsed.frame.frameType === AcousticFrameType.LINK_PROBE) {
      const probePayload = AcousticLinkTester.parseProbePayload(parsed.frame.payload)
      if (probePayload) {
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

    // Requirement 2 & 5: Handle TEST_FILE_COMPLETE ACK validation on Sender
    if (parsed.frame.frameType === AcousticFrameType.TEST_FILE_COMPLETE) {
      const payload = decodeTestFileComplete(parsed.frame.payload)
      const isValid = validateTestFileCompleteFrame(
        parsed.frame,
        payload,
        transferSessionId.value || 0,
        activeTestTransferId.value || 0,
        EXPECTED_TEST_SHA256,
      )

      if (isValid) {
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

            // Requirement 3 & 6: Half-duplex turnaround before transmitting TEST_FILE_COMPLETE ACK back to Sender!
            if (
              downloadedFilename.value === 'sonic-test-fixture.bin' &&
              incomingTestSessionId.value &&
              incomingTestTransferId.value
            ) {
              const completeBytes = encodeTestFileComplete({
                protocolVersion: 1,
                sessionId: incomingTestSessionId.value,
                testTransferId: incomingTestTransferId.value,
                expectedSha256: EXPECTED_TEST_SHA256,
                actualSha256: actualHash,
                pass: true,
              })
              const completeFrame = encodeFrame(
                incomingTestSessionId.value,
                AcousticFrameType.TEST_FILE_COMPLETE,
                1,
                completeBytes,
              )

              // Stop RX before transmitting
              if (receiver) receiver.stop()
              receiveMode.value = ReceiveMode.IDLE

              setTimeout(async () => {
                if (!transmitter) transmitter = new AudioTransmitter()
                await transmitter.start()
                const controlModem = getControlModem(transmitter.getSampleRate())
                const audioFrame = controlModem.encode(completeFrame)
                await transmitter.playFrame(audioFrame)
                await transmitter.waitUntilDrained()
                transmitter.stop()

                setTimeout(async () => {
                  if (isListening.value && receiver) {
                    await receiver.start(selectedMicId.value || undefined)
                  }
                }, 200)
              }, 200)
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
    profileVerificationStatus,
    profileVerificationReport,
    liveStats,
    processCentralAudioData,
    prepareArtifactDecoding,
    setFile,
    skipVerification,
    runAcousticLinkCheck,
    runTestFileTransfer,
    verifyDataProfile,
    verifyAutoProfile,
    startTransmission,
    stopTransmission,
    startListening,
    stopListening,
  }
})
