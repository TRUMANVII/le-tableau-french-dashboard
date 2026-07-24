# Le Tableau — French Learning Dashboard

A phone-first French learning dashboard built as a single-file React artifact for Claude. Chalkboard-themed, 20-min/day daily flow.

## What it does

- **SRS vocabulary review** (Leitner-style spaced repetition)
- **Azure Speech pronunciation assessment** — accuracy, fluency, completeness scores, plus phoneme-level trouble spots
- **Claude-driven adaptive coaching** — Claude picks new phrases, writes a daily speaking prompt, gives feedback on your spoken answers, and reviews your weekly trend
- **Conversation log** — jot notes after real chats with French friends; Claude factors these into what it teaches you next
- **Vocabulary library** — browse, search, and manually correct your SRS progress

## Setup

1. Open `french-dashboard.jsx` as a React artifact in Claude (claude.ai).
2. Use **Safari** on iPhone — Chrome on iOS shares Safari's engine but doesn't expose the speech recognition API.
3. Go to Settings and add your **Azure Speech** subscription key + region (e.g. `westeurope`). Create a free resource at [portal.azure.com](https://portal.azure.com) under "Speech" if you don't have one.
4. Grant microphone access when prompted.

Your Azure key is stored only in the artifact's local storage on your device and sent directly to Azure — never through Claude.

## Architecture notes

- Playback: browser `SpeechSynthesis` (free, works offline)
- Recording: `MediaRecorder` → resampled to 16kHz mono → encoded to WAV in-browser
- Pronunciation scoring: Azure Speech REST API (`Pronunciation-Assessment` header, phoneme granularity)
- Adaptive content + coaching: Claude API (`claude-sonnet-4-6`) called directly from the browser
- Persistence: artifact key-value storage (`window.storage`), scoped personal (not shared)
