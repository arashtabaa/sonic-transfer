===================================================
Sonic Transfer - Portable Local Package
Direct File Transfer Through Sound (Serverless)
===================================================

Sonic Transfer allows two nearby devices (laptops, phones, PCs) to transfer files directly using speakers and microphones.

HOW TO RUN LOCALLY:

1. Windows:
   Double-click `start.bat` (or run `start.ps1` in PowerShell).
   Your default web browser will open automatically at http://localhost:3000.

2. Mac / Linux / Web Server:
   Serve the `public/` directory with any static HTTP server:
   npx serve public -l 3000

PRIVACY & SECURITY:
- No file is ever uploaded to a server or internet storage.
- Everything runs 100% locally in your web browser.
- No pairing, WebRTC, WebSocket, or backend service required.

BROWSER REQUIREMENTS:
- Modern browser (Chrome, Edge, Firefox, Safari) with Web Audio API support.
- Microphone permission is required on the receiver device.
