# Nudge

Nudge is an autonomous accountability companion designed to break passive procrastination through high-friction, voice-interrogated check-ins.

## Core Loop
Commit → Prepare → Interrupt → Engage → Question → Evaluate → Record → Adapt

## Core Constraints & Principles
- **₹0 Runtime / MVP Cost:** Operates locally on-device; external AI uses Bring Your Own Key (BYOK) with Google AI Studio free tier.
- **Local-First Storage:** IndexedDB via Dexie. No remote database server or user authentication required for MVP.
- **No Gloomy AI / Aggressive Dashboard Tropes:** Designed with a warm, minimalist, editorial visual aesthetic. High friction during commitments; psychologically comfortable when browsing.
- **Direct Accountability:** Replaces passive checkboxes with verbal viva-voce examination.

## Tech Stack
- Frontend: React 18 + TypeScript + Vite + Tailwind CSS v4
- Local Storage: Dexie.js (IndexedDB)
- Native Shell: Capacitor JS (Targeting Android exact alarm and full-screen intents)
- AI Engine: Google Gemini 1.5 Flash (Client-side BYOK)
- Voice Engine: Web Speech API (SpeechRecognition + SpeechSynthesis)

## Getting Started
```bash
npm install
npm run dev