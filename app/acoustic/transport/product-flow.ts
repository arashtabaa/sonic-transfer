import type { AdaptiveHandshakeState } from './adaptive-handshake-runtime'

export type ProductSendState = 'NO_FILE' | 'FILE_SELECTED' | 'CONNECTING' | 'CALIBRATING_LOCAL' | 'CALIBRATING_REMOTE' | 'VERIFYING_DATA_LINK' | 'LINK_READY' | 'SENDING' | 'COMPLETE' | 'FAILED'

export interface ProductFlowInput {
  hasFile: boolean
  handshakeState: AdaptiveHandshakeState
  dataProfileReady: boolean
  transmitting: boolean
  complete: boolean
  failed: boolean
}

export function isGainCalibrationComplete(state: AdaptiveHandshakeState): boolean {
  return state === 'REMOTE_GAIN_LOCKED' || state === 'READY'
}

export function isProductSendReady(input: Pick<ProductFlowInput, 'hasFile' | 'handshakeState' | 'dataProfileReady'>): boolean {
  return input.hasFile && isGainCalibrationComplete(input.handshakeState) && input.dataProfileReady
}

export function getProductSendState(input: ProductFlowInput): ProductSendState {
  if (!input.hasFile) return 'NO_FILE'
  if (input.complete) return 'COMPLETE'
  if (input.transmitting) return 'SENDING'
  if (input.failed) return 'FAILED'
  if (input.dataProfileReady && isGainCalibrationComplete(input.handshakeState)) return 'LINK_READY'
  if (input.handshakeState === 'PROFILE_NEGOTIATING' || input.handshakeState === 'PROFILE_VERIFYING') return 'VERIFYING_DATA_LINK'
  if (input.handshakeState === 'LOCAL_GAIN_SWEEP') return 'CALIBRATING_LOCAL'
  if (input.handshakeState === 'LOCAL_GAIN_LOCKED' || input.handshakeState === 'REMOTE_GAIN_SWEEP') return 'CALIBRATING_REMOTE'
  if (isGainCalibrationComplete(input.handshakeState) && !input.dataProfileReady) return 'VERIFYING_DATA_LINK'
  if (input.handshakeState === 'BOOTSTRAP_CONTROL_LINK') return 'CONNECTING'
  if (input.handshakeState === 'FAILED' || input.handshakeState === 'ABORTED') return 'FAILED'
  return 'FILE_SELECTED'
}
