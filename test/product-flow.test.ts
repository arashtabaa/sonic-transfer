import { describe, expect, it } from 'vitest'
import { getProductSendState, isProductSendReady, type ProductFlowInput } from '../app/acoustic'

describe('normal product send flow', () => {
  it('reaches an enabled Send action after automatic profile verification', () => {
    const flow: ProductFlowInput = { hasFile: true, handshakeState: 'BOOTSTRAP_CONTROL_LINK', dataProfileReady: false, transmitting: false, complete: false, failed: false }
    expect(getProductSendState(flow)).toBe('CONNECTING')
    flow.handshakeState = 'LOCAL_GAIN_LOCKED'
    expect(getProductSendState(flow)).toBe('CALIBRATING_REMOTE')
    flow.handshakeState = 'REMOTE_GAIN_LOCKED'
    expect(getProductSendState(flow)).toBe('VERIFYING_DATA_LINK')
    flow.dataProfileReady = true
    expect(isProductSendReady(flow)).toBe(true)
    expect(getProductSendState(flow)).toBe('LINK_READY')
  })

  it('keeps Send disabled and offers retry when profile verification fails', () => {
    const flow = { hasFile: true, handshakeState: 'REMOTE_GAIN_LOCKED' as const, dataProfileReady: false, transmitting: false, complete: false, failed: true }
    expect(isProductSendReady(flow)).toBe(false)
    expect(getProductSendState(flow)).toBe('FAILED')
  })
})
