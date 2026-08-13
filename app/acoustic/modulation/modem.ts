/**
 * Acoustic Modem Interfaces and Profiles
 */

export enum ModemProfileKey {
  AUTO = 'auto',
  ROBUST = 'robust',
  BALANCED = 'balanced',
  TURBO = 'turbo',
  NEAR_ULTRASONIC = 'near_ultrasonic',
  ULTRASONIC_EXPERIMENTAL = 'ultrasonic_experimental',
  CUSTOM = 'custom',
}

export interface ModemConfig {
  profileKey: ModemProfileKey
  sampleRate: number
  startFreq: number
  endFreq: number
  carrierCount: number
  symbolDurationMs: number
  guardMs: number
  gain: number
}

export interface ModemMetrics {
  profileKey: ModemProfileKey
  carrierFreqs: number[]
  symbolDurationMs: number
  rawBitrate: number
  usefulBitrate: number
  snrDb: number
  packetsReceived: number
  validPackets: number
  invalidPackets: number
  packetDiscardRate: number
}

export interface AudioFrame {
  samples: Float32Array
  durationMs: number
}

export interface AcousticModem {
  readonly config: ModemConfig
  /**
   * Modulates a binary packet into audio samples.
   */
  encode(packet: Uint8Array): AudioFrame
  /**
   * Demodulates audio samples into decoded binary packets.
   */
  decode(samples: Float32Array): Uint8Array[]
  /**
   * Reset internal phase and buffers.
   */
  reset(): void
  /**
   * Get current modem statistics and metrics.
   */
  getMetrics(): ModemMetrics
}

/**
 * Returns default modem frequency configuration based on selected profile and AudioContext sample rate.
 * Never hardcodes sample rates — derives frequencies from sampleRate & Nyquist limit.
 */
export function getProfileConfig(profileKey: ModemProfileKey, sampleRate: number): ModemConfig {
  const nyquist = sampleRate / 2
  const maxSafeFreq = Math.max(1000, nyquist - 1500) // Strict safety guard band below Nyquist

  switch (profileKey) {
    case ModemProfileKey.ROBUST:
      return {
        profileKey,
        sampleRate,
        startFreq: 1500,
        endFreq: Math.min(3500, maxSafeFreq),
        carrierCount: 8,
        symbolDurationMs: 40,
        guardMs: 10,
        gain: 0.7,
      }

    case ModemProfileKey.BALANCED:
      return {
        profileKey,
        sampleRate,
        startFreq: 2000,
        endFreq: Math.min(6000, maxSafeFreq),
        carrierCount: 16,
        symbolDurationMs: 25,
        guardMs: 5,
        gain: 0.7,
      }

    case ModemProfileKey.TURBO:
      return {
        profileKey,
        sampleRate,
        startFreq: 3000,
        endFreq: Math.min(12000, maxSafeFreq),
        carrierCount: 32,
        symbolDurationMs: 15,
        guardMs: 3,
        gain: 0.8,
      }

    case ModemProfileKey.NEAR_ULTRASONIC:
      return {
        profileKey,
        sampleRate,
        startFreq: Math.min(15000, maxSafeFreq - 2000),
        endFreq: Math.min(19500, maxSafeFreq),
        carrierCount: 16,
        symbolDurationMs: 25,
        guardMs: 5,
        gain: 0.75,
      }

    case ModemProfileKey.ULTRASONIC_EXPERIMENTAL:
      return {
        profileKey,
        sampleRate,
        startFreq: Math.min(18000, maxSafeFreq - 2000),
        endFreq: Math.min(22500, maxSafeFreq),
        carrierCount: 16,
        symbolDurationMs: 20,
        guardMs: 4,
        gain: 0.8,
      }

    case ModemProfileKey.AUTO:
    default:
      return {
        profileKey: ModemProfileKey.BALANCED,
        sampleRate,
        startFreq: 2000,
        endFreq: Math.min(6000, maxSafeFreq),
        carrierCount: 16,
        symbolDurationMs: 25,
        guardMs: 5,
        gain: 0.7,
      }
  }
}

/**
 * Validate that frequency parameters are valid for the current sample rate.
 */
export function validateConfig(config: ModemConfig): { valid: boolean; error?: string } {
  const nyquist = config.sampleRate / 2
  const maxAllowedFreq = nyquist - 1500 // Strict Nyquist safety guard band

  if (config.startFreq < 100) {
    return { valid: false, error: 'Start frequency must be >= 100 Hz' }
  }
  if (config.endFreq > maxAllowedFreq) {
    return { valid: false, error: `End frequency exceeds safe Nyquist limit with guard band (${maxAllowedFreq.toFixed(0)} Hz)` }
  }
  if (config.startFreq >= config.endFreq) {
    return { valid: false, error: 'Start frequency must be less than end frequency' }
  }
  if (config.carrierCount < 2 || config.carrierCount > 64) {
    return { valid: false, error: 'Carrier count must be between 2 and 64' }
  }
  return { valid: true }
}
