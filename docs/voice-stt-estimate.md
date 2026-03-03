# ElevenLabs Voice Support in rho web — Implementation Estimate

> Generated: 2026-03-03  
> Branch: `feat/voice-stt-estimate`

---

## Summary

Adding hands-free voice I/O (STT + TTS via ElevenLabs) to rho web requires:
- **Desktop**: ~3.5–4 days
- **Desktop + Android**: ~4–4.5 days  
- **Desktop + iOS**: ~5.5–6 days (significantly more due to Safari autoplay restrictions)

The existing `stt.ts` in the Telegram extension is directly reusable. The TTS logic in `worker-runtime.ts` is trivial to extract.

---

## What "hands-free" means

Voice in → AI processes → voice out, automatically, with no explicit `/tts` command. Hold-to-record or push-to-toggle, speak, get spoken reply.

---

## How the existing Telegram extension does STT/TTS

### STT (Speech-to-Text)

`extensions/telegram/stt.ts` provides:

```typescript
interface SttProvider {
  transcribe(audio: Uint8Array, mimeType: string, fileName: string): Promise<string>;
}

class ElevenLabsSttProvider implements SttProvider {
  async transcribe(audio, mimeType, fileName) {
    const form = new FormData();
    form.append("model_id", "scribe_v1");
    form.append("file", new Blob([audio], { type: mimeType }), fileName);
    // POST to https://api.elevenlabs.io/v1/speech-to-text
  }
}
```

This is clean, provider-abstracted, and directly reusable in the web server. No changes needed to `stt.ts`.

### TTS (Text-to-Speech)

In `extensions/telegram/worker-runtime.ts`:

```typescript
async function synthesizeTtsAudio(text: string): Promise<{ bytes: Uint8Array; mimeType: string; fileName: string }> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_TTS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", output_format: "mp3_44100_128" }),
  });
  return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType: "audio/mpeg", fileName: "tts.mp3" };
}
```

This is ~50 lines, self-contained, and trivially extractable to a server route.

---

## Implementation plan

### 1. Browser: microphone capture

- **New file**: `web/public/js/chat/chat-voice.js` (~150–200 lines)
- Use MediaRecorder API to capture audio
- Hold-to-record button in the composer toolbar (HTML extension slot already exists at line ~525 of index.html)
- Encode as base64 or send as multipart, POST to server

**Effort**: 1 day

### 2. Server: STT endpoint

- **New file**: `web/server-voice-routes.ts`
- Route: `POST /api/stt`
- Reuses `ElevenLabsSttProvider` from `stt.ts` unchanged
- Reads `ELEVENLABS_API_KEY` from env, provider config from `init.toml` via same pattern as `config.ts`

**Effort**: 0.5 day

### 3. Browser: STT result → auto-send

- After receiving transcript from `/api/stt`, populate composer textarea and call existing `sendPrompt()` path
- No new infrastructure needed — reuses `chat-input-and-rpc-send.js`

**Effort**: 2 hours

### 4. Server: TTS endpoint

- **New route** in `web/server-voice-routes.ts`: `POST /api/tts`
- Extract TTS logic from `worker-runtime.ts` (synthesizeTtsAudio)
- Accept `{ text: string }`, return `audio/mpeg` binary

**Effort**: 2 hours

### 5. Browser: auto-TTS on AI response

- Listen for streaming completion (`rpc_done` events already available in `chat-rpc-event-routing.js`)
- Accumulate assistant text from streaming (already done in `chat-streaming-parts.js`)
- POST to `/api/tts`, play returned audio via `<audio>` element

**Effort**: 1 day

### 6. Config: init.toml settings

```toml
[settings.web]
voice_enabled = true
voice_stt_provider = "elevenlabs"   # or "openai"
voice_tts_enabled = true
voice_tts_voice_id = "EXAVITQu4vr4xnSDxMaL"
```

- Read in `config.ts`
- Expose via `/api/config` for the browser to query

**Effort**: 2 hours

### 7. UI: voice mode toggle + error handling

- Mic button with active state indicator (pulse animation)
- "Voice mode on/off" toggle, persisted in localStorage
- Error toasts if API key missing or ElevenLabs is down
- Graceful degradation (falls back to text if TTS fails)

**Effort**: 0.5 day

---

## Mobile considerations

### Android Chrome (easy)

- **MediaRecorder**: `audio/webm;codecs=opus` works natively — no codec probing needed
- **Autoplay**: Relaxed after first user gesture (mic tap) — no AudioContext priming required
- **Touch UX**: Use `touchstart`/`touchend` + `preventDefault()` for hold-to-record
- Handle `touchcancel` for interruptions (calls, notifications)

**Delta over desktop**: +0.5 day

### iOS Safari (harder)

- **MediaRecorder**: Only supports `audio/mp4` (AAC). Need `MediaRecorder.isTypeSupported()` probe-and-fallback.
- **Autoplay**: Safari requires `audio.play()` be called synchronously inside a user gesture. Workaround: on first mic tap, create an `AudioContext`, play a silent buffer, and keep the context alive. This is fiddly.
- **AudioContext suspend**: iOS aggressively suspends AudioContext when backgrounded. Need `visibilitychange` handling to resume on foreground.
- **Long-press menu**: Blocks native touch behavior. Need careful event handling on the mic button.

**Delta over desktop**: +2–2.5 days (total ~5.5–6 days)

### PWA considerations

- Both Android Chrome and iOS Safari support PWAs (`/manifest.json`, `sw.js` already exist)
- Service worker already handles caching; voice features work offline if STT/TTS calls are deferred
- No special PWA work required beyond the media handling above

---

## Effort summary

| Platform | Effort |
|---|---|
| Desktop only | ~3.5–4 days |
| Desktop + Android | ~4–4.5 days |
| Desktop + iOS | ~5.5–6 days |

---

## What makes it easier than expected

1. **`stt.ts` is reusable as-is** — clean provider abstraction, no rewrite needed
2. **TTS logic is self-contained** in `worker-runtime.ts` — ~50 lines, trivial to extract
3. **WebSocket events already track streaming completion** — `rpc_done` in `chat-rpc-event-routing.js` is already there
4. **Server route pattern is established** — `server-*-routes.ts` files are easy to follow and extend

---

## What makes it harder than expected

1. **iOS autoplay**: The silent-audio-priming trick is the most fragile part of the mobile work
2. **Streaming TTS**: The estimate assumes waiting for the full AI response before TTS. If you want to stream TTS audio as the AI generates (lower latency), that's a significant additional lift — the ElevenLabs API supports it but the browser audio pipeline gets complex
3. **Interruption handling**: If the user starts a new voice input while TTS is playing, you need to cancel the audio and restart. That's a small state machine that adds a few hours

---

## Open questions

1. **Streaming TTS**: Do you want partial-TTS (start speaking before AI finishes) or full-response TTS only? The latter is much simpler.
2. **Single voice or multiple**: Should the user be able to select from multiple ElevenLabs voices, or is the default `EXAVITQu4vr4xnSDxMaL` sufficient?
3. **Offline fallback**: If ElevenLabs is down, should it fail loudly (error toast) or gracefully fall back to text-only mode?
4. **PWA offline voice**: Should STT/TTS requests be queued for later when offline, or fail immediately?
5. **iOS priority**: Is iOS support required for the initial release, or can we ship desktop + Android first and add iOS later?

---

## References

- Existing STT: `extensions/telegram/stt.ts` (lines 51–162)
- Existing TTS: `extensions/telegram/worker-runtime.ts` (synthesizeTtsAudio, ~lines 440–490)
- Web route pattern: `web/server-*-routes.ts`
- Chat input logic: `web/public/js/chat/chat-input-and-rpc-send.js`
- Streaming events: `web/public/js/chat/chat-rpc-event-routing.js`
- Mobile breakpoint: `@media (max-width: 720px)` in `web/public/css/style.css`