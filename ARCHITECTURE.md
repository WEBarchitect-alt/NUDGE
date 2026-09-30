Nudge — System Architecture

## 1. High-Level Topology
[ User Input / Schedule ]
│
▼
[ Local Database (Dexie / IndexedDB) ]
│
▼ (Scheduled Trigger)
[ Capacitor Native Shell (Exact Alarm + Full-Screen Intent) ]
│
▼ (Wakes Screen + Plays Ringtone)
[ Real-Time Voice Interrogation Screen ]
├── Web Speech API (STT: speech -> text)
├── Gemini 1.5 Flash (BYOK Client API: text -> rapid response <20 words)
└── Web Speech API (TTS: text -> voice audio)
│
▼ (Call Ends)
[ Asynchronous Grading Engine ]
└── Gemini 1.5 Flash (Full Transcript -> Structured JSON Scorecard)
│
▼
[ Update Streaks, Mastery Metrics & Dexie Logs ]


## 2. Key Architectural Decisions
- **Client-Only Execution:** No Node.js backend or database server. Eliminates server hosting costs and privacy leakage.
- **Bring Your Own Key (BYOK):** Users provide their personal Gemini API key. Keys remain isolated in local device storage.
- **Separation of Voice from Deep Evaluation:** Real-time turns use concise system prompts (<20 words per response). Structured JSON scoring runs asynchronously after the call ends to protect latency.

## 3. Critical Android Boundaries & Risks
- **Exact Alarms (`SCHEDULE_EXACT_ALARM`):** Required to fire check-ins at specific times. Android 14+ requires explicit user opt-in in system settings.
- **Full-Screen Intents (`USE_FULL_SCREEN_INTENT`):** Required to display the ringing call UI over the lock screen.
- **WebView Speech API Reliability:** Android WebView speech recognition behavior varies across device manufacturers and requires physical device verification.