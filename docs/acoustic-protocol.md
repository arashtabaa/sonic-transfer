# Acoustic Framing & Binary Protocol Specification

Sonic Transfer uses a binary packet format with frame preambles, headers, sequence numbers, payload lengths, and CRC32 verification.

## Frame Structure

```text
+-------------------+------------------+------------------+-------------------+-----------------+--------------------+--------------------+----------------+
| Preamble (4 B)    | Version (1 B)    | Session ID (4 B) | Frame Type (1 B)  | Sequence (4 B)  | Payload Len (2 B)  | Payload (N Bytes)  | CRC32 (4 Bytes)|
+-------------------+------------------+------------------+-------------------+-----------------+--------------------+--------------------+----------------+
```

### Field Definitions
- **Preamble**: `0x53, 0x4F, 0x4E, 0x49` (ASCII "SONI")
- **Version**: `0x01`
- **Session ID**: 32-bit unsigned integer identifying the transfer session.
- **Frame Type**:
  - `0x01` = `SESSION_HEADER`
  - `0x02` = `DATA`
  - `0x03` = `END`
  - `0x04` = `CONTROL`
  - `0x05` = `CALIBRATION`
- **Sequence**: 32-bit big-endian frame index.
- **Payload Length**: 16-bit big-endian payload byte count.
- **Payload**: Arbitrary payload bytes.
- **CRC32**: IEEE 802.3 32-bit CRC computed over Header + Payload.

## Session Header Payload

Session header frames are broadcast periodically (e.g. every 10 data frames) to allow receivers to join mid-stream:

```json
{
  "protocolVersion": 1,
  "sessionId": 123456,
  "filename": "document.pdf",
  "contentType": "application/pdf",
  "originalSize": 1048576,
  "encodedSize": 1048576,
  "fileChecksum": 341258901,
  "totalFountainK": 524,
  "modemProfile": "balanced"
}
```
