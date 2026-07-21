import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Send, Mic, Phone, PhoneOff, Settings, X, Check, Play, Pause, Sparkles, Trash2, Download, FileText, Volume2, Square } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  useGetOnboardingStatus,
  useSubmitOnboardingAnswer,
  useGetMessages,
  useGetProfile,
  useUpdateProfile,
  getGetOnboardingStatusQueryKey,
  getGetMessagesQueryKey,
  getGetProfileQueryKey,
} from "@workspace/api-client-react";

import { useContextualGreeting } from "@/api/contextualGreeting";
import { ChangeEmailForm } from "@/components/ChangeEmailForm";
import { chatMessageSchema, type ChatMessageFormValues } from "@/lib/schemas";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSpeechRecognition, speakText, stopSpeaking, unlockAudioOnGesture } from "@/lib/voice";
import { startRealtimeCall, type RealtimeConversation, type RealtimeSessionInfo } from "@/lib/realtimeVoice";
import { cn } from "@/lib/utils";

// ─── Voice catalogue ──────────────────────────────────────────────────────────
// All times accent + feel labels so the user can choose by character, not ID.

const FEMALE_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel",  accent: "American",   feel: "calm & warm",           age: "middle"  },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella",   accent: "American",   feel: "soft & friendly",       age: "younger" },
  { id: "piTKgcLEGmPE4e6mEKli", label: "Nicole",  accent: "American",   feel: "soft & intimate",       age: "younger" },
  { id: "MF3mGyEYCl7XYWbV9V6O", label: "Elli",    accent: "American",   feel: "expressive & warm",     age: "younger" },
  { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda", accent: "American",   feel: "warm & friendly",       age: "middle"  },
  { id: "pFZP5JQG7iQjIQuC4Bku", label: "Lily",    accent: "British",    feel: "gentle & soothing",     age: "middle"  },
  { id: "Xb7hH8MSUJpSbSDYk0k2", label: "Alice",   accent: "British",    feel: "confident & clear",     age: "middle"  },
];

const MALE_VOICES = [
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni",  accent: "American",   feel: "warm & natural",        age: "younger" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam",    accent: "American",   feel: "deep & grounded",       age: "middle"  },
  { id: "nPczCjzI2devNBz1zQrb", label: "Brian",   accent: "American",   feel: "deep & comforting",     age: "middle"  },
  { id: "TX3LPaxmHKxFdv7VOQHJ", label: "Liam",    accent: "American",   feel: "natural & relaxed",     age: "younger" },
  { id: "JBFqnCBsd6RMkjVDRZzb", label: "George",  accent: "British",    feel: "warm & refined",        age: "mature"  },
  { id: "IKne3meq5aSn9XLyUdCD", label: "Charlie", accent: "Australian", feel: "casual & easygoing",    age: "younger" },
];

// Romantic voices are community voices added to the account at startup.
// accountVoiceId comes from /api/voices/status — null means still setting up / unavailable.
interface RomanticVoiceStatus {
  libraryId: string;
  name: string;
  label: string;
  desc: string;
  gender: "female" | "male";
  resolved: boolean;
  accountVoiceId: string | null;
}

const PREVIEW_SAMPLE = "I'm right here with you. Take all the time you need.";
const DEFAULT_FEMALE_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const DEFAULT_MALE_VOICE   = "pNInz6obpgDQGcFmaJgB"; // Adam

// ─── "How Eos speaks" — voice-call delivery preference ───────────────────────
const VOICE_TONE_OPTIONS = [
  { value: "auto",   label: "Let Eos decide",      desc: "She adapts to the moment — softer when it's heavy, brighter when you are" },
  { value: "gentle", label: "Gentle & empathetic", desc: "Extra-soft and tender — feelings come first" },
  { value: "calm",   label: "Calm & steady",       desc: "Slow, grounded, unhurried" },
  { value: "upbeat", label: "Warm & upbeat",       desc: "Encouraging, with gentle energy" },
] as const;

// ElevenLabs voice-minute quota exhausted (HTTP quota errors or WS close 1002)
// — never surface a raw error for this; she just needs a rest.
const VOICE_REST_MESSAGE =
  "My voice needs a little rest right now — but I'm right here with you in text.";
const isQuotaFailure = (s?: string | null) =>
  !!s && (/quota/i.test(s) || /code\s*1002\b/i.test(s));

// ─── Onboarding choice buttons ────────────────────────────────────────────────

const STEP_CHOICES: Record<string, Array<{ label: string; value: string }>> = {
  purpose: [
    { label: "I'm feeling lonely", value: "lonely" },
    { label: "I want emotional support", value: "support" },
    { label: "I'm going through a breakup", value: "breakup" },
    { label: "I lost someone", value: "bereavement" },
  ],
  path: [
    { label: "I'm feeling lonely", value: "lonely" },
    { label: "I want emotional support", value: "support" },
    { label: "I'm going through a breakup", value: "breakup" },
    { label: "I lost someone", value: "bereavement" },
  ],
  companionGender: [
    { label: "A woman (she/her)", value: "woman" },
    { label: "A man (he/him)", value: "man" },
    { label: "Non-binary / no preference", value: "nonbinary" },
  ],
  country: [
    { label: "United States", value: "US" },
    { label: "United Kingdom", value: "UK" },
    { label: "Australia", value: "AU" },
    { label: "Other country", value: "other" },
  ],
  ageBand: [
    { label: "18–25", value: "18-25" },
    { label: "26–35", value: "26-35" },
    { label: "36–50", value: "36-50" },
    { label: "50 or over", value: "50+" },
  ],
  userGender: [
    { label: "Man", value: "man" },
    { label: "Woman", value: "woman" },
    { label: "Other", value: "other" },
    { label: "Skip this one", value: "skip" },
  ],
};

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex space-x-1.5 items-center bg-card/60 w-fit px-4 py-3 rounded-2xl rounded-tl-sm border border-primary/12 shadow-sm backdrop-blur-sm">
      {[0, 0.2, 0.4].map((delay, i) => (
        <motion.div
          key={i}
          className="w-1.5 h-1.5 bg-secondary/50 rounded-full"
          animate={{ y: [0, -3, 0] }}
          transition={{ duration: 0.65, repeat: Infinity, delay }}
        />
      ))}
    </div>
  );
}

// ─── Speaking waveform indicator ─────────────────────────────────────────────

function SpeakingBars() {
  return (
    <div className="flex items-end gap-[2px] h-3 ml-1.5">
      {[0, 0.15, 0.3, 0.15].map((delay, i) => (
        <motion.div
          key={i}
          className="w-[2px] bg-primary/70 rounded-full"
          animate={{ height: ["3px", "10px", "3px"] }}
          transition={{ duration: 0.55, repeat: Infinity, delay, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}

// ─── Live caption component ───────────────────────────────────────────────────
// Reveals words one at a time in sync with audio playback.
// revealedWords: how many words to show (0 = nothing yet, totalWords = all done).
// The most recently revealed word gets a gentle gold highlight.

function LiveCaption({ text, revealedWords }: { text: string; revealedWords: number }) {
  const words = text.trim().split(/\s+/);
  const shown = words.slice(0, revealedWords);

  return (
    <>
      {shown.map((word, i) => {
        const isCurrentWord = i === revealedWords - 1;
        return (
          <span key={i}>
            <motion.span
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className={cn(
                "inline-block",
                isCurrentWord
                  ? "text-primary/95 font-[490]"  // gold tint on current word
                  : "text-foreground/90",
              )}
            >
              {word}
            </motion.span>
            {i < shown.length - 1 && " "}
          </span>
        );
      })}
      {revealedWords === 0 && (
        // Nothing yet — show a subtle pulsing dot so the bubble isn't empty
        <motion.span
          animate={{ opacity: [0.2, 0.6, 0.2] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
          className="inline-block w-1.5 h-1.5 rounded-full bg-primary/50 align-middle"
        />
      )}
    </>
  );
}

// ─── Main Chat component ──────────────────────────────────────────────────────

export default function Chat() {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: onboarding } = useGetOnboardingStatus();
  const { data: profile } = useGetProfile();
  const { data: messages = [] } = useGetMessages({
    query: { queryKey: getGetMessagesQueryKey(), enabled: !!onboarding?.isComplete },
  });

  const contextualGreeting = useContextualGreeting();
  const submitAnswer = useSubmitOnboardingAnswer();
  const updateProfile = useUpdateProfile();

  const [isTyping, setIsTyping] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [continuousVoice, setContinuousVoice] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  // Streaming state: text accumulates token-by-token while the model generates
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  // Live-caption state: which message is currently being spoken, and how many words revealed
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [revealedWords, setRevealedWords] = useState(0);
  // Voice call mode state
  const [voiceCallPhase, setVoiceCallPhase] = useState<"listening" | "thinking" | "speaking" | "error">("listening");
  const [voiceCallMessage, setVoiceCallMessage] = useState<string | null>(null); // sub-label / error text
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Voice picker filters
  const [voiceGenderFilter, setVoiceGenderFilter] = useState<"all" | "female" | "male">("all");
  const [voiceAccentFilter, setVoiceAccentFilter] = useState<"all" | "American" | "British" | "Australian">("all");
  const [voiceAgeFilter, setVoiceAgeFilter] = useState<"all" | "younger" | "middle" | "mature">("all");
  const morningNoteTriggered = useRef(false);
  // Refs so async TTS / recognition callbacks always read the latest values
  const continuousVoiceRef = useRef(false);
  const voiceCallPhaseRef  = useRef<"listening" | "thinking" | "speaking" | "error">("listening");
  // Voice early-TTS coordination: lets the first-sentence TTS and the stream-done
  // handler share state without race conditions.
  const voicePendingRemainderRef = useRef<{ text: string; id: string | null } | null>(null);
  const voiceEarlyTTSEndedRef    = useRef(false);
  // Tracks how many words were in the early (first-sentence) TTS chunk so the
  // remainder's onWordReveal can offset its count correctly.
  const earlyWordCountRef        = useRef(0);
  // ── Barge-in / interrupt machinery ──────────────────────────────────────
  // Generation counter: bumped on every new user turn AND every interrupt.
  // Every TTS-starting code path captures the value at message start and
  // re-checks it before speaking — a stale generation means the user cut in,
  // so the reply lands in chat silently instead of talking over them.
  const voiceTtsGenRef   = useRef(0);
  // The text the companion is currently speaking — used to filter out the
  // mic picking up her own voice (echo) while barge-in listening is armed.
  const spokenTextRef    = useRef("");
  // Echo-cancelled getUserMedia keepalive stream (best-effort AEC hint) held
  // for the duration of the call; also surfaces mic-permission errors early.
  const micStreamRef     = useRef<MediaStream | null>(null);
  // Abort handle for the in-flight chat stream so a barge-in turn can cancel
  // the previous request instead of running two generations concurrently.
  const streamAbortRef   = useRef<AbortController | null>(null);
  // ── Voice engine ──────────────────────────────────────────────────────────
  // "realtime": ElevenLabs Conversational AI owns the audio loop — native
  //             listening, turn-taking, and barge-in; Claude stays the brain
  //             via our custom-LLM endpoint.
  // "classic":  browser SpeechRecognition + sentence TTS (fallback mode).
  const [voiceEngine, setVoiceEngine] = useState<"realtime" | "classic" | null>(null);
  const voiceEngineRef   = useRef<"realtime" | "classic" | null>(null);
  const realtimeConvoRef = useRef<RealtimeConversation | null>(null);
  // Session identity for realtime calls — bumped at every call start AND end.
  // Callbacks capture the value at registration; late events from a previous
  // session (delayed onDisconnect, stale transcripts) compare and no-op, so
  // they can never tear down or pollute a newer call.
  const realtimeGenRef = useRef(0);
  // One-line note shown in the call overlay when realtime isn't available.
  const [realtimeNote, setRealtimeNote] = useState<string | null>(null);
  // Voice call live-caption state — words revealed in sync with ElevenLabs audio.
  const [voiceCallCaptionText,     setVoiceCallCaptionText]     = useState("");
  const [voiceCallCaptionRevealed, setVoiceCallCaptionRevealed] = useState(0);
  // What the user said — shown under "You said:" while the AI is thinking/speaking
  const [voiceCallRecognizedText, setVoiceCallRecognizedText] = useState("");
  useEffect(() => { continuousVoiceRef.current = continuousVoice; }, [continuousVoice]);
  // NOTE: voiceCallPhaseRef is intentionally NOT synced via useEffect.
  // It must be set synchronously alongside every setVoiceCallPhase call so that
  // recognition callbacks (onend, onerror) that fire before React re-renders can
  // read the correct phase. See handleVoiceResult / handleRecognitionError.

  const isBereavement = profile?.userPath === "bereavement";
  const companionGender = (profile as any)?.companionGender ?? "woman";
  const activeVoiceId = (profile as any)?.voiceId ?? (companionGender === "man" ? DEFAULT_MALE_VOICE : DEFAULT_FEMALE_VOICE);
  const activeVoiceTone: string = (profile as any)?.voiceTone ?? "auto";

  // Fetch romantic voice availability from the server
  const { data: voicesStatus } = useQuery<{ romantic: RomanticVoiceStatus[]; voiceCallEnabled?: boolean }>({
    queryKey: ["voices-status"],
    queryFn: () => apiFetch(`${import.meta.env.BASE_URL}api/voices/status`).then((r) => r.json()),
    staleTime: 60_000,
    retry: false,
  });
  const romanticVoices = voicesStatus?.romantic ?? [];
  // Server-driven feature flag: the realtime Voice Call entry point stays hidden
  // until the ElevenLabs agent is fully configured (VOICE_CALL_ENABLED=true on
  // the api-server — no frontend rebuild needed). Defaults to hidden while the
  // status query is loading or unavailable. The per-message "Listen" TTS buttons
  // are unaffected by this flag.
  const voiceCallEnabled = voicesStatus?.voiceCallEnabled ?? false;

  // Current account email — reuse the auth/me cache the AuthGate already populated.
  const { data: authMe } = useQuery<{ user: { id: number; email: string }; emailVerified: boolean }>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/auth/me`);
      if (!r.ok) throw new Error("Not authenticated");
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const accountEmail = authMe?.user.email ?? "";
  const [showChangeEmail, setShowChangeEmail] = useState(false);

  // Build filtered voice list for picker
  // Standard voices — companion's own gender shown first
  const orderedStandard = companionGender === "man"
    ? [...MALE_VOICES, ...FEMALE_VOICES]
    : [...FEMALE_VOICES, ...MALE_VOICES];

  const filteredStandardVoices = orderedStandard.filter((v) => {
    const isFemale = FEMALE_VOICES.some((f) => f.id === v.id);
    if (voiceGenderFilter === "female" && !isFemale) return false;
    if (voiceGenderFilter === "male"   &&  isFemale) return false;
    if (voiceAccentFilter !== "all" && v.accent !== voiceAccentFilter) return false;
    if (voiceAgeFilter    !== "all" && v.age    !== voiceAgeFilter)    return false;
    return true;
  });

  // Sync rename input with loaded profile
  useEffect(() => {
    if (profile?.companionName && !renameValue) {
      setRenameValue(profile.companionName);
    }
  }, [profile?.companionName]);

  const form = useForm<ChatMessageFormValues>({
    resolver: zodResolver(chatMessageSchema),
    defaultValues: { content: "" },
  });

  const contextualGreetingMutate = contextualGreeting.mutate;

  // Contextual greeting — fires once per browser session; server decides whether to generate one
  // based on time-of-day slot and how long since the last greeting.
  useEffect(() => {
    if (onboarding?.isComplete && !morningNoteTriggered.current) {
      morningNoteTriggered.current = true;
      contextualGreetingMutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding?.isComplete]);

  // Scroll to bottom on new content (including streaming tokens)
  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, onboarding?.currentStep, isTyping, streamingContent]);

  // ─── Shared speak helper ──────────────────────────────────────────────────
  // messageId: when provided, drives live captions for that message bubble.

  const handleSpeak = (text: string, messageId?: string) => {
    // During a realtime call the ElevenLabs agent owns ALL audio — never start
    // local TTS on top of it (speaker buttons, greetings, onboarding replies).
    if (voiceEngineRef.current === "realtime") return;
    // Stale-guard for call-mode phase transitions (see speakVoiceRemainder).
    const gen = voiceTtsGenRef.current;
    if (messageId) {
      setSpeakingMessageId(messageId);
      setRevealedWords(0);
    }
    if (continuousVoiceRef.current) spokenTextRef.current = text;
    speakText(text, {
      voiceId: activeVoiceId,
      onStart: () => {
        setIsSpeaking(true);
        if (continuousVoiceRef.current && voiceTtsGenRef.current === gen) {
          voiceCallPhaseRef.current = "speaking";
          setVoiceCallPhase("speaking");
          voice.startListening(); // arm the mic for voice barge-in
        }
      },
      onEnd: () => {
        setIsSpeaking(false);
        setSpeakingMessageId(null);
        setRevealedWords(0);
        setVoiceCallMessage(null);
        if (continuousVoiceRef.current && voiceTtsGenRef.current === gen) {
          voiceCallPhaseRef.current = "listening";
          setVoiceCallPhase("listening");
          setVoiceCallRecognizedText("");
          voice.startListening();
        }
      },
      onWordReveal: messageId
        ? (count, total) => {
            setSpeakingMessageId(messageId);
            setRevealedWords(count);
            // On final word, keep revealed so text stays fully visible until onEnd clears state
            if (count >= total) setRevealedWords(total);
          }
        : undefined,
    });
  };

  // ─── Streaming send (chat mode) ───────────────────────────────────────────
  // Opens an SSE connection to /api/chat/stream. Tokens arrive as `delta` events
  // and are appended to `streamingContent` so the user sees text building in real
  // time. On `done` we get the persisted messageId, invalidate the query, then
  // hand off to TTS + live captions.

  const sendStreamingMessage = async (content: string) => {
    // New user turn: invalidate any pending TTS from the previous reply and
    // cancel any still-running stream (e.g. after a barge-in mid-generation)
    // so two generations never run — or speak — concurrently.
    const ttsGen = ++voiceTtsGenRef.current;
    streamAbortRef.current?.abort();
    const streamAbort = new AbortController();
    streamAbortRef.current = streamAbort;

    setIsStreaming(true);
    setStreamingContent("");
    setStreamError(null);

    // Reset voice early-TTS coordination state for this message
    voicePendingRemainderRef.current = null;
    voiceEarlyTTSEndedRef.current    = false;
    earlyWordCountRef.current        = 0;
    let voiceEarlyFired = false;   // fired TTS on first sentence already?
    let voiceEarlyText  = "";      // the sentence we started TTS with

    // Clear voice-call caption for the new reply
    if (continuousVoiceRef.current) {
      setVoiceCallCaptionText("");
      setVoiceCallCaptionRevealed(0);
    }

    let finalContent = "";
    let finalMessageId: string | null = null;

    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        // voice:true → server appends the brevity addendum so replies stay
        // short enough to listen to (classic voice-call mode only).
        body: JSON.stringify({ content, voice: continuousVoiceRef.current || undefined }),
        signal: streamAbort.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by double-newline
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          let eventName = "";
          let eventData = "";
          for (const line of part.split("\n")) {
            const trimmed = line.replace(/\r$/, "");
            if (trimmed.startsWith("event: ")) eventName = trimmed.slice(7);
            else if (trimmed.startsWith("data: ")) eventData = trimmed.slice(6);
          }
          if (!eventName || !eventData) continue;

          const data = JSON.parse(eventData) as Record<string, unknown>;
          if (eventName === "delta") {
            const chunk = data.text as string;
            setStreamingContent((prev) => prev + chunk);
            finalContent += chunk;

            // ── Voice early TTS ────────────────────────────────────────────
            // In voice call mode, start TTS on the first complete sentence
            // rather than waiting for the entire reply to finish streaming.
            // Sentence = ≥8 chars ending in . ! or ? followed by a space or end.
            if (continuousVoiceRef.current && !voiceEarlyFired && voiceTtsGenRef.current === ttsGen) {
              const m = finalContent.match(/^(.{8,}?[.!?])(?=\s|$)/);
              if (m?.[1]) {
                voiceEarlyText  = m[1];
                voiceEarlyFired = true;
                const earlyWC   = voiceEarlyText.trim().split(/\s+/).length;
                earlyWordCountRef.current = earlyWC;
                // Seed the caption with the early sentence so words start
                // revealing immediately; the done event will expand it to the
                // full reply so the remainder words are also available.
                setVoiceCallCaptionText(voiceEarlyText);
                setVoiceCallCaptionRevealed(0);
                voiceCallPhaseRef.current = "speaking";
                setVoiceCallPhase("speaking");
                spokenTextRef.current = voiceEarlyText; // echo-guard reference
                voice.startListening();                 // arm the mic for voice barge-in
                speakText(voiceEarlyText, {
                  voiceId: activeVoiceId,
                  onStart: () => setIsSpeaking(true),
                  onEnd: () => {
                    // Mark the early TTS as done
                    voiceEarlyTTSEndedRef.current = true;
                    // If the user barged in (or a new turn started), stay silent —
                    // the interrupt handler already owns the phase.
                    if (voiceTtsGenRef.current !== ttsGen) return;
                    const pending = voicePendingRemainderRef.current;
                    if (pending !== null) {
                      // Stream already finished — speak the remainder now
                      voicePendingRemainderRef.current = null;
                      speakVoiceRemainder(pending.text, earlyWordCountRef.current);
                    }
                    // If pending is null, stream hasn't ended yet; the done
                    // handler will pick it up via voiceEarlyTTSEndedRef.
                  },
                  onWordReveal: (count, _total) => {
                    setVoiceCallCaptionRevealed(count);
                  },
                });
              }
            }
          } else if (eventName === "done") {
            finalMessageId = String(data.messageId);
            finalContent = data.content as string;
            // In voice call mode: expand the caption text to the full reply so
            // that when the remainder TTS fires, its word positions align with
            // the full text and the overlay reveals correctly word-by-word.
            if (continuousVoiceRef.current) {
              setVoiceCallCaptionText(finalContent);
            }
          } else if (eventName === "error") {
            throw new Error(data.error as string);
          }
        }
      }
    } catch (err) {
      if (streamAbort.signal.aborted || (err as any)?.name === "AbortError") {
        // Superseded by a newer turn (barge-in) — bail out silently; the new
        // stream owns all UI state now. (Signal check covers environments
        // that surface aborts under a different error shape.)
        return;
      }
      console.error("[stream] Error:", err);
      setStreamError("Something went wrong. Please try sending again.");
      // In voice call mode: surface the error so the user can tap to retry
      if (continuousVoiceRef.current) {
        voiceCallPhaseRef.current = "error";
        setVoiceCallPhase("error");
        setVoiceCallMessage("Something went wrong — tap to try again.");
      }
    }

    setIsStreaming(false);
    setStreamingContent("");

    if (finalMessageId && finalContent) {
      queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });

      if (continuousVoiceRef.current) {
        if (voiceTtsGenRef.current !== ttsGen) {
          // The user interrupted while this reply was in flight — don't speak
          // it over them. The reply still lands in the chat history above.
        } else if (voiceEarlyFired) {
          // Early TTS already started on sentence 1.  Compute the remainder.
          const remainder = finalContent.slice(voiceEarlyText.length).trim();

          if (voiceEarlyTTSEndedRef.current) {
            // Sentence 1 TTS already finished while the stream was still running —
            // speak the remainder now with the correct word offset.
            voicePendingRemainderRef.current = null;
            speakVoiceRemainder(remainder, earlyWordCountRef.current);
          } else {
            // Sentence 1 TTS is still playing — store remainder for its onEnd to pick up.
            voicePendingRemainderRef.current = { text: remainder, id: finalMessageId };
          }
        } else {
          // No early TTS fired (very short reply or no sentence-terminal punctuation).
          // Speak the whole reply with word-synced caption, offset from word 0.
          setVoiceCallCaptionText(finalContent);
          setVoiceCallCaptionRevealed(0);
          speakVoiceRemainder(finalContent, 0);
        }
      } else {
        // Normal text mode: drive bubble caption via speakingMessageId + revealedWords.
        // Prime the caption state before the query re-fetch lands so the bubble
        // enters LiveCaption mode immediately (no flash of full text).
        setSpeakingMessageId(finalMessageId);
        setRevealedWords(0);
        handleSpeak(finalContent, finalMessageId);
      }
    } else {
      queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
    }
  };

  // ─── Send handler (onboarding + chat) ────────────────────────────────────

  const handleSend = async (data: ChatMessageFormValues) => {
    if (!data.content.trim()) return;
    const content = data.content.trim();
    setStreamError(null);
    form.reset();

    if (!onboarding?.isComplete) {
      // Onboarding uses the regular mutation — no streaming needed
      setIsTyping(true);
      submitAnswer.mutate(
        { data: { step: onboarding?.currentStep || "", answer: content } },
        {
          onSuccess: (newStatus) => {
            queryClient.setQueryData(getGetOnboardingStatusQueryKey(), newStatus);
            setIsTyping(false);
            if (newStatus.companionFirstMessage)
              handleSpeak(newStatus.companionFirstMessage);
          },
          onError: () => setIsTyping(false),
        },
      );
    } else {
      // Chat uses streaming — text appears token-by-token, no artificial wait
      await sendStreamingMessage(content);
    }
  };

  // ── Echo guard ────────────────────────────────────────────────────────────
  // While she speaks, the mic stays armed for barge-in — but on devices where
  // echo cancellation is weak it will pick up HER OWN voice. Before treating
  // recognized speech as the user's, compare it against the text she is
  // currently speaking: high word overlap ⇒ echo ⇒ ignore.

  const normalizeWords = (s: string): string[] =>
    s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);

  const isLikelyEcho = (heard: string): boolean => {
    const spoken = spokenTextRef.current;
    if (!spoken) return false;
    const heardWords = normalizeWords(heard);
    if (heardWords.length === 0) return true; // nothing meaningful captured
    const spokenSet = new Set(normalizeWords(spoken));
    const hits = heardWords.filter((w) => spokenSet.has(w)).length;
    return hits / heardWords.length >= 0.6;
  };

  // ── Interrupt (barge-in) ──────────────────────────────────────────────────
  // The single cut-her-off path, used by BOTH the on-screen stop control
  // (guaranteed) and automatic voice barge-in (best-effort). Immediately
  // silences audio, invalidates any queued TTS (early-sentence remainder,
  // in-flight reply), and hands the turn to the user.
  const interruptSpeech = (opts?: { resumeListening?: boolean }) => {
    const resume = opts?.resumeListening ?? true;
    voiceTtsGenRef.current++;                 // stale-ify every pending TTS callback
    voicePendingRemainderRef.current = null;  // never speak the queued remainder
    stopSpeaking();                           // kill ElevenLabs audio + browser TTS + caption timers
    setIsSpeaking(false);
    setVoiceCallCaptionRevealed(99999);       // reveal the full caption so the reply stays readable
    setVoiceCallMessage(null);
    if (resume) {
      voiceCallPhaseRef.current = "listening";
      setVoiceCallPhase("listening");
      setVoiceCallRecognizedText("");
      voice.startListening();                 // no-op if the barge-in mic is already running
    }
  };

  // Talk mode: auto-send. Mic mode: fill input for user review.
  const handleVoiceResult = (text: string) => {
    if (continuousVoiceRef.current) {
      const phase = voiceCallPhaseRef.current;

      if (phase === "speaking") {
        // Mic was armed for barge-in while she talks — filter out her own voice.
        if (isLikelyEcho(text)) {
          console.log("[voice-call] ignored echo:", JSON.stringify(text));
          return;
        }
        // Genuine barge-in: cut her off and treat this as the user's turn.
        console.log("[voice-call] barge-in (final):", JSON.stringify(text));
        interruptSpeech({ resumeListening: false });
      } else if (phase === "thinking") {
        // Already processing a turn — a late final result would double-send.
        console.log("[voice-call] ignored transcript during thinking:", JSON.stringify(text));
        return;
      }

      // Stop recognition BEFORE updating state. reco.onend fires synchronously
      // after onresult; if we haven't updated the ref yet, handleRecognitionEnd
      // would see "listening" and restart the mic while we're already thinking.
      voice.stopListening();
      // Update the ref synchronously — React's useEffect runs AFTER the render,
      // so any callback that reads voiceCallPhaseRef between now and the next
      // paint sees the correct value immediately.
      voiceCallPhaseRef.current = "thinking";
      setVoiceCallPhase("thinking");
      setVoiceCallRecognizedText(text);   // show what was heard on screen
      setVoiceCallMessage(null);
      console.log("[voice-call] transcript →", JSON.stringify(text));
      handleSend({ content: text });
    } else {
      form.setValue("content", text);
    }
  };

  // Live interim results. Voice call mode: detect barge-in while she speaks.
  // Mic mode: fill the input as the user is still speaking.
  const handleVoiceInterim = (text: string) => {
    if (continuousVoiceRef.current) {
      // Voice barge-in (best-effort): the user starts talking over her.
      // Require ≥2 recognized words that don't look like her own echo, then
      // stop her audio and keep this same recognition session running — the
      // final transcript of the user's sentence arrives in "listening" phase
      // and is sent normally, so their first words are not lost.
      if (
        voiceCallPhaseRef.current === "speaking" &&
        text.trim().split(/\s+/).length >= 2 &&
        !isLikelyEcho(text)
      ) {
        console.log("[voice-call] barge-in (interim):", JSON.stringify(text));
        interruptSpeech({ resumeListening: true });
      }
      return;
    }
    form.setValue("content", text);
  };

  // ── Voice call: recognition ended (fires after EVERY session — result, no-speech, stop, error) ──
  // Restart while in "listening" (user's turn) AND while "speaking" (mic armed
  // for barge-in). Other phases (thinking/error) manage their own transitions.
  const handleRecognitionEnd = useCallback(() => {
    if (!continuousVoiceRef.current) return;
    const phase = voiceCallPhaseRef.current;
    if (phase !== "listening" && phase !== "speaking") return;
    // Brief pause before restart to avoid hammering the browser
    setTimeout(() => {
      if (!continuousVoiceRef.current) return;
      const p = voiceCallPhaseRef.current;
      if (p === "listening" || p === "speaking") {
        voice.startListening();
      }
    }, 350);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Voice call: recognition error ──
  const handleRecognitionError = useCallback((errorType: string) => {
    if (!continuousVoiceRef.current) return;
    console.log("[voice-call] recognition error:", errorType);

    // While she is speaking, the mic is armed purely for barge-in. Expected
    // noise (no-speech while her audio plays, aborted from our own stops,
    // transient network blips) must NOT tear down the speaking state — the
    // onEnd handler re-arms the mic. Only a blocked mic is worth surfacing.
    if (voiceCallPhaseRef.current === "speaking") {
      if (errorType === "not-allowed" || errorType === "service-not-allowed") {
        setVoiceCallMessage(
          "Mic blocked — voice interrupt is unavailable. Use the stop button below.",
        );
      }
      return;
    }

    if (errorType === "not-allowed" || errorType === "service-not-allowed") {
      // Hard failure — mic blocked. Common inside Replit's embedded iframe preview.
      voiceCallPhaseRef.current = "error";
      setVoiceCallPhase("error");
      setVoiceCallMessage(
        "I can't access the microphone — please allow mic access and open " +
        "the app in its own browser tab (the mic is blocked inside the embedded preview).",
      );
    } else if (errorType === "no-speech") {
      // Nothing heard — stop the auto-loop. User must tap "Tap to speak" to retry.
      // Auto-restarting here causes an infinite "Listening…" loop with no transcript.
      voiceCallPhaseRef.current = "error";
      setVoiceCallPhase("error");
      setVoiceCallMessage("I didn't catch that — tap to try again.");
    } else if (errorType === "network") {
      voiceCallPhaseRef.current = "error";
      setVoiceCallPhase("error");
      setVoiceCallMessage("Network error with voice recognition — tap to retry.");
    } else if (errorType === "aborted") {
      // Fired when we call stop() ourselves — completely expected, ignore it.
    } else {
      voiceCallPhaseRef.current = "error";
      setVoiceCallPhase("error");
      setVoiceCallMessage(`Voice recognition issue (${errorType}) — tap to try again.`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const voice = useSpeechRecognition(handleVoiceResult, {
    onInterimResult: handleVoiceInterim,
    onEnd: handleRecognitionEnd,
    onRecognitionError: handleRecognitionError,
  });

  // Safety net: if the Chat page unmounts mid-call (navigation), kill audio,
  // recognition, and the mic keepalive stream so nothing runs in the background.
  useEffect(() => {
    return () => {
      if (continuousVoiceRef.current) {
        continuousVoiceRef.current = false;
        voiceTtsGenRef.current++;
        realtimeGenRef.current++;
        realtimeConvoRef.current?.endSession().catch(() => {});
        realtimeConvoRef.current = null;
        voiceEngineRef.current = null;
        stopSpeaking();
        voice.stopListening();
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Voice call: speak a chunk with word-synced caption in the overlay ────
  // wordOffset: how many words from the FULL reply were already spoken before
  // this chunk (0 for the first/only chunk; earlyWordCount for the remainder).
  const speakVoiceRemainder = (text: string, wordOffset: number) => {
    // Capture the generation at invocation. Call sites verify it just before
    // calling, and any interrupt after this point bumps it — so stale
    // onStart/onEnd callbacks (e.g. a cancelled browser-TTS utterance that
    // still fires its onend) must not flip the phase or re-arm the mic.
    const gen = voiceTtsGenRef.current;
    if (!text.trim() || text.length <= 2) {
      setIsSpeaking(false);
      setVoiceCallMessage(null);
      if (continuousVoiceRef.current) {
        voiceCallPhaseRef.current = "listening";
        setVoiceCallPhase("listening");
        setVoiceCallRecognizedText("");
        voice.startListening();
      }
      return;
    }
    console.log("[voice-call] speaking reply:", JSON.stringify(text.slice(0, 60)));
    spokenTextRef.current = text; // echo-guard reference for barge-in
    speakText(text, {
      voiceId: activeVoiceId,
      onStart: () => {
        if (voiceTtsGenRef.current !== gen) return; // interrupted before audio began
        setIsSpeaking(true);
        voiceCallPhaseRef.current = "speaking";
        setVoiceCallPhase("speaking");
        voice.startListening(); // arm the mic for voice barge-in
      },
      onEnd: () => {
        if (voiceTtsGenRef.current !== gen) return; // stale — the interrupt/new turn owns state now
        setIsSpeaking(false);
        setVoiceCallMessage(null);
        if (continuousVoiceRef.current) {
          voiceCallPhaseRef.current = "listening";
          setVoiceCallPhase("listening");
          setVoiceCallRecognizedText("");
          voice.startListening();
        }
      },
      onWordReveal: (count, _total) => {
        if (voiceTtsGenRef.current !== gen) return;
        setVoiceCallCaptionRevealed(wordOffset + count);
      },
    });
  };

  // Server-declared hard configuration errors for realtime voice → what the
  // person on the call screen should read. Keys mirror voice-agent.ts reasons.
  const REALTIME_CONFIG_ERRORS: Record<string, string> = {
    api_key_permission:
      "The ElevenLabs API key is missing the “Conversational AI” permission, so calls can't start. " +
      "In ElevenLabs → Developers → API Keys, enable Conversational AI on the key (or create a new " +
      "key with it enabled), then update ELEVENLABS_API_KEY here.",
    api_key_invalid:
      "ElevenLabs rejected the configured API key — it may be wrong or revoked. Update ELEVENLABS_API_KEY and try again.",
    agent_not_found:
      "ElevenLabs couldn't find the configured agent — double-check ELEVENLABS_AGENT_ID.",
    signed_url_failed: "ElevenLabs couldn't authorize the call.",
    elevenlabs_unreachable:
      "Couldn't reach ElevenLabs to start the call — check the connection and try again.",
  };

  // Ship browser-side voice-call failures to the server log so a remote
  // tester's "it just dropped" is diagnosable (WebSocket close reasons happen
  // browser↔ElevenLabs and never transit our server otherwise).
  const reportVoiceCallError = (stage: string, message: string, detail?: string) => {
    fetch(`${import.meta.env.BASE_URL}api/voice-agent/client-error`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, message, detail }),
    }).catch(() => {});
  };

  const toggleContinuousVoice = async () => {
    if (continuousVoice) {
      // ── End the call ──
      setContinuousVoice(false);
      continuousVoiceRef.current = false; // sync now — a late TTS onEnd must not re-arm the mic
      voiceTtsGenRef.current++;           // silence any reply TTS still in flight
      voicePendingRemainderRef.current = null;
      realtimeGenRef.current++;           // stale-ify this session's realtime callbacks
      // Realtime engine: close the ElevenLabs session and pull the persisted
      // voice turns into the chat history view.
      const convo = realtimeConvoRef.current;
      realtimeConvoRef.current = null;
      if (convo) {
        convo.endSession().catch((err) => console.warn("[voice-call] endSession failed:", err));
        queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
      }
      voiceEngineRef.current = null;
      setVoiceEngine(null);
      setRealtimeNote(null);
      voice.stopListening();
      stopSpeaking();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      voiceCallPhaseRef.current = "listening";
      setVoiceCallPhase("listening");
      setVoiceCallRecognizedText("");
      setVoiceCallMessage(null);
    } else {
      // Feature-flag hard guard: never START a call while Voice Call is
      // disabled. The button is hidden when the flag is off, but this also
      // protects against any programmatic invocation. (Ending a call — the
      // branch above — must always stay possible.)
      if (!voiceCallEnabled) return;
      setVoiceError(null);
      voice.clearError();
      unlockAudioOnGesture(); // unlock Audio.play() + speechSynthesis in this gesture context
      setContinuousVoice(true);
      continuousVoiceRef.current = true; // sync now — recognition callbacks may fire before the re-render
      voiceEngineRef.current = null;
      setVoiceEngine(null);
      setRealtimeNote(null);
      voiceCallPhaseRef.current = "listening";
      setVoiceCallPhase("listening");
      setVoiceCallRecognizedText("");
      setVoiceCallCaptionText("");
      setVoiceCallCaptionRevealed(0);
      setVoiceCallMessage("Connecting…");
      // Identity for THIS call attempt — every realtime callback below
      // captures it and no-ops if a newer call (or an end) has bumped it.
      const rtGen = ++realtimeGenRef.current;

      // Quota exhaustion → no raw error, no classic fallback (classic TTS
      // draws on the same ElevenLabs quota). Roll the call UI back and leave
      // a warm in-character note in the chat instead.
      const restVoiceAndReturnToText = () => {
        setContinuousVoice(false);
        continuousVoiceRef.current = false;
        realtimeGenRef.current++;
        voiceEngineRef.current = null;
        setVoiceEngine(null);
        voiceCallPhaseRef.current = "listening";
        setVoiceCallPhase("listening");
        setVoiceCallRecognizedText("");
        setVoiceCallMessage(null);
        setVoiceError(VOICE_REST_MESSAGE);
      };

      // ── 0) Microphone permission BEFORE any connection attempt ──────────
      // Never open a session we can't feed audio into: ask for the mic first
      // and only connect once it's granted. The probe tracks are stopped
      // immediately — the SDK (or classic mode below) opens its own stream,
      // and the browser keeps the permission grant cached.
      setVoiceCallMessage("Waiting for microphone…");
      try {
        const probe = await navigator.mediaDevices?.getUserMedia?.({ audio: true });
        probe?.getTracks().forEach((t) => t.stop());
        if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) return;
      } catch (err: any) {
        if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) return;
        const name = err?.name ?? "";
        voiceCallPhaseRef.current = "error";
        setVoiceCallPhase("error");
        if (name === "NotAllowedError" || name === "SecurityError") {
          setVoiceCallMessage(
            "I can't access the microphone — please allow mic access and open " +
            "the app in its own browser tab (the mic is blocked inside the embedded preview).",
          );
        } else if (name === "NotFoundError") {
          setVoiceCallMessage("No microphone found — connect one, then end the call and try again.");
        } else {
          setVoiceCallMessage(
            `The microphone couldn't start (${name || "unknown error"}) — end the call and try again.`,
          );
        }
        reportVoiceCallError("microphone", name || String(err));
        return;
      }
      setVoiceCallMessage("Connecting…");

      // ── 1) Realtime voice: ElevenLabs Conversational AI ─────────────────
      // The agent handles mic streaming, transcription, turn-taking, and
      // interruption natively; our custom-LLM endpoint keeps Claude + this
      // user's memory as the brain. Bootstrap failures (our own API) fall back
      // to classic mode; ElevenLabs connection failures show a specific
      // on-screen error. connectStage tracks which kind a thrown error is.
      let connectStage: "bootstrap" | "handshake" = "bootstrap";
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}api/voice-agent/session`, {
          method: "POST",
          credentials: "include",
        });
        const session: RealtimeSessionInfo | null = res.ok ? await res.json() : null;
        if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) return; // ended/superseded while connecting

        if (session?.available) {
          connectStage = "handshake";
          const convo = await startRealtimeCall(session, activeVoiceId, {
            onMode: (mode) => {
              if (realtimeGenRef.current !== rtGen || !continuousVoiceRef.current) return;
              voiceCallPhaseRef.current = mode;
              setVoiceCallPhase(mode);
              if (mode === "listening") setVoiceCallRecognizedText("");
            },
            onUserText: (text) => {
              if (realtimeGenRef.current !== rtGen || !continuousVoiceRef.current) return;
              setVoiceCallRecognizedText(text);
            },
            onAgentText: (text) => {
              if (realtimeGenRef.current !== rtGen || !continuousVoiceRef.current) return;
              setVoiceCallCaptionText(text);
              setVoiceCallCaptionRevealed(999999); // audio is realtime — show the full line
            },
            onDisconnect: (info) => {
              // Unexpected drop mid-call (network, agent hangup, auth): close
              // the call UI cleanly and SHOW THE ACTUAL CAUSE — never a silent
              // drop. The engine check keeps a handshake-phase drop on the
              // error path below, and the gen check silences stale sessions.
              if (
                realtimeGenRef.current !== rtGen ||
                !continuousVoiceRef.current ||
                voiceEngineRef.current !== "realtime"
              ) return;
              realtimeGenRef.current++; // this session is over — mute any stragglers
              realtimeConvoRef.current = null;
              voiceEngineRef.current = null;
              setVoiceEngine(null);
              setContinuousVoice(false);
              continuousVoiceRef.current = false;
              voiceCallPhaseRef.current = "listening";
              setVoiceCallPhase("listening");
              setVoiceCallRecognizedText("");
              setVoiceCallMessage(null);
              if (info.message && isQuotaFailure(info.message)) {
                // Quota ran out mid-call: warm in-character note, no raw error.
                reportVoiceCallError("quota", info.message);
                setVoiceError(VOICE_REST_MESSAGE);
              } else if (info.message) {
                setVoiceError(`Voice call disconnected: ${info.message}`);
                reportVoiceCallError("disconnect", info.message);
              } else {
                setVoiceError("Voice call disconnected — tap Voice call to reconnect.");
              }
              queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
            },
            onError: (message, context) => {
              if (realtimeGenRef.current !== rtGen) return;
              console.error("[voice-call] realtime error:", message, context);
              reportVoiceCallError("realtime-error", message);
            },
          });
          if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) {
            // Call ended — or a newer call started — while the WebSocket
            // handshake was in flight. This session must not own anything.
            convo.endSession().catch(() => {});
            return;
          }
          realtimeConvoRef.current = convo;
          voiceEngineRef.current = "realtime";
          setVoiceEngine("realtime");
          setVoiceCallMessage(null);
          console.log("[voice-call] realtime engine connected");
          return; // the agent owns mic + audio from here — no local recognition
        }

        if (session && !session.available && session.reason === "disabled") {
          // Voice Call is feature-flagged off server-side — abort the call
          // entirely (NO classic fallback) and roll back all call-start state.
          setContinuousVoice(false);
          continuousVoiceRef.current = false;
          voiceEngineRef.current = null;
          setVoiceEngine(null);
          voiceCallPhaseRef.current = "listening";
          setVoiceCallPhase("listening");
          setVoiceCallMessage(null);
          return;
        }

        if (
          session &&
          !session.available &&
          (session.reason === "quota_exceeded" || isQuotaFailure(session.detail))
        ) {
          reportVoiceCallError("quota", session.detail ?? "quota_exceeded");
          restVoiceAndReturnToText();
          return;
        }

        // Hard configuration errors: show EXACTLY what to fix on the call
        // screen. No silent fallback that hides the problem — the server has
        // already logged the underlying ElevenLabs response.
        if (session && !session.available && session.reason && REALTIME_CONFIG_ERRORS[session.reason]) {
          voiceCallPhaseRef.current = "error";
          setVoiceCallPhase("error");
          setVoiceCallMessage(
            REALTIME_CONFIG_ERRORS[session.reason] +
              (session.detail ? ` (ElevenLabs says: ${session.detail})` : ""),
          );
          return;
        }

        if (session && !session.available) {
          setRealtimeNote(
            session.reason === "not_configured"
              ? "Realtime voice isn't set up yet — using standard voice mode."
              : "Realtime voice unavailable — using standard voice mode.",
          );
        } else if (!session) {
          setRealtimeNote("Realtime voice unavailable — using standard voice mode.");
        }
      } catch (err) {
        console.error("[voice-call] realtime connect failed:", err);
        if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) return;
        if (connectStage === "bootstrap") {
          // OUR api couldn't bootstrap the session — not an ElevenLabs
          // problem. Classic mode can still serve the call, with a visible
          // note (same treatment as a missing/failed session response).
          setRealtimeNote("Realtime voice couldn't connect — using standard voice mode.");
        } else {
          // True ElevenLabs handshake/SDK failure: show the SPECIFIC cause on
          // the call screen — a silent instant drop is never OK. Exception:
          // quota exhaustion gets the warm in-character note instead.
          const msg = err instanceof Error ? err.message : String(err);
          if (isQuotaFailure(msg)) {
            reportVoiceCallError("quota", msg);
            restVoiceAndReturnToText();
            return;
          }
          voiceCallPhaseRef.current = "error";
          setVoiceCallPhase("error");
          setVoiceCallMessage(`Voice call couldn't connect: ${msg} — end the call and try again.`);
          reportVoiceCallError("connect", msg);
          return;
        }
      }
      if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) return; // ended/superseded during connect

      // ── 2) Classic fallback: browser SpeechRecognition + sentence TTS ───
      voiceEngineRef.current = "classic";
      setVoiceEngine("classic");
      setVoiceCallMessage(null);
      if (!voice.isSupported) {
        setContinuousVoice(false);
        continuousVoiceRef.current = false;
        voiceEngineRef.current = null;
        setVoiceEngine(null);
        setVoiceError(
          "Voice input isn't available in this browser — try Chrome or Safari, or type instead.",
        );
        return;
      }

      // Best-effort echo cancellation + early, VISIBLE mic-permission check:
      // hold an echo-cancelled capture stream for the whole call so the
      // browser's AEC pipeline is active while she speaks (barge-in mic), and
      // surface mic problems immediately instead of talking into the void.
      try {
        const stream = await navigator.mediaDevices?.getUserMedia?.({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (!continuousVoiceRef.current) {
          // Call was ended while the permission prompt was open — don't
          // resurrect the mic. Release the freshly granted stream.
          stream?.getTracks().forEach((t) => t.stop());
          return;
        }
        if (stream) micStreamRef.current = stream;
      } catch (err: any) {
        if (!continuousVoiceRef.current) return; // call ended during the prompt
        const name = err?.name ?? "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          voiceCallPhaseRef.current = "error";
          setVoiceCallPhase("error");
          setVoiceCallMessage(
            "I can't access the microphone — please allow mic access and open " +
            "the app in its own browser tab (the mic is blocked inside the embedded preview).",
          );
          return;
        }
        if (name === "NotFoundError") {
          voiceCallPhaseRef.current = "error";
          setVoiceCallPhase("error");
          setVoiceCallMessage("No microphone found — please connect one and tap to try again.");
          return;
        }
        // Anything else: proceed — SpeechRecognition has its own permission path
        // and will report through handleRecognitionError if it fails too.
      }

      if (!continuousVoiceRef.current) return; // ended during startup — stay off
      voice.startListening();
    }
  };

  // Safety net: if the Voice Call feature flag flips off while a call is live
  // (e.g. the voices-status query refetches after the server-side flag was
  // turned off), fully end the call — otherwise the overlay would vanish while
  // the mic / audio loop stayed hot with no visible way to stop it.
  useEffect(() => {
    if (!voiceCallEnabled && continuousVoice) {
      toggleContinuousVoice(); // continuousVoice === true → runs the end-call teardown
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceCallEnabled, continuousVoice]);

  // ─── Settings: companion rename ───────────────────────────────────────────

  const handleRename = () => {
    const cleaned = renameValue.trim();
    if (!cleaned || cleaned === profile?.companionName) {
      setShowSettings(false);
      return;
    }
    updateProfile.mutate(
      { data: { companionName: cleaned } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
          setShowSettings(false);
        },
      },
    );
  };

  // ─── Settings: delete account ─────────────────────────────────────────────

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Preview state — null means not yet fetched, object means summary loaded
  interface ExportSummary {
    messageCount: number;
    habitCount: number;
    moodCount: number;
    memoryCount: number;
    winCount: number;
    goalCount: number;
    commitmentCount: number;
    reminderCount: number;
    personalitySignalCount: number;
    habitCompletionCount: number;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
  }
  const [exportSummary, setExportSummary] = useState<ExportSummary | null>(null);
  const [isFetchingSummary, setIsFetchingSummary] = useState(false);

  // Optional date-range filter for exports. Empty string = unbounded on that end.
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const rangeError = !!exportFrom && !!exportTo && exportFrom > exportTo;

  const handlePreviewExport = async () => {
    setIsFetchingSummary(true);
    setExportError(null);
    try {
      const res = await apiFetch(`${import.meta.env.BASE_URL}api/account/export/summary`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setExportError((body as any)?.error ?? "Could not load summary. Please try again.");
        return;
      }
      const data = await res.json();
      setExportSummary(data);
    } catch {
      setExportError("Could not load summary. Please try again.");
    } finally {
      setIsFetchingSummary(false);
    }
  };

  // Auto-load the data summary whenever the settings panel opens, so the
  // "Your data" block is populated without any user action. Keeps the existing
  // summary visible while it refreshes, so there's no flash of a spinner.
  useEffect(() => {
    if (showSettings) {
      handlePreviewExport();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings]);

  const [isExportingHtml, setIsExportingHtml] = useState(false);

  // In-app report viewer — reads the same HTML report inside a full-screen
  // overlay so users can read their history without downloading anything.
  const [showReport, setShowReport] = useState(false);
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const [isLoadingReport, setIsLoadingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const handleViewReport = async () => {
    setShowReport(true);
    setIsLoadingReport(true);
    setReportError(null);
    setReportHtml(null);
    try {
      const params = new URLSearchParams();
      if (exportFrom) params.set("from", exportFrom);
      if (exportTo) params.set("to", exportTo);
      const qs = params.toString();
      const res = await apiFetch(`${import.meta.env.BASE_URL}api/account/report${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        setReportError("Could not load your report. Please try again.");
        return;
      }
      setReportHtml(await res.text());
    } catch {
      setReportError("Could not load your report. Please try again.");
    } finally {
      setIsLoadingReport(false);
    }
  };

  const handleExport = async (format: "json" | "html" = "json") => {
    if (exportFrom && exportTo && exportFrom > exportTo) {
      setExportError("The 'from' date must be on or before the 'to' date.");
      return;
    }
    const isHtml = format === "html";
    if (isHtml) setIsExportingHtml(true);
    else setIsExporting(true);
    setExportError(null);
    try {
      const params = new URLSearchParams();
      if (isHtml) params.set("format", "html");
      if (exportFrom) params.set("from", exportFrom);
      if (exportTo) params.set("to", exportTo);
      const qs = params.toString();
      const url = `${import.meta.env.BASE_URL}api/account/export${qs ? `?${qs}` : ""}`;
      const res = await apiFetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setExportError((body as any)?.error ?? "Export failed. Please try again.");
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      const dateSlug = new Date().toISOString().slice(0, 10);
      a.download = isHtml ? `eos-report-${dateSlug}.html` : `eos-export-${dateSlug}.json`;
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      setExportError("Export failed. Please try again.");
    } finally {
      if (isHtml) setIsExportingHtml(false);
      else setIsExporting(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== "DELETE") return;
    setIsDeletingAccount(true);
    setDeleteError(null);
    try {
      const res = await apiFetch(`${import.meta.env.BASE_URL}api/auth/account`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDeleteError((body as any)?.error ?? "Something went wrong. Please try again.");
        return;
      }
      // Deletion confirmed — clear auth state so AuthGate redirects to login
      queryClient.setQueryData(["/api/auth/me"], null);
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    } catch {
      setDeleteError("Something went wrong. Please try again.");
    } finally {
      setIsDeletingAccount(false);
    }
  };

  // ─── Settings: voice selection ────────────────────────────────────────────

  const handleVoiceSelect = (voiceId: string) => {
    updateProfile.mutate(
      { data: { voiceId } as any },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
        },
      },
    );
  };

  const handleToneSelect = (voiceTone: string) => {
    updateProfile.mutate(
      { data: { voiceTone } as any },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
        },
      },
    );
  };

  const handleVoicePreview = (voiceId: string) => {
    // Clicking the same voice again → stop it
    if (previewingVoiceId === voiceId) {
      stopSpeaking();
      setPreviewingVoiceId(null);
      return;
    }
    // Clicking a different voice → stop previous immediately, then start new
    stopSpeaking();
    setPreviewingVoiceId(voiceId);
    speakText(PREVIEW_SAMPLE, {
      voiceId, // exact ID for THIS card — never the active companion voice
      onEnd: () => setPreviewingVoiceId(null),
    });
  };

  const companionName = profile?.companionName || "Asha";
  const companionInitials = companionName.substring(0, 2).toUpperCase();

  // Which steps show choice buttons instead of text input
  const currentStep = onboarding?.currentStep ?? "";
  const stepChoices = STEP_CHOICES[currentStep] ?? null;
  const showChoiceButtons = !onboarding?.isComplete && !!stepChoices;
  const showTextInput = onboarding?.isComplete || (!stepChoices && !onboarding?.isComplete);

  // ─── Chat content ─────────────────────────────────────────────────────────

  const chatContent = () => {
    if (!onboarding?.isComplete) {
      return (
        <div className="flex flex-col gap-4">
          <motion.div
            key={currentStep}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="flex items-end gap-2 max-w-[85%]"
          >
            <div className="companion-bubble px-5 py-3.5 rounded-2xl rounded-bl-sm">
              <p className={cn(
                "companion-message leading-relaxed text-foreground/90",
                isBereavement ? "text-[17px]" : "text-[16px]",
              )}>
                {onboarding?.companionFirstMessage || "Hello. What brought you here today?"}
              </p>
            </div>
          </motion.div>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-6 w-full">
        <AnimatePresence initial={false}>
          {messages.map((msg, idx) => {
            const isCompanion = msg.role === "assistant";
            const showLabel =
              isCompanion && (idx === 0 || messages[idx - 1]?.role !== "assistant");

            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
                className={cn(
                  "flex flex-col w-full max-w-[85%]",
                  isCompanion ? "self-start" : "self-end items-end",
                )}
              >
                {showLabel && (
                  <span className="text-[10px] text-muted-foreground/60 tracking-widests uppercase mb-1.5 ml-1">
                    {companionName}
                  </span>
                )}
                <div
                  className={cn(
                    "px-[18px] py-3 leading-relaxed relative",
                    isCompanion
                      ? "companion-bubble rounded-2xl rounded-tl-sm"
                      : "user-bubble rounded-2xl rounded-tr-sm",
                  )}
                >
                  {isCompanion && speakingMessageId === String(msg.id) ? (
                    /* ── Live caption mode: reveal words in sync with audio ── */
                    <p className={cn(
                      "companion-message text-foreground/90",
                      isBereavement ? "text-[17px]" : "text-[16px]",
                    )}>
                      <LiveCaption
                        text={msg.content}
                        revealedWords={revealedWords}
                      />
                    </p>
                  ) : (
                    <p className={cn(
                      isCompanion
                        ? cn("companion-message text-foreground/90", isBereavement ? "text-[17px]" : "text-[16px]")
                        : "font-sans text-[14.5px] text-secondary/85",
                    )}>
                      {msg.content}
                    </p>
                  )}
                  {msg.isMorningNote && (
                    <span className="absolute -top-3 left-4 text-[9px] text-primary/70 tracking-[0.2em] uppercase bg-background px-2 font-medium">
                      Morning Note
                    </span>
                  )}
                </div>

                {/* ── Per-message speaker button ── */}
                {isCompanion && (
                  <button
                    onClick={() => handleSpeak(msg.content, String(msg.id))}
                    title={speakingMessageId === String(msg.id) ? "Playing…" : "Hear this message"}
                    className={cn(
                      "mt-1 ml-1 flex items-center gap-1 px-2.5 py-1 rounded-full text-[10.5px] font-medium transition-all",
                      speakingMessageId === String(msg.id)
                        ? "bg-primary/20 text-primary border border-primary/35"
                        : "text-muted-foreground/45 hover:text-primary/80 hover:bg-primary/10 border border-transparent hover:border-primary/20",
                    )}
                  >
                    <Volume2 className="w-3 h-3 shrink-0" />
                    {speakingMessageId === String(msg.id) ? "Playing…" : "Listen"}
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* ── Stream error bubble ───────────────────────────────────────────── */}
        <AnimatePresence>
          {streamError && !isStreaming && (
            <motion.div
              key="stream-error"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="self-start max-w-[85%]"
            >
              <div className="px-[18px] py-3 rounded-2xl rounded-tl-sm bg-red-500/8 border border-red-500/20 text-[13.5px] text-red-400/80 font-sans leading-relaxed">
                {streamError}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Streaming bubble — appears while model is generating ─────────── */}
        <AnimatePresence>
          {isStreaming && (
            <motion.div
              key="streaming-bubble"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="flex flex-col w-full max-w-[85%] self-start"
            >
              <span className="text-[10px] text-muted-foreground/60 tracking-widests uppercase mb-1.5 ml-1">
                {companionName}
              </span>
              <div className="px-[18px] py-3 leading-relaxed companion-bubble rounded-2xl rounded-tl-sm">
                <p className={cn(
                  "companion-message text-foreground/90",
                  isBereavement ? "text-[17px]" : "text-[16px]",
                )}>
                  {/* In voice call mode: never show streaming text — the caption
                      overlay in the call panel is the only live text surface. */}
                  {(!continuousVoice && streamingContent) || (
                    /* Pulsing dot while waiting for first token (or always in voice mode) */
                    <motion.span
                      animate={{ opacity: [0.2, 0.65, 0.2] }}
                      transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                      className="inline-block w-1.5 h-1.5 rounded-full bg-primary/50 align-middle"
                    />
                  )}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={cn(
      "flex flex-col h-full w-full relative bg-background",
      isBereavement && "gentle-mode",
    )}>
      {/* ── Full report overlay — read the report in-app, no download ──────── */}
      <AnimatePresence>
        {showReport && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed inset-0 z-50 flex flex-col bg-background"
          >
            <header className="h-14 flex items-center justify-between px-5 border-b border-primary/20 bg-background/98 backdrop-blur-xl shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-primary/70 shrink-0" />
                <span className="text-[11px] text-muted-foreground/80 tracking-widest uppercase font-medium truncate">
                  Your full report
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleExport("html")}
                  disabled={isExportingHtml}
                  className="text-[11px] text-muted-foreground/60 hover:text-primary tracking-wider uppercase gap-1.5"
                  title="Download this report"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowReport(false)}
                  className="rounded-full w-9 h-9 text-muted-foreground/60 hover:text-foreground"
                  title="Close report"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </header>

            <div className="flex-1 min-h-0 relative">
              {isLoadingReport ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground/50">
                  <motion.div
                    className="w-5 h-5 border-2 border-primary/40 border-t-transparent rounded-full"
                    animate={{ rotate: 360 }}
                    transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                  />
                  <span className="text-[12px] tracking-wide">Loading your report…</span>
                </div>
              ) : reportError ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-[13px] text-destructive/80">{reportError}</p>
                  <button
                    onClick={handleViewReport}
                    className="text-[11px] text-primary/80 hover:text-primary tracking-wider uppercase transition-colors"
                  >
                    Retry
                  </button>
                </div>
              ) : reportHtml ? (
                <iframe
                  title="Your full report"
                  srcDoc={reportHtml}
                  className="w-full h-full border-0 bg-white"
                  sandbox=""
                />
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="h-16 flex items-center justify-between px-5 border-b border-[rgba(200,180,150,0.09)] bg-muted/95 backdrop-blur-xl z-20 shrink-0 relative">
        {/* Companion presence — left */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative shrink-0">
            <div className={cn(
              "w-8 h-8 rounded-full bg-card border flex items-center justify-center transition-all",
              isSpeaking ? "border-primary/60 shadow-[0_0_8px_hsl(35_49%_57%/0.35)]" : "border-primary/25",
            )}>
              <span className="font-serif text-[11px] text-secondary/80 tracking-wider">
                {companionInitials}
              </span>
            </div>
            {/* Online dot */}
            <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-primary/70 rounded-full border border-background" />
          </div>

          <div className="flex items-center gap-1 min-w-0">
            <span className="text-[10px] text-muted-foreground/80 tracking-widest uppercase font-medium truncate">
              {companionName}
            </span>
            {/* Speaking bars */}
            <AnimatePresence>
              {isSpeaking && (
                <motion.div
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={{ opacity: 0, width: 0 }}
                >
                  <SpeakingBars />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Eos wordmark — centered */}
        <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center select-none pointer-events-none gap-0">
          <span className="font-serif text-[13px] font-medium tracking-[0.46em] text-foreground/80">E O S</span>
          <div className="h-px w-6 bg-primary/50 my-[3px]" />
          <p className="font-serif italic text-[9px] tracking-[0.16em] text-muted-foreground/70">a new dawn</p>
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-1">
          {/* Settings — always visible once app loads */}
          <button
            onClick={() => setShowSettings((s) => !s)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium tracking-wider uppercase transition-all duration-200",
              showSettings
                ? "bg-primary/15 text-primary border border-primary/30"
                : "text-foreground/45 border border-[rgba(200,180,150,0.14)] hover:text-foreground/70 hover:border-[rgba(200,180,150,0.24)]",
            )}
          >
            {showSettings
              ? <><X className="w-3.5 h-3.5" /> Close</>
              : <><Settings className="w-3.5 h-3.5" /> Settings</>
            }
          </button>
        </div>
      </header>

      {/* ── Settings panel ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-muted/95 border-b border-[rgba(200,180,150,0.09)] px-5 py-5 backdrop-blur-xl z-10 shrink-0 space-y-6 overflow-hidden"
          >
            {/* ── Companion name ─────────────────────────────────────────── */}
            <div>
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">
                Companion name
              </p>
              <div className="flex gap-2">
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="Enter a name..."
                  className="bg-background/60 border-primary/20 text-sm text-foreground/85 placeholder:text-muted-foreground/40 h-9 flex-1"
                  onKeyDown={(e) => e.key === "Enter" && handleRename()}
                  maxLength={30}
                />
                <Button
                  size="sm"
                  className="h-9 bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25 px-4"
                  onClick={handleRename}
                  disabled={updateProfile.isPending}
                >
                  <Check className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* ── Account email ───────────────────────────────────────────── */}
            <div>
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">
                Account email
              </p>
              {!showChangeEmail ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] text-foreground/70 break-all">
                    {accountEmail || "—"}
                  </span>
                  <button
                    onClick={() => setShowChangeEmail(true)}
                    className="shrink-0 text-[11px] text-primary/80 hover:text-primary tracking-wider uppercase transition-colors"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <ChangeEmailForm currentEmail={accountEmail} compact />
                  <button
                    onClick={() => setShowChangeEmail(false)}
                    className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground/80 tracking-wider uppercase transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* ── Voice picker ────────────────────────────────────────────── */}
            <div>
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">
                Companion voice
              </p>

              {/* ── Filter chips ── */}
              <div className="space-y-2 mb-3">
                {/* Gender */}
                <div className="flex gap-1.5 flex-wrap">
                  {(["all", "female", "male"] as const).map((g) => (
                    <button
                      key={g}
                      onClick={() => setVoiceGenderFilter(g)}
                      className={cn(
                        "px-3 py-1 rounded-full text-[10.5px] font-medium tracking-wide transition-all border",
                        voiceGenderFilter === g
                          ? "bg-primary/20 border-primary/50 text-primary"
                          : "border-primary/15 text-muted-foreground/55 hover:border-primary/30 hover:text-foreground/70",
                      )}
                    >
                      {g === "all" ? "All genders" : g === "female" ? "Female" : "Male"}
                    </button>
                  ))}
                </div>
                {/* Accent */}
                <div className="flex gap-1.5 flex-wrap">
                  {(["all", "American", "British", "Australian"] as const).map((a) => (
                    <button
                      key={a}
                      onClick={() => setVoiceAccentFilter(a)}
                      className={cn(
                        "px-3 py-1 rounded-full text-[10.5px] font-medium tracking-wide transition-all border",
                        voiceAccentFilter === a
                          ? "bg-primary/20 border-primary/50 text-primary"
                          : "border-primary/15 text-muted-foreground/55 hover:border-primary/30 hover:text-foreground/70",
                      )}
                    >
                      {a === "all" ? "Any accent" : a}
                    </button>
                  ))}
                </div>
                {/* Age / feel */}
                <div className="flex gap-1.5 flex-wrap">
                  {(["all", "younger", "middle", "mature"] as const).map((ag) => (
                    <button
                      key={ag}
                      onClick={() => setVoiceAgeFilter(ag)}
                      className={cn(
                        "px-3 py-1 rounded-full text-[10.5px] font-medium tracking-wide transition-all border",
                        voiceAgeFilter === ag
                          ? "bg-primary/20 border-primary/50 text-primary"
                          : "border-primary/15 text-muted-foreground/55 hover:border-primary/30 hover:text-foreground/70",
                      )}
                    >
                      {ag === "all" ? "Any age" : ag === "younger" ? "Younger" : ag === "middle" ? "Mid-aged" : "Mature"}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Voice list ── */}
              <div className="max-h-64 overflow-y-auto space-y-1.5 pr-0.5">
                {filteredStandardVoices.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground/40 text-center py-4">
                    No voices match — try adjusting the filters above
                  </p>
                ) : (
                  filteredStandardVoices.map((v) => {
                    const isSelected = activeVoiceId === v.id;
                    const isPreviewing = previewingVoiceId === v.id;
                    const isFemale = FEMALE_VOICES.some((f) => f.id === v.id);
                    return (
                      <div
                        key={v.id}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-all active:scale-[0.98]",
                          isSelected
                            ? "bg-primary/12 border-primary/45 shadow-[0_0_0_1px_hsl(40_56%_50%/0.15)]"
                            : "bg-background/50 border-primary/12 hover:border-primary/30 hover:bg-primary/6",
                        )}
                        onClick={() => handleVoiceSelect(v.id)}
                      >
                        {/* Selection dot */}
                        <div className={cn(
                          "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-all",
                          isSelected ? "border-primary bg-primary/30" : "border-foreground/20",
                        )}>
                          {isSelected && <div className="w-2 h-2 rounded-full bg-primary" />}
                        </div>

                        {/* Labels */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={cn(
                              "text-[14px] font-medium",
                              isSelected ? "text-foreground" : "text-foreground/70",
                            )}>
                              {v.label}
                            </span>
                            <span className={cn(
                              "text-[10px] px-1.5 py-0.5 rounded-full border",
                              isFemale
                                ? "border-rose-400/20 text-rose-300/60"
                                : "border-sky-400/20 text-sky-300/60",
                            )}>
                              {isFemale ? "F" : "M"}
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground/50 mt-0.5">
                            {v.accent} · {v.feel}
                          </p>
                        </div>

                        {/* Preview button */}
                        <button
                          className={cn(
                            "w-8 h-8 rounded-full border flex items-center justify-center shrink-0 transition-all",
                            isPreviewing
                              ? "border-primary/60 bg-primary/20 text-primary"
                              : "border-foreground/15 text-muted-foreground/50 hover:border-primary/40 hover:text-primary hover:bg-primary/10",
                          )}
                          onClick={(e) => { e.stopPropagation(); handleVoicePreview(v.id); }}
                          title={isPreviewing ? "Stop preview" : "Preview voice"}
                        >
                          {isPreviewing
                            ? <Pause className="w-3 h-3" />
                            : <Play className="w-3 h-3 ml-px" />
                          }
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/35 mt-2 text-center">
                Tap ▶ to hear a sample before choosing
              </p>
            </div>

            {/* ── How Eos speaks — voice-call delivery preference ──────── */}
            <div>
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-1">
                How Eos speaks
              </p>
              <p className="text-[11px] text-muted-foreground/45 mb-3">
                Her delivery on voice calls — the voice itself stays the one you chose.
              </p>
              <div className="space-y-1.5">
                {VOICE_TONE_OPTIONS.map((t) => {
                  const isSelected = activeVoiceTone === t.value;
                  return (
                    <div
                      key={t.value}
                      onClick={() => handleToneSelect(t.value)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-all active:scale-[0.98]",
                        isSelected
                          ? "bg-primary/12 border-primary/45 shadow-[0_0_0_1px_hsl(40_56%_50%/0.15)]"
                          : "bg-background/50 border-primary/12 hover:border-primary/30 hover:bg-primary/6",
                      )}
                    >
                      <div
                        className={cn(
                          "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-all",
                          isSelected ? "border-primary bg-primary/30" : "border-foreground/20",
                        )}
                      >
                        {isSelected && <div className="w-2 h-2 rounded-full bg-primary" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span
                          className={cn(
                            "text-[14px] font-medium",
                            isSelected ? "text-foreground" : "text-foreground/70",
                          )}
                        >
                          {t.label}
                        </span>
                        <p className="text-[11px] text-muted-foreground/50 mt-0.5">{t.desc}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Your data ───────────────────────────────────────────── */}
            <div className="pt-2 border-t border-primary/10 space-y-3">
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase">
                Your data
              </p>

              {exportSummary ? (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                  className="rounded-xl border border-primary/20 bg-background/50 px-4 py-3 space-y-3"
                >
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                    {[
                      { label: "Messages",   value: exportSummary.messageCount },
                      { label: "Habits",     value: exportSummary.habitCount },
                      { label: "Completions", value: exportSummary.habitCompletionCount },
                      { label: "Mood logs",  value: exportSummary.moodCount },
                      { label: "Memories",   value: exportSummary.memoryCount },
                      { label: "Wins",       value: exportSummary.winCount },
                      { label: "Goals",      value: exportSummary.goalCount },
                      { label: "Commitments", value: exportSummary.commitmentCount },
                      { label: "Reminders",  value: exportSummary.reminderCount },
                      { label: "Insights",   value: exportSummary.personalitySignalCount },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex items-baseline gap-1.5">
                        <span className="text-[15px] font-medium text-foreground/80 tabular-nums">
                          {value.toLocaleString()}
                        </span>
                        <span className="text-[10.5px] text-muted-foreground/50">{label}</span>
                      </div>
                    ))}
                  </div>
                  {exportSummary.firstMessageAt && (
                    <p className="text-[10px] text-muted-foreground/40">
                      {new Date(exportSummary.firstMessageAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                      {" · "}
                      {new Date(exportSummary.lastMessageAt!).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                    </p>
                  )}
                </motion.div>
              ) : isFetchingSummary ? (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground/50 px-1 py-2">
                  <motion.div
                    className="w-3 h-3 border border-muted-foreground/40 border-t-transparent rounded-full"
                    animate={{ rotate: 360 }}
                    transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                  />
                  Loading your data…
                </div>
              ) : exportError ? (
                <div className="space-y-1.5">
                  <p className="text-[11px] text-destructive/70">{exportError}</p>
                  <button
                    onClick={handlePreviewExport}
                    className="text-[11px] text-primary/80 hover:text-primary tracking-wider uppercase transition-colors"
                  >
                    Retry
                  </button>
                </div>
              ) : null}

              {/* Date-range filter — optional; leave blank to include everything */}
              <div className="space-y-2">
                <p className="text-[10px] text-muted-foreground/45 tracking-wider uppercase">
                  Date range <span className="normal-case tracking-normal text-muted-foreground/35">(optional)</span>
                </p>
                <div className="flex items-center gap-2">
                  <div className="flex-1 space-y-1">
                    <label className="text-[9.5px] text-muted-foreground/40 tracking-wider uppercase block">From</label>
                    <input
                      type="date"
                      value={exportFrom}
                      max={exportTo || undefined}
                      onChange={(e) => setExportFrom(e.target.value)}
                      className="w-full bg-background/60 border border-primary/20 rounded-lg text-[12px] text-foreground/80 px-2.5 py-1.5 focus:outline-none focus:border-primary/45 transition-colors [color-scheme:dark]"
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <label className="text-[9.5px] text-muted-foreground/40 tracking-wider uppercase block">To</label>
                    <input
                      type="date"
                      value={exportTo}
                      min={exportFrom || undefined}
                      onChange={(e) => setExportTo(e.target.value)}
                      className="w-full bg-background/60 border border-primary/20 rounded-lg text-[12px] text-foreground/80 px-2.5 py-1.5 focus:outline-none focus:border-primary/45 transition-colors [color-scheme:dark]"
                    />
                  </div>
                </div>
                {rangeError ? (
                  <p className="text-[10.5px] text-destructive/70">The “from” date must be on or before the “to” date.</p>
                ) : (exportFrom || exportTo) ? (
                  <button
                    onClick={() => { setExportFrom(""); setExportTo(""); }}
                    className="text-[10px] text-muted-foreground/45 hover:text-muted-foreground/75 tracking-wider uppercase transition-colors"
                  >
                    Clear range
                  </button>
                ) : null}
              </div>

              {/* View full report — read everything in-app, no download needed */}
              <button
                onClick={handleViewReport}
                className="flex items-center justify-center gap-2 w-full text-[12px] text-primary tracking-wider uppercase font-medium rounded-xl border border-primary/30 bg-primary/8 hover:bg-primary/15 hover:border-primary/45 transition-all py-2.5"
                title="Read your full report inside the app"
              >
                <FileText className="w-3.5 h-3.5" />
                View full report
              </button>

              {/* Download options — link straight from the summary above */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-0.5">
                <span className="text-[10px] text-muted-foreground/45 tracking-wider uppercase mr-0.5">
                  Download
                </span>
                {/* Readable HTML report */}
                <button
                  onClick={() => handleExport("html")}
                  disabled={isExportingHtml || isExporting || rangeError}
                  className="flex items-center gap-1.5 text-[11px] text-primary/80 hover:text-primary tracking-wider uppercase transition-colors disabled:opacity-40 font-medium"
                  title="Human-readable report you can open in any browser"
                >
                  {isExportingHtml ? (
                    <motion.div
                      className="w-3 h-3 border border-primary/40 border-t-transparent rounded-full"
                      animate={{ rotate: 360 }}
                      transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                    />
                  ) : (
                    <Download className="w-3 h-3" />
                  )}
                  {isExportingHtml ? "Preparing…" : "Readable report"}
                </button>
                <span className="text-muted-foreground/25 text-[11px]">·</span>
                {/* Raw JSON for developers / data tools */}
                <button
                  onClick={() => handleExport("json")}
                  disabled={isExporting || isExportingHtml || rangeError}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground/75 tracking-wider uppercase transition-colors disabled:opacity-40"
                  title="Raw JSON for developers and data tools"
                >
                  {isExporting ? (
                    <motion.div
                      className="w-3 h-3 border border-muted-foreground/30 border-t-transparent rounded-full"
                      animate={{ rotate: 360 }}
                      transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                    />
                  ) : (
                    <Download className="w-3 h-3" />
                  )}
                  {isExporting ? "Preparing…" : "JSON (raw data)"}
                </button>
              </div>
              {exportError && exportSummary && (
                <p className="text-[11px] text-destructive/70">{exportError}</p>
              )}
            </div>

            {/* ── Delete account ──────────────────────────────────────── */}
            <div className="pt-2 border-t border-destructive/10 space-y-3">
              {!showDeleteConfirm ? (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center gap-2 text-[11px] text-destructive/50 hover:text-destructive/80 tracking-wider uppercase transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  Delete my account
                </button>
              ) : (
                <div className="space-y-3">
                  <p className="text-[11px] text-destructive/80 leading-relaxed">
                    This permanently deletes your account and all your conversations, memories, habits, and goals. This cannot be undone.
                  </p>
                  <p className="text-[10px] text-muted-foreground/60 tracking-wider uppercase">
                    Type DELETE to confirm
                  </p>
                  {deleteError && (
                    <p className="text-[11px] text-destructive/80">{deleteError}</p>
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={deleteConfirmText}
                      onChange={(e) => { setDeleteConfirmText(e.target.value); setDeleteError(null); }}
                      placeholder="DELETE"
                      className="bg-background/60 border-destructive/20 text-sm h-9 flex-1 text-foreground/85 placeholder:text-muted-foreground/30"
                      disabled={isDeletingAccount}
                      autoFocus
                    />
                    <Button
                      size="sm"
                      className="h-9 bg-destructive/10 text-destructive hover:bg-destructive/20 border border-destructive/25 px-4 disabled:opacity-40"
                      onClick={handleDeleteAccount}
                      disabled={deleteConfirmText !== "DELETE" || isDeletingAccount}
                    >
                      {isDeletingAccount ? (
                        <motion.div
                          className="w-3 h-3 border border-destructive/60 border-t-transparent rounded-full"
                          animate={{ rotate: 360 }}
                          transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                        />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-9 text-muted-foreground/50 hover:text-muted-foreground px-3"
                      onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(""); }}
                      disabled={isDeletingAccount}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Messages area ──────────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 sm:px-6 py-7 scroll-smooth"
      >
        <div className="flex flex-col justify-end min-h-full pb-4">
          {chatContent()}

          <AnimatePresence>
            {isTyping && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="mt-6 self-start"
              >
                <TypingIndicator />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Choice buttons (onboarding steps with predefined options) ────── */}
      <AnimatePresence>
        {showChoiceButtons && !isTyping && (
          <motion.div
            key={currentStep}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="px-4 sm:px-6 pb-4 shrink-0"
          >
            <div className="max-w-3xl mx-auto grid grid-cols-2 gap-2">
              {stepChoices!.map((choice) => (
                <button
                  key={choice.value}
                  onClick={() => handleSend({ content: choice.value })}
                  disabled={isTyping}
                  className="bg-card border border-primary/20 hover:border-primary/50 hover:bg-primary/8 text-foreground/80 hover:text-foreground text-[13.5px] px-4 py-3 rounded-xl text-left transition-all duration-200 font-sans leading-snug disabled:opacity-40"
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Input area ─────────────────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        {continuousVoice && voiceCallEnabled ? (
          /* ── Voice call overlay (replaces input bar while in talk mode) ── */
          <motion.div
            key="voice-call"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="px-4 sm:px-6 pb-5 pt-3 bg-background shrink-0 z-10"
          >
            <div className="h-px bg-[rgba(200,180,150,0.10)] mb-4" />
            <div className="max-w-3xl mx-auto bg-card border border-[rgba(200,180,150,0.09)] rounded-2xl px-5 py-5 flex flex-col items-center gap-4">

              {/* Companion avatar with phase animation */}
              <div className="relative">
                <div className={cn(
                  "w-16 h-16 rounded-full flex items-center justify-center transition-all duration-500",
                  voiceCallPhase === "speaking"
                    ? "bg-primary/15 border-2 border-primary/50 shadow-[0_0_24px_hsl(35_49%_57%/0.28)]"
                    : voiceCallPhase === "listening"
                      ? "bg-primary/8 border-2 border-primary/25"
                      : voiceCallPhase === "error"
                        ? "bg-red-500/8 border-2 border-red-400/25"
                        : "bg-card border-2 border-primary/15",
                )}>
                  <span className="font-serif text-xl text-secondary/80">{companionInitials}</span>
                </div>
                {/* Listening pulse ring */}
                {voiceCallPhase === "listening" && (
                  <motion.div
                    className="absolute inset-0 rounded-full border-2 border-primary/25"
                    animate={{ scale: [1, 1.45, 1], opacity: [0.5, 0, 0.5] }}
                    transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
                {/* Speaking pulse ring */}
                {voiceCallPhase === "speaking" && (
                  <motion.div
                    className="absolute inset-0 rounded-full border-2 border-primary/40"
                    animate={{ scale: [1, 1.25, 1], opacity: [0.7, 0.15, 0.7] }}
                    transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
              </div>

              {/* Phase label + waveform when speaking */}
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex items-center gap-2">
                  <p className={cn(
                    "text-[11px] uppercase tracking-[0.22em]",
                    voiceCallPhase === "error"
                      ? "text-red-400/80"
                      : "text-muted-foreground/60",
                  )}>
                    {voiceCallPhase === "listening" ? "Listening…"
                      : voiceCallPhase === "thinking" ? "Thinking…"
                      : voiceCallPhase === "speaking" ? "Speaking…"
                      : "Voice unavailable"}
                  </p>
                  {voiceCallPhase === "speaking" && <SpeakingBars />}
                </div>

                {/* Engine indicator — realtime calls have native interruption */}
                {voiceEngine === "realtime" && (
                  <p className="text-center text-[10px] uppercase tracking-[0.18em] text-primary/50">
                    Realtime voice
                  </p>
                )}
                {/* Fallback note — realtime not configured / couldn't connect */}
                {realtimeNote && voiceEngine === "classic" && (
                  <p className="text-center text-[11px] text-muted-foreground/50 px-2">
                    {realtimeNote}
                  </p>
                )}

                {/* Barge-in affordance — so users know they can cut in anytime */}
                {voiceCallPhase === "speaking" && !voiceCallMessage && (
                  <p className="text-center text-[11px] text-muted-foreground/45 px-2">
                    {voiceEngine === "realtime"
                      ? "Just start talking — she'll stop and listen"
                      : "Start talking to interrupt — or tap the button below"}
                  </p>
                )}

                {/* Sub-label: transient status messages (no-speech hint, error detail, etc.) */}
                <AnimatePresence>
                  {voiceCallMessage && (
                    <motion.p
                      key={voiceCallMessage}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.2 }}
                      className={cn(
                        "text-center text-[12px] leading-relaxed px-2 max-w-xs",
                        voiceCallPhase === "error"
                          ? "text-red-400/70"
                          : "text-muted-foreground/55",
                      )}
                    >
                      {voiceCallMessage}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>

              {/* ── "You said:" transcript — confirms your words were heard ────
                  Visible while the companion is thinking or speaking so you know
                  the transcript was captured correctly. Cleared when listening restarts. */}
              <AnimatePresence>
                {voiceCallRecognizedText.trim().length > 0 && voiceCallPhase !== "listening" && (
                  <motion.div
                    key="user-transcript"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="w-full px-1"
                  >
                    <div className="bg-[#141219]/70 border border-[rgba(200,180,150,0.07)] rounded-xl px-4 py-2.5 text-center">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/50 mb-1">You said</p>
                      <p className="text-[13px] text-secondary/75 leading-snug">{voiceCallRecognizedText}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* ── Live caption — words appear in sync with her voice ─────────
                  Shows only as many words as have been spoken so far, driven by
                  the ElevenLabs character-alignment timestamps.  The text is
                  the full reply; revealedWords controls how much is visible. */}
              <AnimatePresence>
                {voiceCallCaptionText.trim().length > 0 && (
                  <motion.div
                    key="voice-caption"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    className="w-full px-1"
                  >
                    <div className="bg-[#141219]/90 border border-[rgba(200,180,150,0.09)] rounded-xl px-4 py-3 text-center">
                      <p className="companion-message text-[15px] leading-relaxed text-foreground/85 min-h-[1.5em]">
                        <LiveCaption
                          text={voiceCallCaptionText}
                          revealedWords={voiceCallCaptionRevealed}
                        />
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Tap-to-interrupt — the GUARANTEED way to cut her off mid-sentence.
                  Immediately stops her audio and hands the turn to the user.
                  (Voice barge-in — just start talking — also works best-effort.) */}
              {voiceCallPhase === "speaking" && voiceEngine !== "realtime" && (
                <button
                  onClick={() => interruptSpeech({ resumeListening: true })}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-primary/20 border-2 border-primary/50 text-primary hover:bg-primary/30 text-[12px] font-semibold tracking-wider uppercase transition-all shadow-[0_0_16px_hsl(35_49%_57%/0.18)]"
                >
                  <Square className="w-3 h-3 fill-current" />
                  Tap to interrupt
                </button>
              )}

              {/* Tap-to-speak — always visible in listening phase as a manual fallback
                  (auto-loop can stall; this lets the user trigger the turn explicitly) */}
              {voiceCallPhase === "listening" && voiceEngine !== "realtime" && (
                <button
                  onClick={() => {
                    voice.stopListening();
                    voice.startListening();
                  }}
                  className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary/10 border border-primary/20 text-primary/70 hover:bg-primary/18 hover:text-primary text-[12px] font-medium tracking-wider uppercase transition-all"
                >
                  <Mic className="w-3 h-3" />
                  Tap to speak
                </button>
              )}

              {/* Retry button — classic-engine in-call errors only (no-speech,
                  recognition hiccups). Config/connect errors have no engine to
                  retry into — End call is the only action there, which avoids
                  a phantom "Listening…" state with no session behind it. */}
              {voiceCallPhase === "error" && voiceEngine === "classic" && (
                <button
                  onClick={() => {
                    voiceCallPhaseRef.current = "listening";
                    setVoiceCallPhase("listening");
                    setVoiceCallMessage(null);
                    setVoiceCallRecognizedText("");
                    voice.clearError();
                    voice.startListening();
                  }}
                  className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary/15 border border-primary/30 text-primary/80 hover:bg-primary/25 text-[12px] font-medium tracking-wider uppercase transition-all"
                >
                  <Mic className="w-3 h-3" />
                  Tap to speak
                </button>
              )}

              {/* End call button */}
              <button
                onClick={toggleContinuousVoice}
                className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-red-500/10 border border-red-500/25 text-red-400/75 hover:bg-red-500/18 hover:text-red-400 text-[12px] font-medium tracking-widest uppercase transition-all"
              >
                <PhoneOff className="w-3.5 h-3.5" />
                End call
              </button>
            </div>
          </motion.div>
        ) : (
          /* ── Normal text input area ──────────────────────────────────── */
          <motion.div
            key="text-input"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="px-4 sm:px-6 pb-5 pt-3 bg-background shrink-0 relative z-10"
          >
            <div className="h-px bg-[rgba(200,180,150,0.10)] mb-4" />

            {showTextInput && (
              <>
                <Form {...form}>
                  <form
                    onSubmit={form.handleSubmit(handleSend)}
                    className={cn(
                      "flex items-center gap-2 max-w-3xl mx-auto bg-popover border rounded-full pl-5 pr-2 py-1.5 shadow-sm transition-all",
                      voice.isListening
                        ? "border-primary/45 shadow-[0_0_0_3px_hsl(35_49%_57%/0.10)]"
                        : "border-[rgba(200,180,150,0.12)]",
                    )}
                  >
                    <FormField
                      control={form.control}
                      name="content"
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          <FormControl>
                            <Input
                              {...field}
                              placeholder={
                                voice.isListening
                                  ? "Listening — speak now…"
                                  : "Tell me what's on your mind…"
                              }
                              className="border-0 bg-transparent shadow-none focus-visible:ring-0 px-0 placeholder:text-muted-foreground/40 text-[14.5px] h-auto py-1.5 text-foreground/85"
                              disabled={isTyping || isStreaming}
                              autoComplete="off"
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <div className="flex items-center gap-1">
                      {/* ── Voice Call button — hidden behind VOICE_CALL_ENABLED
                           while the ElevenLabs realtime agent is being set up, so
                           testers never hit a disconnecting call. The per-message
                           "Listen" TTS and the Mic dictation button below are
                           unaffected. ── */}
                      {voiceCallEnabled && (
                        <button
                          type="button"
                          onClick={toggleContinuousVoice}
                          title="Start voice call"
                          className="flex items-center gap-1.5 pl-3 pr-3.5 py-2 rounded-full bg-primary/12 text-primary/80 border border-primary/20 text-[11.5px] font-medium tracking-widest uppercase shrink-0 hover:bg-primary/18 hover:text-primary active:scale-95 transition-all"
                        >
                          <Phone className="w-3.5 h-3.5" strokeWidth={2.5} />
                          Voice
                        </button>
                      )}

                      {/* ── Mic button — tap to speak, fills the input ── */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title={
                          !voice.isSupported
                            ? "Voice not available in this browser"
                            : voice.isListening
                              ? "Stop listening"
                              : "Tap to speak"
                        }
                        className={cn(
                          "rounded-full w-10 h-10 transition-all shrink-0",
                          voice.isListening
                            ? "text-primary bg-primary/18 shadow-[0_0_0_3px_hsl(35_49%_57%/0.14),0_0_12px_hsl(35_49%_57%/0.14)]"
                            : "text-muted-foreground/70 hover:text-primary hover:bg-primary/10",
                        )}
                        onClick={() => {
                          if (!voice.isSupported) {
                            setVoiceError(
                              "Voice input isn't available in this browser — try Chrome or Safari, or just type.",
                            );
                            return;
                          }
                          if (voice.isListening) {
                            voice.stopListening();
                          } else {
                            voice.clearError();
                            setVoiceError(null);
                            voice.startListening();
                          }
                        }}
                        disabled={isTyping || isStreaming}
                      >
                        {voice.isListening ? (
                          <motion.div
                            animate={{ scale: [1, 1.2, 1] }}
                            transition={{ duration: 0.7, repeat: Infinity, ease: "easeInOut" }}
                          >
                            <Mic className="w-[18px] h-[18px]" strokeWidth={2.5} />
                          </motion.div>
                        ) : (
                          <Mic className="w-[18px] h-[18px]" strokeWidth={1.8} />
                        )}
                      </Button>

                      {/* Send */}
                      <Button
                        type="submit"
                        size="icon"
                        className="rounded-full w-9 h-9 bg-primary text-primary-foreground hover:bg-primary/85 transition-all shrink-0 shadow-[0_2px_10px_hsl(35_49%_57%/0.30)]"
                        disabled={isTyping || isStreaming || !form.watch("content")}
                      >
                        <Send className="w-[16px] h-[16px] ml-0.5" strokeWidth={2} />
                      </Button>
                    </div>
                  </form>
                </Form>

                {/* Voice error / unsupported message */}
                <AnimatePresence>
                  {(voice.error || voiceError) && (
                    <motion.p
                      key="voice-err"
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="text-center text-[12px] text-amber-400/75 mt-2.5 leading-relaxed px-2"
                    >
                      {voice.error || voiceError}
                    </motion.p>
                  )}
                </AnimatePresence>

                {/* voiceError shown inline above */}
              </>
            )}

            {/* Show a subtle "or type your answer" hint when choice buttons are shown */}
            {showChoiceButtons && !isTyping && (
              <p className="text-center text-[11px] text-muted-foreground/40 mt-3 tracking-wide">
                or type your own answer below
              </p>
            )}
            {showChoiceButtons && (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(handleSend)} className="flex gap-2 max-w-3xl mx-auto mt-2">
                  <FormField
                    control={form.control}
                    name="content"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="Or type your own answer..."
                            className="bg-card border-primary/20 text-sm text-foreground/80 placeholder:text-muted-foreground/40 h-9"
                            disabled={isTyping}
                            autoComplete="off"
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    className="h-9 bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25"
                    disabled={isTyping || !form.watch("content")}
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </form>
              </Form>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
