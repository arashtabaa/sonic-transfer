import { getProfileConfig, ModemProfileKey } from '../modulation/modem'
import { SonicWaveformRenderer } from '../transport/waveform-renderer'

export interface ThroughputBenchmarkResult {
  profile: ModemProfileKey
  payloadBytes: number
  encodedBytes: number
  protocolFrames: number
  fountainBlocks: number
  pcmSamples: number
  durationSeconds: number
  rawBitrate: number
  usefulBitrate: number
  efficiency: number
  protocolOverheadPercent: number
  fountainOverheadPercent: number
  shaVerified: boolean
}

export interface ThroughputBenchmarkOptions {
  sampleRate?: number
  sliceSize?: number
  extraBlocks?: number
  filename?: string
  contentType?: string
}

/** Measures the actual PCM produced by the production renderer, not a symbol-only estimate. */
export function benchmarkPayload(
  payload: Uint8Array,
  profile: ModemProfileKey,
  options: ThroughputBenchmarkOptions = {},
): ThroughputBenchmarkResult {
  const sampleRate = options.sampleRate ?? 48000
  const sliceSize = options.sliceSize ?? 100
  const extraBlocks = options.extraBlocks ?? 30
  const render = SonicWaveformRenderer.renderPayloadToPcm(
    payload,
    options.filename ?? 'benchmark.bin',
    options.contentType ?? 'application/octet-stream',
    profile,
    sampleRate,
    sliceSize,
    extraBlocks,
  )
  const config = getProfileConfig(profile, sampleRate)
  const rawBitrate = Math.log2(config.carrierCount) * 1000 / (config.symbolDurationMs + config.guardMs)
  const usefulBitrate = payload.length * 8 / render.durationSec
  const encodedBytes = render.encodedBytes
  const protocolBytes = render.protocolBytes
  const fountainBlocks = render.fountainBlocks
  return {
    profile,
    payloadBytes: payload.length,
    encodedBytes,
    protocolFrames: render.totalFrames,
    fountainBlocks,
    pcmSamples: render.totalSamples,
    durationSeconds: render.totalSamples / sampleRate,
    rawBitrate,
    usefulBitrate,
    efficiency: usefulBitrate / rawBitrate * 100,
    protocolOverheadPercent: encodedBytes ? (protocolBytes - encodedBytes) / protocolBytes * 100 : 0,
    fountainOverheadPercent: fountainBlocks ? (fountainBlocks - render.sourceBlocks) / fountainBlocks * 100 : 0,
    shaVerified: false,
  }
}

export function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(rounded / 60)
  const remaining = rounded % 60
  return minutes ? `${minutes}m ${remaining}s` : `${remaining}s`
}
