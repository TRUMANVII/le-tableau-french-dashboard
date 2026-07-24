import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Play, Settings, ChevronRight, ChevronLeft, Flame, Check, X, Volume2, Loader2, ArrowLeft, BookOpen, Square, RefreshCw } from 'lucide-react';

// ---------------------------------------------------------------------------
// Design tokens — chalkboard / bistro-signage theme
// ---------------------------------------------------------------------------
const C = {
  bg: '#1F2B27',
  panel: '#26332E',
  panelLine: 'rgba(242,239,231,0.10)',
  chalk: '#F2EFE7',
  chalkMuted: '#93A39B',
  rouge: '#C1453A',
  rougeDim: 'rgba(193,69,58,0.18)',
  bleu: '#4A6C9B',
  bleuDim: 'rgba(74,108,155,0.18)',
  or: '#D3AE3F',
  orDim: 'rgba(211,174,63,0.18)',
  good: '#5C9A6E',
};

const FONT_IMPORT = "@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Caveat:wght@600;700&family=Inter:wght@400;500;600;700&display=swap');";

const SEED_VOCAB = [
  { fr: 'Bonjour', en: 'Hello / Good day' },
  { fr: 'Je m\u2019appelle...', en: 'My name is...' },
  { fr: 'Comment ça va ?', en: 'How\u2019s it going?' },
  { fr: 'Merci beaucoup', en: 'Thank you very much' },
  { fr: 'Je ne comprends pas', en: 'I don\u2019t understand' },
  { fr: 'Pouvez-vous répéter ?', en: 'Can you repeat that?' },
  { fr: 'Je m\u2019appelle', en: 'I am called' },
  { fr: 'Où est...', en: 'Where is...' },
  { fr: 'S\u2019il vous plaît', en: 'Please' },
  { fr: 'Au revoir', en: 'Goodbye' },
];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function uid() { return Math.random().toString(36).slice(2, 10); }

// ---------------------------------------------------------------------------
// Claude API helpers
// ---------------------------------------------------------------------------
async function callClaude(systemPrompt, userText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return text;
}

function parseJSONLoose(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (match) { try { return JSON.parse(match[0]); } catch (e) {} }
  return null;
}

// ---------------------------------------------------------------------------
// Speech synthesis (playback) — free, browser-native
// ---------------------------------------------------------------------------
function speakFrench(text, slow = false) {
  return new Promise((resolve) => {
    try {
      window.speechSynthesis.cancel();
      const voices = window.speechSynthesis.getVoices();
      const frVoice = voices.find(v => (v.lang || '').toLowerCase().startsWith('fr'));

      if (!slow) {
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'fr-FR';
        utter.rate = 0.88;
        if (frVoice) utter.voice = frVoice;
        utter.onend = resolve;
        utter.onerror = resolve;
        window.speechSynthesis.speak(utter);
        return;
      }

      // Slow mode: many browsers (notably iOS Safari's standard-quality voices)
      // silently ignore utterance.rate, so a lower rate alone isn't reliably
      // audible. Instead, speak word-by-word with a pause between each —
      // this is perceptibly slower on every engine and doubles as clearer
      // pronunciation segmentation for shadowing practice.
      const words = text.split(/\s+/).filter(Boolean);
      let i = 0;
      const speakNext = () => {
        if (i >= words.length) { resolve(); return; }
        const utter = new SpeechSynthesisUtterance(words[i]);
        utter.lang = 'fr-FR';
        utter.rate = 0.7;
        if (frVoice) utter.voice = frVoice;
        const advance = () => { i++; setTimeout(speakNext, 260); };
        utter.onend = advance;
        utter.onerror = advance;
        window.speechSynthesis.speak(utter);
      };
      speakNext();
    } catch (e) { resolve(); }
  });
}

// ---------------------------------------------------------------------------
// Audio recording + resample + WAV encode (for Azure Speech)
// ---------------------------------------------------------------------------
async function recordAudio(durationMs, onStop) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  let mimeType = '';
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) { mimeType = m; break; }
  }
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start();
  const timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, durationMs);
  if (onStop) onStop(() => { clearTimeout(timer); if (recorder.state !== 'inactive') recorder.stop(); });
  await stopped;
  stream.getTracks().forEach(t => t.stop());
  return new Blob(chunks, { type: mimeType || 'audio/webm' });
}

function resampleTo16kMono(audioBuffer) {
  const targetRate = 16000;
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i] / numChannels;
  }
  const ratio = audioBuffer.sampleRate / targetRate;
  const newLength = Math.max(1, Math.floor(length / ratio));
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, length - 1);
    const frac = srcIndex - i0;
    result[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return result;
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

async function blobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  const resampled = resampleTo16kMono(audioBuffer);
  await ctx.close();
  return encodeWAV(resampled, 16000);
}

async function azurePronunciationAssess(wavBlob, referenceText, key, region) {
  const config = { ReferenceText: referenceText, GradingSystem: 'HundredMark', Granularity: 'Phoneme', EnableMiscue: true };
  const header = btoa(unescape(encodeURIComponent(JSON.stringify(config))));
  const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=fr-FR&format=detailed`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
      'Pronunciation-Assessment': header,
      'Accept': 'application/json',
    },
    body: wavBlob,
  });
  if (!res.ok) throw new Error(`Azure error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function azureTranscribe(wavBlob, key, region) {
  const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=fr-FR&format=detailed`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
      'Accept': 'application/json',
    },
    body: wavBlob,
  });
  if (!res.ok) throw new Error(`Azure error ${res.status}: ${await res.text()}`);
  return res.json();
}

function extractScores(azureJson) {
  const best = azureJson?.NBest?.[0];
  if (!best) return null;
  return {
    accuracy: best.PronunciationAssessment?.AccuracyScore ?? null,
    fluency: best.PronunciationAssessment?.FluencyScore ?? null,
    completeness: best.PronunciationAssessment?.CompletenessScore ?? null,
    overall: best.PronunciationAssessment?.PronScore ?? null,
    words: (best.Words || []).map(w => ({
      word: w.Word,
      accuracy: w.PronunciationAssessment?.AccuracyScore ?? null,
      errorType: w.PronunciationAssessment?.ErrorType ?? 'None',
      phonemes: (w.Phonemes || []).map(p => ({
        phoneme: p.Phoneme,
        accuracy: p.PronunciationAssessment?.AccuracyScore ?? null,
      })).filter(p => p.accuracy != null && p.accuracy < 70),
    })),
  };
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
async function loadState() {
  let app = null, azure = null, log = null;
  try { const r = await window.storage.get('app-data'); app = r ? JSON.parse(r.value) : null; } catch (e) {}
  try { const r = await window.storage.get('azure-config'); azure = r ? JSON.parse(r.value) : null; } catch (e) {}
  try { const r = await window.storage.get('conversation-log'); log = r ? JSON.parse(r.value) : null; } catch (e) {}
  return { app, azure, log };
}
async function saveApp(app) {
  try { await window.storage.set('app-data', JSON.stringify(app)); } catch (e) { console.error('save failed', e); }
}
async function saveAzure(cfg) {
  try { await window.storage.set('azure-config', JSON.stringify(cfg)); } catch (e) { console.error('save failed', e); }
}
async function saveLog(log) {
  try { await window.storage.set('conversation-log', JSON.stringify(log)); } catch (e) { console.error('save failed', e); }
}

function freshProfile() {
  return {
    level: 'true beginner',
    focusAreas: ['greetings', 'basic pronunciation'],
    streak: 0,
    lastSessionDate: null,
    totalMastered: 0,
    coachNote: 'Bienvenue ! Let\u2019s begin with the basics — greetings and everyday pronunciation.',
    weeklyNote: null,
    weeklyNoteDate: null,
  };
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------
function Chalk({ children, style, className }) {
  return <span style={{ fontFamily: "'Caveat', cursive", ...style }} className={className}>{children}</span>;
}

function ScoreBar({ label, value }) {
  const v = value == null ? 0 : Math.round(value);
  const color = v >= 80 ? C.good : v >= 55 ? C.or : C.rouge;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.chalkMuted, marginBottom: 3 }}>
        <span>{label}</span><span>{value == null ? '—' : `${v}`}</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'rgba(242,239,231,0.08)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${v}%`, background: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
      </div>
    </div>
  );
}

function SparkRow({ history }) {
  const last7 = history.slice(-7);
  const max = 100;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 40 }}>
      {last7.length === 0 && <span style={{ fontSize: 12, color: C.chalkMuted }}>No sessions yet</span>}
      {last7.map((h, i) => (
        <div key={i} title={`${h.avgScore}`} style={{
          width: 10, height: `${Math.max(6, (h.avgScore / max) * 40)}px`,
          background: h.avgScore >= 80 ? C.good : h.avgScore >= 55 ? C.or : C.rouge,
          borderRadius: 2, opacity: 0.9,
        }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function FrenchDashboard() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(freshProfile());
  const [vocabBank, setVocabBank] = useState([]);
  const [sessionHistory, setSessionHistory] = useState([]);
  const [conversationLog, setConversationLog] = useState([]);
  const [azureCfg, setAzureCfg] = useState({ key: '', region: '' });
  const [view, setView] = useState('home'); // home | settings | session | library | log
  const [settingsDraft, setSettingsDraft] = useState({ key: '', region: '' });

  useEffect(() => {
    (async () => {
      const { app, azure, log } = await loadState();
      if (app) {
        setProfile(app.profile || freshProfile());
        setVocabBank(app.vocabBank || []);
        setSessionHistory(app.sessionHistory || []);
      } else {
        const seeded = SEED_VOCAB.map(v => ({ id: uid(), fr: v.fr, en: v.en, box: 0, nextReview: todayISO(), status: 'new' }));
        setVocabBank(seeded);
      }
      if (azure) { setAzureCfg(azure); setSettingsDraft(azure); }
      if (log) setConversationLog(log);
      setLoading(false);
      window.speechSynthesis.getVoices();
    })();
  }, []);

  const persist = useCallback((next) => {
    const app = {
      profile: next.profile ?? profile,
      vocabBank: next.vocabBank ?? vocabBank,
      sessionHistory: next.sessionHistory ?? sessionHistory,
    };
    if (next.profile) setProfile(next.profile);
    if (next.vocabBank) setVocabBank(next.vocabBank);
    if (next.sessionHistory) setSessionHistory(next.sessionHistory);
    saveApp(app);
  }, [profile, vocabBank, sessionHistory]);

  const hasAzure = azureCfg.key && azureCfg.region;

  if (loading) {
    return (
      <div style={{ background: C.bg, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <style>{FONT_IMPORT}</style>
        <Loader2 className="animate-spin" color={C.chalk} size={28} />
      </div>
    );
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: "'Inter', sans-serif", color: C.chalk }}>
      <style>{FONT_IMPORT}</style>
      {view === 'home' && (
        <HomeView
          profile={profile}
          vocabBank={vocabBank}
          sessionHistory={sessionHistory}
          conversationLog={conversationLog}
          hasAzure={hasAzure}
          onStart={() => setView('session')}
          onSettings={() => { setSettingsDraft(azureCfg); setView('settings'); }}
          onLibrary={() => setView('library')}
          onLog={() => setView('log')}
        />
      )}
      {view === 'settings' && (
        <SettingsView
          draft={settingsDraft}
          setDraft={setSettingsDraft}
          onBack={() => setView('home')}
          onSave={async () => { setAzureCfg(settingsDraft); await saveAzure(settingsDraft); setView('home'); }}
        />
      )}
      {view === 'library' && (
        <LibraryView
          vocabBank={vocabBank}
          onBack={() => setView('home')}
          onUpdate={(nextBank) => persist({ vocabBank: nextBank })}
        />
      )}
      {view === 'log' && (
        <ConversationLogView
          conversationLog={conversationLog}
          onBack={() => setView('home')}
          onAdd={async (entry) => {
            const next = [...conversationLog, entry].slice(-50);
            setConversationLog(next);
            await saveLog(next);
          }}
        />
      )}
      {view === 'session' && (
        <SessionView
          profile={profile}
          vocabBank={vocabBank}
          sessionHistory={sessionHistory}
          conversationLog={conversationLog}
          azureCfg={azureCfg}
          onExit={() => setView('home')}
          onComplete={(next) => { persist(next); setView('home'); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function HomeView({ profile, vocabBank, sessionHistory, conversationLog, hasAzure, onStart, onSettings, onLibrary, onLog }) {
  const dueCount = vocabBank.filter(c => c.nextReview <= todayISO() && c.status !== 'new').length;
  const newCount = vocabBank.filter(c => c.status === 'new').length;
  const masteredCount = vocabBank.filter(c => c.box >= 5).length;
  const showWeekly = profile.weeklyNote && profile.weeklyNoteDate && profile.weeklyNoteDate >= addDays(todayISO(), -2);

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 'max(44px, calc(env(safe-area-inset-top) + 20px)) 20px 40px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
        <div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            Le Tableau
          </div>
          <div style={{ fontSize: 12, color: C.chalkMuted, marginTop: -2 }}>your French, chalked up daily</div>
        </div>
        <button onClick={onSettings} style={{ background: 'transparent', border: 'none', color: C.chalkMuted, padding: 8 }} aria-label="Settings">
          <Settings size={22} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        <div style={{ flex: 1, background: C.panel, borderRadius: 14, padding: '12px 14px', border: `1px solid ${C.panelLine}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.or }}>
            <Flame size={16} /><span style={{ fontFamily: "'Barlow Condensed'", fontSize: 20, fontWeight: 700 }}>{profile.streak}</span>
          </div>
          <div style={{ fontSize: 11, color: C.chalkMuted, marginTop: 2 }}>day streak</div>
        </div>
        <div style={{ flex: 1, background: C.panel, borderRadius: 14, padding: '12px 14px', border: `1px solid ${C.panelLine}` }}>
          <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 20, fontWeight: 700 }}>{masteredCount}</div>
          <div style={{ fontSize: 11, color: C.chalkMuted, marginTop: 2 }}>words mastered</div>
        </div>
        <div style={{ flex: 1, background: C.panel, borderRadius: 14, padding: '12px 14px', border: `1px solid ${C.panelLine}` }}>
          <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 15, fontWeight: 600, textTransform: 'capitalize' }}>{profile.level}</div>
          <div style={{ fontSize: 11, color: C.chalkMuted, marginTop: 2 }}>current level</div>
        </div>
      </div>

      {/* Hero session card */}
      <div style={{
        background: `radial-gradient(circle at 30% 20%, ${C.panel}, ${C.bg})`,
        border: `1px solid ${C.panelLine}`, borderRadius: 20, padding: 24, marginBottom: 18, position: 'relative', overflow: 'hidden',
      }}>
        <svg width="70" height="70" viewBox="0 0 70 70" style={{ position: 'absolute', top: 14, right: 14, opacity: 0.5 }}>
          <circle cx="35" cy="35" r="30" fill="none" stroke={C.or} strokeWidth="2.5" strokeDasharray="6 5" strokeLinecap="round" />
        </svg>
        <Chalk style={{ fontSize: 30, color: C.chalk, display: 'block' }}>Aujourd'hui</Chalk>
        <div style={{ fontSize: 13, color: C.chalkMuted, marginTop: 2, marginBottom: 16 }}>
          {dueCount} to review · {newCount || 5} new · one speaking prompt
        </div>
        <button
          onClick={onStart}
          style={{
            background: C.rouge, color: C.chalk, border: 'none', borderRadius: 12, padding: '14px 20px',
            fontFamily: "'Barlow Condensed'", fontSize: 17, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', cursor: 'pointer',
          }}
        >
          Start today's session <ChevronRight size={18} />
        </button>
        {!hasAzure && (
          <div style={{ fontSize: 11.5, color: C.chalkMuted, marginTop: 10 }}>
            Add your Azure Speech key in Settings to unlock pronunciation scoring.
          </div>
        )}
      </div>

      {profile.coachNote && (
        <div style={{ background: C.bleuDim, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: '14px 16px', marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.chalkMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>Coach's note</div>
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>{profile.coachNote}</div>
        </div>
      )}

      {showWeekly && (
        <div style={{ background: C.orDim, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: '14px 16px', marginBottom: 18 }}>
          <div style={{ fontSize: 11, color: C.chalkMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>This week's retrospective</div>
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>{profile.weeklyNote}</div>
        </div>
      )}

      <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: '14px 16px', marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.chalkMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 }}>Last 7 sessions — pronunciation</div>
        <SparkRow history={sessionHistory} />
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={onLibrary}
          style={{ flex: 1, background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 12, padding: '12px 14px', color: C.chalk, fontSize: 13.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, cursor: 'pointer' }}
        >
          <BookOpen size={15} /> Vocabulary ({vocabBank.length})
        </button>
        <button
          onClick={onLog}
          style={{ flex: 1, background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 12, padding: '12px 14px', color: C.chalk, fontSize: 13.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, cursor: 'pointer' }}
        >
          <RefreshCw size={15} /> Log a chat ({conversationLog.length})
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function SettingsView({ draft, setDraft, onBack, onSave }) {
  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 'max(36px, calc(env(safe-area-inset-top) + 12px)) 20px 40px' }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: C.chalkMuted, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0', marginBottom: 10 }}>
        <ArrowLeft size={18} /> Back
      </button>
      <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 24, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Azure Speech</div>
      <div style={{ fontSize: 13, color: C.chalkMuted, marginBottom: 20, lineHeight: 1.5 }}>
        Create a free Speech resource in the Azure portal to unlock phoneme-level pronunciation scoring. Your key is stored only on this device and sent directly to Azure — never through Claude.
      </div>

      <label style={{ fontSize: 12, color: C.chalkMuted, display: 'block', marginBottom: 6 }}>Subscription key</label>
      <input
        type="password"
        value={draft.key}
        onChange={e => setDraft({ ...draft, key: e.target.value })}
        placeholder="Paste your Azure Speech key"
        style={{ width: '100%', background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 10, padding: '12px 14px', color: C.chalk, fontSize: 14, marginBottom: 14, boxSizing: 'border-box' }}
      />

      <label style={{ fontSize: 12, color: C.chalkMuted, display: 'block', marginBottom: 6 }}>Region</label>
      <input
        type="text"
        value={draft.region}
        onChange={e => setDraft({ ...draft, region: e.target.value })}
        placeholder="e.g. westeurope, eastus"
        style={{ width: '100%', background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 10, padding: '12px 14px', color: C.chalk, fontSize: 14, marginBottom: 20, boxSizing: 'border-box' }}
      />

      <button
        onClick={onSave}
        style={{ background: C.rouge, color: C.chalk, border: 'none', borderRadius: 12, padding: '13px 20px', fontFamily: "'Barlow Condensed'", fontSize: 16, fontWeight: 600, textTransform: 'uppercase', width: '100%', cursor: 'pointer' }}
      >
        Save
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vocabulary library — browse everything learned, correct the SRS by hand
// ---------------------------------------------------------------------------
function LibraryView({ vocabBank, onBack, onUpdate }) {
  const [filter, setFilter] = useState('all'); // all | new | learning | mastered
  const [search, setSearch] = useState('');

  const statusOf = (c) => c.status === 'new' ? 'new' : c.box >= 5 ? 'mastered' : 'learning';
  const filtered = vocabBank.filter(c => {
    const matchesFilter = filter === 'all' || statusOf(c) === filter;
    const matchesSearch = !search || c.fr.toLowerCase().includes(search.toLowerCase()) || c.en.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  function markMastered(id) {
    onUpdate(vocabBank.map(c => c.id === id ? { ...c, box: 6, nextReview: addDays(todayISO(), 30) } : c));
  }
  function resetProgress(id) {
    onUpdate(vocabBank.map(c => c.id === id ? { ...c, box: 0, nextReview: todayISO(), status: 'learning' } : c));
  }

  const badgeStyle = (status) => ({
    fontSize: 10.5, padding: '2px 8px', borderRadius: 20, textTransform: 'uppercase', letterSpacing: 0.4,
    background: status === 'mastered' ? 'rgba(92,154,110,0.2)' : status === 'new' ? C.orDim : C.bleuDim,
    color: status === 'mastered' ? C.good : status === 'new' ? C.or : C.bleu,
  });

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 'max(36px, calc(env(safe-area-inset-top) + 12px)) 20px 40px' }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: C.chalkMuted, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0', marginBottom: 10 }}>
        <ArrowLeft size={18} /> Back
      </button>
      <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 24, fontWeight: 700, textTransform: 'uppercase', marginBottom: 14 }}>Vocabulary</div>

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search…"
        style={{ width: '100%', background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 10, padding: '10px 14px', color: C.chalk, fontSize: 14, marginBottom: 12, boxSizing: 'border-box' }}
      />

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {['all', 'new', 'learning', 'mastered'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              background: filter === f ? C.rouge : 'transparent', color: C.chalk, border: `1px solid ${filter === f ? C.rouge : C.panelLine}`,
              borderRadius: 20, padding: '6px 14px', fontSize: 12.5, textTransform: 'capitalize', cursor: 'pointer',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {filtered.length === 0 && <div style={{ fontSize: 13, color: C.chalkMuted, textAlign: 'center', padding: '30px 0' }}>Nothing here yet.</div>}

      {filtered.map(c => {
        const status = statusOf(c);
        return (
          <div key={c.id} style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 12, padding: '12px 14px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{c.fr}</div>
              <div style={{ fontSize: 12.5, color: C.chalkMuted }}>{c.en}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <span style={badgeStyle(status)}>{status}</span>
              {status !== 'mastered' && (
                <button onClick={() => markMastered(c.id)} title="Mark mastered" style={{ background: 'none', border: 'none', color: C.good, padding: 4, cursor: 'pointer' }}>
                  <Check size={16} />
                </button>
              )}
              {status !== 'new' && (
                <button onClick={() => resetProgress(c.id)} title="Reset progress" style={{ background: 'none', border: 'none', color: C.chalkMuted, padding: 4, cursor: 'pointer' }}>
                  <RefreshCw size={14} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation log — notes from real chats with French friends, feeds Claude
// ---------------------------------------------------------------------------
function ConversationLogView({ conversationLog, onBack, onAdd }) {
  const [notes, setNotes] = useState('');
  const [difficulty, setDifficulty] = useState('just right');
  const [saved, setSaved] = useState(false);

  function handleSave() {
    if (!notes.trim()) return;
    onAdd({ date: todayISO(), notes: notes.trim(), difficulty });
    setNotes('');
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 'max(36px, calc(env(safe-area-inset-top) + 12px)) 20px 40px' }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: C.chalkMuted, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0', marginBottom: 10 }}>
        <ArrowLeft size={18} /> Back
      </button>
      <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 24, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Log a real chat</div>
      <div style={{ fontSize: 13, color: C.chalkMuted, marginBottom: 18, lineHeight: 1.5 }}>
        A quick note after talking with a French friend — new words you hit, things you couldn't say, moments that clicked. Claude reads this when planning your next session.
      </div>

      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="e.g. Talked to Léa about weekend plans — couldn't remember how to say 'I'm tired', she taught me 'je suis fatigué(e)'…"
        rows={5}
        style={{ width: '100%', background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 10, padding: '12px 14px', color: C.chalk, fontSize: 14, marginBottom: 14, boxSizing: 'border-box', fontFamily: 'inherit', resize: 'vertical' }}
      />

      <div style={{ fontSize: 12, color: C.chalkMuted, marginBottom: 8 }}>How did it feel?</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {['too easy', 'just right', 'tough'].map(d => (
          <button
            key={d}
            onClick={() => setDifficulty(d)}
            style={{
              flex: 1, background: difficulty === d ? C.rouge : 'transparent', color: C.chalk, border: `1px solid ${difficulty === d ? C.rouge : C.panelLine}`,
              borderRadius: 10, padding: '9px 8px', fontSize: 12.5, textTransform: 'capitalize', cursor: 'pointer',
            }}
          >
            {d}
          </button>
        ))}
      </div>

      <button
        onClick={handleSave}
        style={{ background: saved ? C.good : C.rouge, color: C.chalk, border: 'none', borderRadius: 12, padding: '13px 20px', fontFamily: "'Barlow Condensed'", fontSize: 16, fontWeight: 600, textTransform: 'uppercase', width: '100%', cursor: 'pointer', marginBottom: 24 }}
      >
        {saved ? 'Saved ✓' : 'Save note'}
      </button>

      <div style={{ fontSize: 11, color: C.chalkMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 }}>Past notes</div>
      {conversationLog.length === 0 && <div style={{ fontSize: 13, color: C.chalkMuted }}>No notes yet — log your first chat above.</div>}
      {[...conversationLog].reverse().map((entry, i) => (
        <div key={i} style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 12, padding: '12px 14px', marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 11.5, color: C.chalkMuted }}>{entry.date}</span>
            <span style={{ fontSize: 11.5, color: C.or, textTransform: 'capitalize' }}>{entry.difficulty}</span>
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{entry.notes}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session flow: review -> new -> speak -> summary
// ---------------------------------------------------------------------------
function SessionView({ profile, vocabBank, sessionHistory, conversationLog, azureCfg, onExit, onComplete }) {
  const [step, setStep] = useState('review'); // review | new | speak | summary
  const [queue, setQueue] = useState(null); // built once
  const [idx, setIdx] = useState(0);
  const [newItems, setNewItems] = useState(null);
  const [scores, setScores] = useState([]); // collected pronunciation scores this session
  const [speakPrompt, setSpeakPrompt] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');

  const hasAzure = azureCfg.key && azureCfg.region;

  useEffect(() => {
    const due = vocabBank.filter(c => c.nextReview <= todayISO() && c.status !== 'new').slice(0, 8);
    setQueue(due);
  }, []); // eslint-disable-line

  // Transition between steps once their data is ready/empty — done in effects, not during render.
  useEffect(() => {
    if (step === 'review' && queue !== null && queue.length === 0) { setStep('new'); setIdx(0); }
  }, [step, queue]);
  useEffect(() => {
    if (step === 'new' && newItems !== null && newItems.length === 0) { setStep('speak'); setIdx(0); }
  }, [step, newItems]);

  // ---- Step: REVIEW ----
  if (step === 'review') {
    if (queue === null || queue.length === 0) return <SessionShell onExit={onExit}><LoadingBlock label="Loading review queue…" /></SessionShell>;
    const card = queue[idx];
    return (
      <SessionShell onExit={onExit} progressLabel={`Review ${idx + 1} / ${queue.length}`}>
        <PracticeCard
          french={card.fr}
          english={card.en}
          hasAzure={hasAzure}
          azureCfg={azureCfg}
          onResult={(res) => {
            setScores(s => [...s, res]);
            const updated = scoreToBox(card, res?.accuracy);
            const nextQueue = queue.slice();
            nextQueue[idx] = updated;
            setQueue(nextQueue);
          }}
          onNext={() => {
            if (idx + 1 < queue.length) setIdx(idx + 1);
            else { setStep('new'); setIdx(0); }
          }}
        />
      </SessionShell>
    );
  }

  // ---- Step: NEW ----
  if (step === 'new') {
    if (newItems === null) {
      generateNewContent();
      return <SessionShell onExit={onExit}><LoadingBlock label="Claude is picking today's new phrases…" /></SessionShell>;
    }
    if (newItems.length === 0) return <SessionShell onExit={onExit}><LoadingBlock label="Loading…" /></SessionShell>;
    const card = newItems[idx];
    return (
      <SessionShell onExit={onExit} progressLabel={`New phrase ${idx + 1} / ${newItems.length}`}>
        <PracticeCard
          french={card.fr}
          english={card.en}
          note={card.note}
          hasAzure={hasAzure}
          azureCfg={azureCfg}
          onResult={(res) => setScores(s => [...s, res])}
          onNext={() => {
            if (idx + 1 < newItems.length) setIdx(idx + 1);
            else { setStep('speak'); setIdx(0); }
          }}
        />
      </SessionShell>
    );
  }

  // ---- Step: SPEAK (free response) ----
  if (step === 'speak') {
    if (speakPrompt === null) {
      generateSpeakPrompt();
      return <SessionShell onExit={onExit}><LoadingBlock label="Claude is preparing a question for you…" /></SessionShell>;
    }
    return (
      <SessionShell onExit={onExit} progressLabel="Speaking prompt">
        <SpeakPrompt
          prompt={speakPrompt}
          hasAzure={hasAzure}
          azureCfg={azureCfg}
          onDone={(transcriptFeedback) => {
            setSummary({ pending: true, transcriptFeedback });
            setStep('summary');
          }}
        />
      </SessionShell>
    );
  }

  // ---- Step: SUMMARY ----
  if (step === 'summary') {
    if (summary?.pending) {
      generateSummary(summary.transcriptFeedback);
      return <SessionShell onExit={onExit}><LoadingBlock label="Claude is reviewing your progress…" /></SessionShell>;
    }
    if (!summary) return <SessionShell onExit={onExit}><LoadingBlock label="Wrapping up…" /></SessionShell>;
    return (
      <SessionShell onExit={onExit} hideBack>
        <div style={{ textAlign: 'center', paddingTop: 10 }}>
          <div style={{ width: 54, height: 54, borderRadius: '50%', background: C.good, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
            <Check color={C.bg} size={28} />
          </div>
          <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 24, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>Session complete</div>
          <div style={{ fontSize: 14, color: C.chalkMuted, marginBottom: 20 }}>
            Avg pronunciation score: <strong style={{ color: C.chalk }}>{summary.avgScore ?? '—'}</strong>
          </div>
        </div>
        <div style={{ background: C.bleuDim, border: `1px solid ${C.panelLine}`, borderRadius: 14, padding: '16px 18px', marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: C.chalkMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>Coach's note</div>
          <div style={{ fontSize: 14, lineHeight: 1.55 }}>{summary.coachNote}</div>
        </div>
        <button
          onClick={() => onComplete(summary.next)}
          style={{ background: C.rouge, color: C.chalk, border: 'none', borderRadius: 12, padding: '14px 20px', fontFamily: "'Barlow Condensed'", fontSize: 17, fontWeight: 600, textTransform: 'uppercase', width: '100%', cursor: 'pointer' }}
        >
          Back home
        </button>
      </SessionShell>
    );
  }

  return null;

  // --- helpers that close over state ---
  async function generateNewContent() {
    const weak = vocabBank.filter(c => c.box <= 1 && c.status !== 'new').map(c => c.fr);
    const recentChats = conversationLog.slice(-3).map(l => `[${l.date}, felt ${l.difficulty}] ${l.notes}`).join(' | ');
    const sys = `You are a supportive, precise French tutor for an English-speaking true-beginner-to-intermediate student. You will be given the student's level, focus areas, words they've struggled with, and notes from real conversations they've had with French friends. Respond with ONLY a JSON array (no prose, no markdown fences) of 5 objects: [{"fr": "French phrase", "en": "English translation", "note": "one short tip about pronunciation or usage"}]. Keep phrases short (2-6 words), practical, and appropriately paced for the student's level. If the real-conversation notes mention something they wanted to say but couldn't, prioritize teaching that. Do not repeat these already-known words: ${vocabBank.map(c => c.fr).join(', ')}.`;
    const usr = `Level: ${profile.level}. Focus areas: ${profile.focusAreas.join(', ')}. Recently struggled with: ${weak.join(', ') || 'none yet'}. Recent real-conversation notes: ${recentChats || 'none logged yet'}.`;
    try {
      const text = await callClaude(sys, usr);
      const parsed = parseJSONLoose(text);
      if (Array.isArray(parsed) && parsed.length) setNewItems(parsed);
      else setNewItems(SEED_VOCAB.slice(0, 3));
    } catch (e) {
      setError('Could not reach Claude — using a fallback set.');
      setNewItems(SEED_VOCAB.slice(0, 3));
    }
  }

  async function generateSpeakPrompt() {
    const sys = `You are a French tutor. Respond with ONLY JSON, no prose: {"question_fr": "...", "question_en": "...", "hint": "short hint in English about how to structure an answer"}. Write one short, simple spoken question in French appropriate for a ${profile.level} student, related to: ${profile.focusAreas.join(', ')}.`;
    try {
      const text = await callClaude(sys, 'Generate the question now.');
      const parsed = parseJSONLoose(text);
      setSpeakPrompt(parsed || { question_fr: 'Comment vous appelez-vous ?', question_en: 'What is your name?', hint: 'Answer with "Je m\u2019appelle..."' });
    } catch (e) {
      setSpeakPrompt({ question_fr: 'Comment vous appelez-vous ?', question_en: 'What is your name?', hint: 'Answer with "Je m\u2019appelle..."' });
    }
  }

  async function generateSummary(transcriptFeedback) {
    const avg = scores.length ? Math.round(scores.reduce((a, s) => a + (s?.accuracy || 0), 0) / scores.length) : null;
    const sys = `You are an encouraging but honest French tutor reviewing a student's practice session. Respond with ONLY JSON, no prose: {"level": "beginner label", "focus_areas": ["...","..."], "coach_note": "3-4 warm sentences: what went well, what to focus on next, and one concrete tip", "mark_mastered_count": 0}. Base your assessment on the data given.`;
    const usr = `Current level: ${profile.level}. Current focus: ${profile.focusAreas.join(', ')}. Streak: ${profile.streak} days. Pronunciation scores this session (0-100): ${scores.map(s => s?.accuracy).filter(x => x != null).join(', ') || 'none captured'}. Free-response exchange: ${transcriptFeedback || 'not captured'}.`;
    let parsed = null;
    try {
      const text = await callClaude(sys, usr);
      parsed = parseJSONLoose(text);
    } catch (e) {}
    const level = parsed?.level || profile.level;
    const focusAreas = parsed?.focus_areas?.length ? parsed.focus_areas : profile.focusAreas;
    const coachNote = parsed?.coach_note || 'Nice work today — keep showing up and it adds up fast.';

    const wasYesterday = profile.lastSessionDate === addDays(todayISO(), -1);
    const alreadyToday = profile.lastSessionDate === todayISO();
    const newStreak = alreadyToday ? profile.streak : (wasYesterday ? profile.streak + 1 : 1);

    const nextProfile = {
      ...profile,
      level, focusAreas, coachNote,
      streak: newStreak,
      lastSessionDate: todayISO(),
      totalMastered: vocabBank.filter(c => c.box >= 5).length,
    };

    const addedNew = (newItems || []).map(it => ({ id: uid(), fr: it.fr, en: it.en, box: 0, nextReview: todayISO(), status: 'learning' }));
    // Merge: original bank + any box/nextReview updates from today's review queue + newly introduced cards.
    const mergedVocab = mergeVocab(vocabBank, queue || [], addedNew);

    const nextHistory = [...sessionHistory, { date: todayISO(), avgScore: avg ?? 0 }].slice(-30);

    let weeklyNote = profile.weeklyNote;
    let weeklyNoteDate = profile.weeklyNoteDate;
    if (nextHistory.length >= 7 && nextHistory.length % 7 === 0) {
      const last7 = nextHistory.slice(-7);
      const trend = last7.map(h => h.avgScore).join(', ');
      const chatNotes = conversationLog.slice(-7).map(l => l.notes).join(' | ') || 'none logged';
      try {
        const wsys = `You are a French tutor giving a weekly retrospective. Respond with ONLY JSON, no prose: {"note": "3-4 sentences on the trend across the week — what's genuinely improving, what's plateaued, and one focus for next week"}.`;
        const wusr = `Last 7 session pronunciation scores (0-100, chronological): ${trend}. Real-conversation notes this week: ${chatNotes}. Current focus areas: ${focusAreas.join(', ')}.`;
        const wtext = await callClaude(wsys, wusr);
        const wparsed = parseJSONLoose(wtext);
        if (wparsed?.note) { weeklyNote = wparsed.note; weeklyNoteDate = todayISO(); }
      } catch (e) { /* skip weekly note on failure, not critical */ }
    }

    nextProfile.weeklyNote = weeklyNote;
    nextProfile.weeklyNoteDate = weeklyNoteDate;

    setSummary({ avgScore: avg, coachNote, next: { profile: nextProfile, vocabBank: mergedVocab, sessionHistory: nextHistory } });
  }
}

function mergeVocab(original, reviewedQueue, addedNew) {
  const byId = new Map(original.map(c => [c.id, c]));
  reviewedQueue.forEach(c => byId.set(c.id, c));
  addedNew.forEach(c => byId.set(c.id, c));
  return Array.from(byId.values());
}

function scoreToBox(card, accuracy) {
  const good = accuracy != null && accuracy >= 70;
  const nextBox = good ? Math.min(6, card.box + 1) : 1;
  const intervals = [0, 1, 2, 4, 7, 14, 30];
  return { ...card, box: nextBox, nextReview: addDays(todayISO(), intervals[nextBox]), status: 'learning' };
}

function SessionShell({ children, onExit, progressLabel, hideBack }) {
  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 'max(36px, calc(env(safe-area-inset-top) + 12px)) 20px 40px', minHeight: '100vh', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        {!hideBack ? (
          <button onClick={onExit} style={{ background: 'none', border: 'none', color: C.chalkMuted, display: 'flex', alignItems: 'center', gap: 6, padding: 0 }}>
            <X size={20} />
          </button>
        ) : <span />}
        {progressLabel && <span style={{ fontSize: 12, color: C.chalkMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{progressLabel}</span>}
        <span style={{ width: 20 }} />
      </div>
      {children}
    </div>
  );
}

function LoadingBlock({ label }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 14 }}>
      <Loader2 className="animate-spin" color={C.or} size={26} />
      <span style={{ fontSize: 13, color: C.chalkMuted }}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Practice card (shadow + record + assess)
// ---------------------------------------------------------------------------
function PracticeCard({ french, english, note, hasAzure, azureCfg, onResult, onNext }) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [slow, setSlow] = useState(false);
  const stopFnRef = useRef(null);

  async function handleRecord() {
    setErr(''); setResult(null);
    if (!hasAzure) { setErr('Add your Azure key in Settings to get a pronunciation score.'); return; }
    try {
      setRecording(true);
      const blob = await recordAudio(4000, (stopFn) => { stopFnRef.current = stopFn; });
      setRecording(false);
      setBusy(true);
      const wav = await blobToWav(blob);
      const azureJson = await azurePronunciationAssess(wav, french, azureCfg.key, azureCfg.region);
      const scores = extractScores(azureJson);
      setResult(scores);
      onResult(scores);
    } catch (e) {
      setErr(e.message || 'Could not assess that recording.');
    } finally {
      setRecording(false); setBusy(false);
    }
  }

  const troublePhonemes = result?.words
    ?.flatMap(w => w.phonemes.map(p => ({ ...p, word: w.word })))
    ?.sort((a, b) => a.accuracy - b.accuracy)
    ?.slice(0, 4) || [];

  return (
    <div>
      <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 18, padding: 24, marginBottom: 16 }}>
        <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 30, fontWeight: 700, marginBottom: 6 }}>{french}</div>
        <div style={{ fontSize: 14, color: C.chalkMuted, marginBottom: 18 }}>{english}</div>
        {note && <div style={{ fontSize: 12.5, color: C.or, marginBottom: 14 }}>💡 {note}</div>}

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => speakFrench(french, slow)}
            style={{ flex: 1, background: C.bleuDim, color: C.chalk, border: `1px solid ${C.panelLine}`, borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer' }}
          >
            <Volume2 size={17} /> Listen
          </button>
          <button
            onClick={() => setSlow(s => !s)}
            title="Toggle slow playback"
            style={{ background: slow ? C.or : 'transparent', color: slow ? C.bg : C.chalkMuted, border: `1px solid ${slow ? C.or : C.panelLine}`, borderRadius: 10, padding: '10px 14px', fontSize: 12.5, cursor: 'pointer', fontWeight: 600 }}
          >
            Slow
          </button>
        </div>

        <button
          onClick={handleRecord}
          disabled={recording || busy}
          style={{
            background: recording ? C.rouge : C.rougeDim, color: C.chalk, border: `1px solid ${recording ? C.rouge : C.panelLine}`,
            borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', width: '100%', justifyContent: 'center',
          }}
        >
          {busy ? <Loader2 className="animate-spin" size={17} /> : recording ? <Square size={17} /> : <Mic size={17} />}
          {busy ? 'Scoring…' : recording ? 'Recording — 4s' : 'Record yourself'}
        </button>

        {err && <div style={{ fontSize: 12.5, color: C.rouge, marginTop: 10 }}>{err}</div>}

        {result && (
          <div style={{ marginTop: 18 }}>
            <ScoreBar label="Accuracy" value={result.accuracy} />
            <ScoreBar label="Fluency" value={result.fluency} />
            <ScoreBar label="Overall" value={result.overall} />
            {result.words?.some(w => w.errorType !== 'None') && (
              <div style={{ fontSize: 12.5, color: C.chalkMuted, marginTop: 8 }}>
                Watch: {result.words.filter(w => w.errorType !== 'None').map(w => w.word).join(', ')}
              </div>
            )}
            {troublePhonemes.length > 0 && (
              <div style={{ marginTop: 10, background: 'rgba(193,69,58,0.10)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, color: C.chalkMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Sounds to work on</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {troublePhonemes.map((p, i) => (
                    <span key={i} style={{ fontSize: 12.5, background: C.rougeDim, borderRadius: 8, padding: '3px 8px' }}>
                      /{p.phoneme}/ in "{p.word}" ({Math.round(p.accuracy)})
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <button
        onClick={onNext}
        style={{ background: 'transparent', color: C.chalk, border: `1px solid ${C.panelLine}`, borderRadius: 12, padding: '13px 20px', fontFamily: "'Barlow Condensed'", fontSize: 16, fontWeight: 600, textTransform: 'uppercase', width: '100%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
      >
        Next <ChevronRight size={18} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Free-response speaking prompt
// ---------------------------------------------------------------------------
function SpeakPrompt({ prompt, hasAzure, azureCfg, onDone }) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [err, setErr] = useState('');
  const [slow, setSlow] = useState(false);

  async function handleRecord() {
    setErr(''); setFeedback(null); setTranscript('');
    if (!hasAzure) { setErr('Add your Azure key in Settings to record answers.'); return; }
    try {
      setRecording(true);
      const blob = await recordAudio(6000);
      setRecording(false);
      setBusy(true);
      const wav = await blobToWav(blob);
      const azureJson = await azureTranscribe(wav, azureCfg.key, azureCfg.region);
      const text = azureJson?.DisplayText || azureJson?.NBest?.[0]?.Display || '';
      setTranscript(text);
      const sys = `You are a warm, precise French tutor. The student was asked a question in French and gave a spoken answer (auto-transcribed, may have minor transcription errors). Respond with ONLY JSON, no prose: {"feedback": "2-3 sentences: what was correct, one specific correction if needed, said directly and kindly"}.`;
      const usr = `Question: ${prompt.question_fr} (${prompt.question_en}). Student's transcribed answer: "${text}".`;
      const respText = await callClaude(sys, usr);
      const parsed = parseJSONLoose(respText);
      const fb = parsed?.feedback || 'Good attempt — keep practicing this structure.';
      setFeedback(fb);
    } catch (e) {
      setErr(e.message || 'Could not process that recording.');
    } finally {
      setRecording(false); setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ background: C.panel, border: `1px solid ${C.panelLine}`, borderRadius: 18, padding: 24, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: C.chalkMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>Answer out loud</div>
        <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 26, fontWeight: 700, marginBottom: 6 }}>{prompt.question_fr}</div>
        <div style={{ fontSize: 14, color: C.chalkMuted, marginBottom: 10 }}>{prompt.question_en}</div>
        {prompt.hint && <div style={{ fontSize: 12.5, color: C.or, marginBottom: 16 }}>💡 {prompt.hint}</div>}

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => speakFrench(prompt.question_fr, slow)}
            style={{ flex: 1, background: C.bleuDim, color: C.chalk, border: `1px solid ${C.panelLine}`, borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer' }}
          >
            <Volume2 size={17} /> Hear the question
          </button>
          <button
            onClick={() => setSlow(s => !s)}
            title="Toggle slow playback"
            style={{ background: slow ? C.or : 'transparent', color: slow ? C.bg : C.chalkMuted, border: `1px solid ${slow ? C.or : C.panelLine}`, borderRadius: 10, padding: '10px 14px', fontSize: 12.5, cursor: 'pointer', fontWeight: 600 }}
          >
            Slow
          </button>
        </div>

        <button
          onClick={handleRecord}
          disabled={recording || busy}
          style={{
            background: recording ? C.rouge : C.rougeDim, color: C.chalk, border: `1px solid ${recording ? C.rouge : C.panelLine}`,
            borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', width: '100%', justifyContent: 'center',
          }}
        >
          {busy ? <Loader2 className="animate-spin" size={17} /> : recording ? <Square size={17} /> : <Mic size={17} />}
          {busy ? 'Thinking…' : recording ? 'Recording — 6s' : 'Record your answer'}
        </button>

        {err && <div style={{ fontSize: 12.5, color: C.rouge, marginTop: 10 }}>{err}</div>}
        {transcript && <div style={{ fontSize: 13, color: C.chalkMuted, marginTop: 14, fontStyle: 'italic' }}>You said: "{transcript}"</div>}
        {feedback && (
          <div style={{ background: C.bleuDim, borderRadius: 10, padding: '12px 14px', marginTop: 12, fontSize: 13.5, lineHeight: 1.5 }}>
            {feedback}
          </div>
        )}
      </div>

      <button
        onClick={() => onDone(transcript ? `Q: ${prompt.question_fr} / A: ${transcript}` : null)}
        disabled={!feedback}
        style={{
          background: feedback ? C.rouge : 'rgba(242,239,231,0.08)', color: C.chalk, border: 'none', borderRadius: 12, padding: '14px 20px',
          fontFamily: "'Barlow Condensed'", fontSize: 17, fontWeight: 600, textTransform: 'uppercase', width: '100%',
          cursor: feedback ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}
      >
        Finish session <ChevronRight size={18} />
      </button>
    </div>
  );
}
