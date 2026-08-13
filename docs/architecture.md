# Sonic Transfer - Architecture Overview

Sonic Transfer is a serverless, zero-pairing file transfer application that converts binary file data into acoustic sound waves transmitted over the air from speaker to microphone.

## Core System Architecture

```text
Sender Device:
File Selection
   ↓
Metadata Header Attachment (Filename, Type, Checksum)
   ↓
Luby Transform (Fountain Code Encoder)
   ↓
Acoustic Packet Framing & CRC32
   ↓
Acoustic Modem Modulation (BFSK / MFSK / OFDM)
   ↓
AudioWorklet / AudioContext
   ↓
Speaker Output (Air Transmission)

Receiver Device:
Microphone Input
   ↓
AudioWorklet Capture & Filtering
   ↓
Acoustic Modem Demodulation
   ↓
Frame Integrity Check (CRC32 Verification)
   ↓
Fountain Block Assembly (Web Worker)
   ↓
Luby Transform Fountain Decoder
   ↓
File Checksum Verification
   ↓
User Blob Download
```

## Key Technologies
- **Nuxt 3 / Vue 3 / TypeScript**: Modern reactive frontend application architecture.
- **Luby Transform (Fountain Coding)**: Rateless fountain codes in `packages/luby-transform` providing resilience against acoustic frame dropouts.
- **Web Audio API & AudioWorklet**: Low-latency real-time sample synthesis and capture off the main thread.
- **Dedicated Web Workers**: Decoupled Luby Transform decoding via `birpc` to prevent UI thread blocking.
- **UnoCSS**: Atomic styling engine.
