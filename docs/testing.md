# Testing Strategy & Benchmark Guidance

Sonic Transfer includes unit testing, synthetic channel simulation, and manual physical device verification.

## Automated Test Suite

Run unit tests:
```bash
npx pnpm test --run
```

Test coverage includes:
- CRC32 verification
- Acoustic frame serialization & deserialization
- Corrupted frame rejection
- BFSK modulation & synthetic audio demodulation
- Luby Transform Fountain block slicing & reconstruction

## Manual Real-Device Testing Checklist

Test the application across physical devices:
1. Laptop speaker → Laptop microphone
2. Phone speaker → Laptop microphone
3. Laptop speaker → Phone microphone
4. Phone speaker → Phone microphone
