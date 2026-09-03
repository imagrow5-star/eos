import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Send, Mic, Phone, PhoneOff, Settings, X, Check, Play, Pause, Sparkles, Trash2, Download, FileText, Volume2, Square, Sun, Moon } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { playSendSound, sendSoundEnabled, setSendSoundEnabled } from "@/lib/sendSound";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { enablePush, disablePush, sendTestPush, needsInstallFirst } from "@/lib/push";

import {
  useGetOnboardingStatus,
  useSubmitOnboardingAnswer,
  useGetMessages,
  useGetProfile,
  useUpdateProfile,
  getGetOnboardingStatusQueryKey,
  getGetMessagesQueryKey,
  getGetProfileQueryKey,
  type Message,
} from "@workspace/api-client-react";

import { useContextualGreeting } from "@/api/contextualGreeting";
import { ChangeEmailForm } from "@/components/ChangeEmailForm";
import { chatMessageSchema, type ChatMessageFormValues } from "@/lib/schemas";
import { CHAT_DRAFT_KEY, ONBOARDING_DRAFT_KEY } from "@/lib/sessionDrafts";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSpeechRecognition, speakText, stopSpeaking, unlockAudioOnGesture } from "@/lib/voice";
import { shouldAutoplayChatReply } from "@/lib/ttsAutoplay";
import { countryName, suggestCountry, searchCountries, type Country } from "@/lib/countries";
// Type-only import — erased at build time. The realtimeVoice module itself
// (which drags in the ~600 KB ElevenLabs/LiveKit WebRTC stack) is loaded via
// dynamic import() only when the user actually starts a voice call, so it
// never weighs down the initial chunk.
import type { AttemptResult, RealtimeConversation, RealtimeSessionInfo } from "@/lib/realtimeVoice";
import { VoiceSessionPrefetcher } from "@/lib/voiceSessionPrefetch";
import { CaptionSyncEngine } from "@/lib/captionSync";
import { splitCrisisBlock } from "@/lib/crisisBlock";
import CrisisHelplineCard from "@/components/CrisisHelplineCard";
import {
  LanguageChips,
  AccentChips,
  VoiceGenderChips,
  VoiceChips,
  comingSoonNote,
  type VoiceOptionsData,
  type LanguageOption,
} from "@/components/VoiceLanguagePicker";
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

const DEFAULT_FEMALE_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const DEFAULT_MALE_VOICE   = "pNInz6obpgDQGcFmaJgB"; // Adam

// ─── "How Eos speaks" — voice-call delivery preference ───────────────────────
const VOICE_TONE_OPTIONS = [
  { value: "auto",   label: "Let Eos decide",      desc: "Eos adapts to the moment, softer when it's heavy, brighter when you are" },
  { value: "gentle", label: "Gentle & empathetic", desc: "Extra-soft and tender. Feelings come first" },
  { value: "calm",   label: "Calm & steady",       desc: "Slow, grounded, unhurried" },
  { value: "upbeat", label: "Warm & upbeat",       desc: "Encouraging, with gentle energy" },
] as const;

// ElevenLabs voice-minute quota exhausted (HTTP quota errors or WS close 1002)
// — never surface a raw error for this; she just needs a rest.
const VOICE_REST_MESSAGE =
  "My voice needs a little rest right now, but I'm right here with you in text.";
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
  // country + ageBand are handled by the composite "basics" card, not chips.
  userGender: [
    { label: "Male", value: "male" },
    { label: "Female", value: "female" },
    // Sentinel — intercepted in the button handler: opens the free-text path
    // instead of sending, so people can say it exactly how they'd say it.
    { label: "In my own words", value: "__custom__" },
    { label: "Skip this one", value: "skip" },
  ],
};

// ─── Replying indicator ──────────────────────────────────────────────────────
// WhatsApp-style status shown while a reply is being generated: the
// companion's name + "is replying" + three gently bouncing dots, in the calm
// bubble style. "replying" (not "typing") keeps it honest — Eos is an AI
// generating a reply — and the always-on AI disclosure under the composer
// stays visible the whole time.

function ReplyingIndicator({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 bg-card/70 w-fit pl-4 pr-3.5 py-2.5 rounded-2xl rounded-tl-sm border border-primary/12 shadow-sm backdrop-blur-sm">
      <span className="companion-message italic text-[13.5px] text-muted-foreground/90">
        {name} is replying
      </span>
      <span className="flex items-center gap-1" aria-hidden="true">
        {[0, 0.2, 0.4].map((delay, i) => (
          <motion.span
            key={i}
            className="inline-block w-[5px] h-[5px] bg-primary/60 rounded-full"
            animate={{ y: [0, -3, 0], opacity: [0.45, 1, 0.45] }}
            transition={{ duration: 0.75, repeat: Infinity, delay, ease: "easeInOut" }}
          />
        ))}
      </span>
    </div>
  );
}

// Keeps the indicator on screen a touch longer than the flag that drove it,
// so even an instant reply never makes it blink in and out abruptly (UX
// minimum-display ~400ms). This is the ONLY artificial hold — nothing is
// delayed beyond it, and it is far under the 3s cap.

function useMinVisible(active: boolean, minMs = 400): boolean {
  const [visible, setVisible] = useState(active);
  const shownAtRef = useRef(0);
  useEffect(() => {
    if (active) {
      shownAtRef.current = Date.now();
      setVisible(true);
      return;
    }
    const left = Math.max(0, minMs - (Date.now() - shownAtRef.current));
    if (left === 0) {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setVisible(false), left);
    return () => clearTimeout(t);
  }, [active, minMs]);
  return visible;
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
                  ? "text-primary-strong/95 font-[490]"  // gold tint on current word
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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

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
  // Appearance — the one remaining choice: opt-in calm dark mode (default light)
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  // Send sound — opt-in, per-device, default off
  const [sendSoundOn, setSendSoundOn] = useState(sendSoundEnabled);
  // "Forget this" (Phase A privacy) — tap a message to arm, confirm to delete
  const [forgetArmedId, setForgetArmedId] = useState<number | null>(null);
  const [forgetBusyId, setForgetBusyId] = useState<number | null>(null);
  const handleForgetMessage = async (id: number) => {
    setForgetBusyId(id);
    try {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/chat/messages/${id}`, {
        method: "DELETE",
      });
      if (r.ok) {
        setForgetArmedId(null);
        queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
      }
    } finally {
      setForgetBusyId(null);
    }
  };
  const [renameValue, setRenameValue] = useState("");
  // ── Language & voice picker (Sprint 1.5) ─────────────────────────────────
  // One fetch feeds the Settings sections AND the onboarding voice card.
  // Non-English choices are stored (helper note explains English continues
  // until 1.6 extends safety detection); voice taps are preview-then-keep.
  const [languageNote, setLanguageNote] = useState<string | null>(null);
  const [armedCatalogVoiceId, setArmedCatalogVoiceId] = useState<string | null>(null);
  const [previewingCatalogVoiceId, setPreviewingCatalogVoiceId] = useState<string | null>(null);
  const catalogPreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  // Onboarding voice-card local selections (submitted together on Continue).
  const [obVoiceLanguage, setObVoiceLanguage] = useState("en");
  const [obVoiceAccent, setObVoiceAccent] = useState("us");
  const [obVoiceGender, setObVoiceGender] = useState<"female" | "male">("female");
  const [obGenderTouched, setObGenderTouched] = useState(false);
  const [obVoiceId, setObVoiceId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  // Streaming state: text accumulates token-by-token while the model generates
  const [streamingContent, setStreamingContent] = useState("");
  const pendingStreamRef = useRef("");
  const streamFlushRafRef = useRef<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  // Message ids whose reply was the honest provider-outage fallback (the SSE
  // done event carries degraded:true) — rendered with a subtle caption so a
  // degraded reply never masquerades as a normal one. Session-local by design:
  // the flag isn't stored server-side, so history reloads drop the caption.
  const [degradedMessageIds, setDegradedMessageIds] = useState<Set<number>>(() => new Set());
  // ── Crisis floor UI state ─────────────────────────────────────────────────
  // Optimistic per-message dismissals of the helpline card (server state is
  // messages.crisisBlockDismissed; this covers the gap until refetch).
  const [dismissedCrisisIds, setDismissedCrisisIds] = useState<Set<number>>(() => new Set());
  const [crisisDismissBusyId, setCrisisDismissBusyId] = useState<number | null>(null);
  // On-call helpline overlay: fed by the stream `done` event (classic voice)
  // or the /voice-agent/crisis-status poll (realtime voice).
  const [voiceCrisisCard, setVoiceCrisisCard] = useState<
    { kind: "message" | "event"; id: number; blockText: string } | null
  >(null);
  const voiceCrisisDismissedEventIds = useRef<Set<number>>(new Set());

  const handleDismissCrisisBlock = async (messageId: number) => {
    setCrisisDismissBusyId(messageId);
    try {
      const r = await apiFetch(
        `${import.meta.env.BASE_URL}api/chat/messages/${messageId}/crisis-dismiss`,
        { method: "POST" },
      );
      if (r.ok) {
        setDismissedCrisisIds((prev) => new Set(prev).add(messageId));
        queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
      }
    } finally {
      setCrisisDismissBusyId(null);
    }
  };

  // ── Language & voice picker: data + handlers (Sprint 1.5) ─────────────────

  const onboardingVoiceStep = !onboarding?.isComplete && onboarding?.currentStep === "voice";
  // Onboarding keeps its gender + language choices LOCAL until Continue — the
  // ?gender= / ?language= overrides refetch the matching voice list without
  // saving anything.
  const voiceGenderOverride = onboardingVoiceStep && obGenderTouched ? obVoiceGender : null;
  const voiceLanguageOverride =
    onboardingVoiceStep && obVoiceLanguage !== "en" ? obVoiceLanguage : null;
  const { data: voiceOptions } = useQuery<VoiceOptionsData>({
    queryKey: [
      "settings-voice-options",
      voiceGenderOverride ?? "profile",
      voiceLanguageOverride ?? "profile-lang",
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (voiceGenderOverride) params.set("gender", voiceGenderOverride);
      if (voiceLanguageOverride) params.set("language", voiceLanguageOverride);
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/settings/voice-options${qs}`);
      if (!r.ok) throw new Error("voice options unavailable");
      return (await r.json()) as VoiceOptionsData;
    },
    enabled: showSettings || onboardingVoiceStep,
    staleTime: 60_000,
  });
  // Seed the onboarding card's gender chip from the profile-derived default
  // (companion gender) once options load — until the user flips it themselves.
  useEffect(() => {
    if (onboardingVoiceStep && voiceOptions && !obGenderTouched) {
      setObVoiceGender(voiceOptions.currentVoiceGender);
    }
  }, [onboardingVoiceStep, voiceOptions, obGenderTouched]);

  // One quiet error line for the whole voice-settings section — a failed save
  // used to be swallowed silently (`if (r.ok)` with no else), which read as
  // "saving does nothing". Every handler below clears it on success.
  const [voiceSettingsError, setVoiceSettingsError] = useState<string | null>(null);
  const voiceSettingsFailed = async (r: Response | null, fallback: string) => {
    let message = fallback;
    try {
      const body = (await r?.json()) as { error?: string } | undefined;
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body — keep the fallback line */
    }
    setVoiceSettingsError(message);
  };

  // ── Optimistic chip updates (perceived-lag fix, 2026-08) ──────────────────
  // A settings tap used to wait for POST + a full voice-options REFETCH before
  // the chip visually moved — two network round trips, felt as multi-second
  // lag on real connections. The chip now flips in the local query cache
  // immediately; the POST runs behind it, the response patches the cache with
  // the server's reconciled truth, and a failure re-fetches + shows the error
  // line (same optimistic pattern as the Memory star toggle).
  const patchVoiceOptions = (patch: Partial<VoiceOptionsData>) => {
    queryClient.setQueriesData<VoiceOptionsData>(
      { queryKey: ["settings-voice-options"] },
      (old) => (old ? { ...old, ...patch } : old),
    );
  };
  const rollbackVoiceOptions = () => {
    queryClient.invalidateQueries({ queryKey: ["settings-voice-options"] });
  };

  const handleVoiceGenderSelect = async (gender: "female" | "male") => {
    setArmedCatalogVoiceId(null);
    setVoiceSettingsError(null);
    patchVoiceOptions({ currentVoiceGender: gender, voiceGenderExplicit: true });
    const r = await apiFetch(`${import.meta.env.BASE_URL}api/settings/voice-gender`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gender }),
    }).catch(() => null);
    if (r?.ok) {
      // The server may have reconciled voice_id (and, on gap accents, the
      // accent) to match the new gender — patch what it reports, then refresh
      // in the background for the re-filtered voice lists. The profile drives
      // what actually PLAYS (TTS + calls), so refresh it too.
      const body = (await r.json().catch(() => null)) as { voiceId?: string } | null;
      if (body?.voiceId) patchVoiceOptions({ currentVoiceId: body.voiceId });
      queryClient.invalidateQueries({ queryKey: ["settings-voice-options"] });
      queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
    } else {
      rollbackVoiceOptions();
      await voiceSettingsFailed(r, "Couldn't save the voice gender. Try again.");
    }
  };

  const stopCatalogPreview = () => {
    catalogPreviewAudioRef.current?.pause();
    catalogPreviewAudioRef.current = null;
    setPreviewingCatalogVoiceId(null);
  };

  const playCatalogPreview = async (voiceId: string) => {
    stopCatalogPreview();
    setPreviewingCatalogVoiceId(voiceId);
    try {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/settings/voice/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: voiceId }),
      });
      if (!r.ok) throw new Error("preview failed");
      const { audio, format } = (await r.json()) as { audio: string; format: string };
      const el = new Audio(`data:audio/${format === "mp3" ? "mpeg" : format};base64,${audio}`);
      catalogPreviewAudioRef.current = el;
      el.onended = () => setPreviewingCatalogVoiceId((cur) => (cur === voiceId ? null : cur));
      await el.play();
    } catch {
      setPreviewingCatalogVoiceId((cur) => (cur === voiceId ? null : cur));
    }
  };

  const handleLanguageSelect = async (lang: LanguageOption) => {
    setLanguageNote(lang.active ? null : comingSoonNote(lang));
    setVoiceSettingsError(null);
    patchVoiceOptions({ currentLanguage: lang.code, currentLanguageActive: lang.active });
    const r = await apiFetch(`${import.meta.env.BASE_URL}api/settings/language`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: lang.code }),
    }).catch(() => null);
    if (r?.ok) {
      const body = (await r.json().catch(() => null)) as { voiceId?: string } | null;
      if (body?.voiceId) patchVoiceOptions({ currentVoiceId: body.voiceId });
      queryClient.invalidateQueries({ queryKey: ["settings-voice-options"] });
      queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
    } else {
      rollbackVoiceOptions();
      await voiceSettingsFailed(r, "Couldn't save the language. Try again.");
    }
  };

  const handleAccentSelect = async (accent: string) => {
    setArmedCatalogVoiceId(null);
    setVoiceSettingsError(null);
    patchVoiceOptions({ currentAccent: accent });
    const r = await apiFetch(`${import.meta.env.BASE_URL}api/settings/accent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accent }),
    }).catch(() => null);
    if (r?.ok) {
      const body = (await r.json().catch(() => null)) as { voiceId?: string } | null;
      if (body?.voiceId) patchVoiceOptions({ currentVoiceId: body.voiceId });
      queryClient.invalidateQueries({ queryKey: ["settings-voice-options"] });
      queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
    } else {
      rollbackVoiceOptions();
      await voiceSettingsFailed(r, "Couldn't save the accent. Try again.");
    }
  };

  // Settings voice tap: first tap previews + arms, second tap keeps.
  const handleCatalogVoiceTap = async (voiceId: string) => {
    if (armedCatalogVoiceId !== voiceId) {
      setArmedCatalogVoiceId(voiceId);
      void playCatalogPreview(voiceId);
      return;
    }
    stopCatalogPreview();
    setVoiceSettingsError(null);
    setArmedCatalogVoiceId(null);
    patchVoiceOptions({ currentVoiceId: voiceId });
    const r = await apiFetch(`${import.meta.env.BASE_URL}api/settings/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_id: voiceId }),
    }).catch(() => null);
    if (r?.ok) {
      queryClient.invalidateQueries({ queryKey: ["settings-voice-options"] });
      queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
    } else {
      rollbackVoiceOptions();
      await voiceSettingsFailed(r, "Couldn't save that voice. Try again.");
    }
  };

  // Onboarding voice card: same preview-then-keep feel, but selections stay
  // local until Continue submits them as ONE onboarding answer.
  const handleObVoiceTap = (voiceId: string) => {
    if (armedCatalogVoiceId !== voiceId) {
      setArmedCatalogVoiceId(voiceId);
      void playCatalogPreview(voiceId);
      return;
    }
    stopCatalogPreview();
    setObVoiceId(voiceId);
    setArmedCatalogVoiceId(null);
  };

  const handleVoiceStepContinue = () => {
    if (isTyping || submitAnswer.isPending) return;
    stopCatalogPreview();
    setIsTyping(true);
    const answer = JSON.stringify({
      language: obVoiceLanguage,
      accent: obVoiceAccent,
      // Only an actively chosen gender is saved — untouched keeps the default
      // derived from companion gender.
      ...(obGenderTouched ? { voiceGender: obVoiceGender } : {}),
      ...(obVoiceId ? { voiceId: obVoiceId } : {}),
    });
    submitAnswer.mutate(
      { data: { step: "voice", answer } },
      {
        onSuccess: (status) => {
          queryClient.setQueryData(getGetOnboardingStatusQueryKey(), status);
          queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
          setIsTyping(false);
          if (status.companionFirstMessage) handleSpeak(status.companionFirstMessage);
        },
        onError: () => setIsTyping(false),
      },
    );
  };

  const handleDismissVoiceCrisisCard = async () => {
    const card = voiceCrisisCard;
    if (!card) return;
    setVoiceCrisisCard(null); // optimistic — the card never blocks the call UI
    try {
      if (card.kind === "event") {
        voiceCrisisDismissedEventIds.current.add(card.id);
        await apiFetch(
          `${import.meta.env.BASE_URL}api/voice-agent/crisis-events/${card.id}/dismiss`,
          { method: "POST" },
        );
      } else {
        setDismissedCrisisIds((prev) => new Set(prev).add(card.id));
        await apiFetch(
          `${import.meta.env.BASE_URL}api/chat/messages/${card.id}/crisis-dismiss`,
          { method: "POST" },
        );
        queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
      }
    } catch {
      // Dismissal is best-effort UI state — never surface an error mid-call.
    }
  };
  // Live-caption state: which message is currently being spoken, and how many words revealed
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [revealedWords, setRevealedWords] = useState(0);
  // Voice call mode state
  const [voiceCallPhase, setVoiceCallPhase] = useState<"listening" | "thinking" | "speaking" | "error">("listening");
  const [voiceCallMessage, setVoiceCallMessage] = useState<string | null>(null); // sub-label / error text
  const [voiceError, setVoiceError] = useState<string | null>(null);
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
  // Manual realtime interrupt: the ElevenLabs SDK has no "stop speaking" call,
  // so tapping interrupt mutes her output (setVolume 0) and yields the turn.
  // This flag restores volume the instant her NEXT reply begins (onMode
  // "speaking"), so a manual interrupt never silences future replies.
  const realtimeMutedRef = useRef(false);
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
  // Realtime caption sync: the engine (lib/captionSync.ts) turns the session's
  // alignment/audio/interruption events into an alignment-timed word reveal —
  // the caption trails her actual voice and freezes where a barge-in stopped it.
  const captionEngineRef = useRef<CaptionSyncEngine | null>(null);
  // What the user said — shown under "You said:" while the AI is thinking/speaking
  const [voiceCallRecognizedText, setVoiceCallRecognizedText] = useState("");
  useEffect(() => { continuousVoiceRef.current = continuousVoice; }, [continuousVoice]);
  // ── Crisis floor: realtime-call helpline polling ──────────────────────────
  // The realtime reply is spoken by ElevenLabs, so nothing rides back to the
  // browser with it. During a realtime call, poll the session-authed status
  // endpoint; an undismissed voice crisis event → overlay the helpline card.
  // Classic voice mode needs no polling (the stream `done` event carries the
  // block directly). Ends with the call; dismissed events never reappear.
  useEffect(() => {
    if (!continuousVoice) {
      setVoiceCrisisCard(null);
      return;
    }
    if (voiceEngine !== "realtime") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await apiFetch(`${import.meta.env.BASE_URL}api/voice-agent/crisis-status`);
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as {
          active: boolean;
          event?: { id: number; blockText: string };
        };
        if (cancelled) return;
        if (data.active && data.event && !voiceCrisisDismissedEventIds.current.has(data.event.id)) {
          setVoiceCrisisCard({ kind: "event", id: data.event.id, blockText: data.event.blockText });
        }
      } catch {
        // Polling is best-effort — never disturb the call.
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [continuousVoice, voiceEngine]);
  // Reveal loop for realtime captions — polls the engine and mirrors its
  // snapshot into the caption states. ~12fps is plenty for word granularity;
  // identical values bail out of re-rendering.
  useEffect(() => {
    if (voiceEngine !== "realtime" || !continuousVoice) return;
    const id = window.setInterval(() => {
      const engine = captionEngineRef.current;
      if (!engine) return;
      const snap = engine.snapshot();
      setVoiceCallCaptionText((prev) => (prev === snap.text ? prev : snap.text));
      setVoiceCallCaptionRevealed((prev) => (prev === snap.revealedWords ? prev : snap.revealedWords));
    }, 80);
    return () => window.clearInterval(id);
  }, [voiceEngine, continuousVoice]);
  // NOTE: voiceCallPhaseRef is intentionally NOT synced via useEffect.
  // It must be set synchronously alongside every setVoiceCallPhase call so that
  // recognition callbacks (onend, onerror) that fire before React re-renders can
  // read the correct phase. See handleVoiceResult / handleRecognitionError.

  const isBereavement = profile?.userPath === "bereavement";
  const companionGender = (profile as any)?.companionGender ?? "woman";
  const activeVoiceId = (profile as any)?.voiceId ?? (companionGender === "man" ? DEFAULT_MALE_VOICE : DEFAULT_FEMALE_VOICE);
  // For the browser-TTS fallback: never read a non-English user's reply in an
  // English voice (secondary guard — the primary rule is that the realtime
  // agent is the only audio source during a call).
  const speechLang = ((profile as any)?.preferredLanguage as string | undefined) || "en";
  const activeVoiceTone: string = (profile as any)?.voiceTone ?? "auto";

  // Fetch romantic voice availability from the server
  const { data: voicesStatus } = useQuery<{ romantic: RomanticVoiceStatus[]; voiceCallEnabled?: boolean }>({
    queryKey: ["voices-status"],
    queryFn: () => apiFetch(`${import.meta.env.BASE_URL}api/voices/status`).then((r) => r.json()),
    staleTime: 60_000,
    retry: false,
  });
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

  // Sync rename input with loaded profile
  useEffect(() => {
    if (profile?.companionName && !renameValue) {
      setRenameValue(profile.companionName);
    }
  }, [profile?.companionName]);

  // ── About you (gender) — settings chips + onboarding "in my own words" ────
  const [genderChoice, setGenderChoice] = useState<"man" | "woman" | "custom" | null>(null);
  // Onboarding drafts — survive the tab-discard reload that happens when the
  // app is backgrounded mid-onboarding (per-tab storage, cleared on submit
  // and at auth boundaries via clearSessionDrafts).
  const readObDraft = (field: string): string => {
    try {
      const raw = sessionStorage.getItem(ONBOARDING_DRAFT_KEY);
      if (!raw) return "";
      const v = (JSON.parse(raw) as Record<string, unknown>)[field];
      return typeof v === "string" ? v : "";
    } catch {
      return "";
    }
  };
  const writeObDraft = (field: string, value: string) => {
    try {
      const raw = sessionStorage.getItem(ONBOARDING_DRAFT_KEY);
      const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (value) obj[field] = value;
      else delete obj[field];
      if (Object.keys(obj).length) sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(obj));
      else sessionStorage.removeItem(ONBOARDING_DRAFT_KEY);
    } catch {}
  };
  const [genderCustomValue, setGenderCustomValueState] = useState(() => readObDraft("genderCustom"));
  const setGenderCustomValue = (v: string) => { setGenderCustomValueState(v); writeObDraft("genderCustom", v); };
  const [customGenderMode, setCustomGenderMode] = useState(false);
  useEffect(() => {
    const g = profile?.userGender ?? null;
    setGenderChoice(
      g === "man" || g === "woman" ? g
      : g === "custom" || g === "other" ? "custom"
      : null,
    );
    setGenderCustomValue(profile?.userGenderCustom ?? "");
  }, [profile?.userGender, profile?.userGenderCustom]);

  // ── Profile basics (age + country) — onboarding card + settings rows ──────
  const [basicsAge, setBasicsAgeState] = useState(() => readObDraft("age"));
  const setBasicsAge = (v: string) => { setBasicsAgeState(v); writeObDraft("age", v); };
  const [basicsCountry, setBasicsCountry] = useState<Country | null>(null);
  const [basicsCountryQuery, setBasicsCountryQueryState] = useState(() => readObDraft("country"));
  const setBasicsCountryQuery = (v: string) => { setBasicsCountryQueryState(v); writeObDraft("country", v); };
  const [basicsError, setBasicsError] = useState<string | null>(null);
  const countrySuggestion = useMemo(() => suggestCountry(), []);
  const [settingsAge, setSettingsAge] = useState("");
  const [settingsAgeNote, setSettingsAgeNote] = useState<string | null>(null);
  const [settingsCountryQuery, setSettingsCountryQuery] = useState("");
  useEffect(() => {
    setSettingsAge(profile?.ageYears ? String(profile.ageYears) : "");
  }, [profile?.ageYears]);

  // ── Notifications (web push) — settings toggle ────────────────────────────
  const pushOn = !!(profile as unknown as { pushOptIn?: boolean } | undefined)?.pushOptIn;
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);

  const handlePushToggle = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    setPushNote(null);
    try {
      if (pushOn) {
        await disablePush();
        setPushNote("Notifications are off for this account.");
      } else {
        const r = await enablePush();
        if (!r.ok) setPushNote(r.reason);
      }
      queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
    } finally {
      setPushBusy(false);
    }
  };

  const handleSendTestPush = async () => {
    setPushNote("Sending a test…");
    const ok = await sendTestPush();
    setPushNote(
      ok
        ? "Sent. It should appear on this device in a moment."
        : "Couldn't send right now. You may have reached today's limit of two.",
    );
  };

  const form = useForm<ChatMessageFormValues>({
    resolver: zodResolver(chatMessageSchema),
    // Restore an unsent draft — mobile browsers discard backgrounded tabs, and
    // losing a half-written message to an app switch hurts in a companion app.
    // Per-tab storage: cleared on send and when the tab closes.
    defaultValues: {
      content: (() => {
        try {
          return sessionStorage.getItem(CHAT_DRAFT_KEY) ?? "";
        } catch {
          return "";
        }
      })(),
    },
  });

  // Keep the draft current as the user types; form.reset() on send empties it.
  useEffect(() => {
    const sub = form.watch((values) => {
      try {
        const c = values.content ?? "";
        if (c) sessionStorage.setItem(CHAT_DRAFT_KEY, c);
        else sessionStorage.removeItem(CHAT_DRAFT_KEY);
      } catch {}
    });
    return () => sub.unsubscribe();
  }, [form]);

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
      lang: speechLang,
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
    if (streamFlushRafRef.current !== null) { cancelAnimationFrame(streamFlushRafRef.current); streamFlushRafRef.current = null; }
    pendingStreamRef.current = "";
    setStreamingContent("");
    setStreamError(null);
    // Replying-status minimum display for the streaming bubble.
    setStreamHoldDone(false);
    if (streamHoldTimerRef.current) clearTimeout(streamHoldTimerRef.current);
    streamHoldTimerRef.current = setTimeout(() => setStreamHoldDone(true), 400);

    // Optimistically show the user's own message right away. Without this it
    // only appeared after the whole reply finished streaming and the messages
    // query refetched — so users saw the reply arrive BEFORE their own
    // question ("first the response, then my message shows up, and it's slow").
    // The post-stream invalidate reconciles this temporary entry with the
    // server's canonical list (real id + persisted reply). Negative id can't
    // collide with a real (positive) server id and is a stable React key.
    const messagesKey = getGetMessagesQueryKey();
    const optimisticUserId = -Date.now();
    queryClient.setQueryData<Message[]>(messagesKey, (old = []) => [
      ...old,
      {
        id: optimisticUserId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        isMorningNote: false,
      },
    ]);

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
    // Crisis floor: helpline block from the `done` event. Kept OUT of every
    // TTS path — resources are read, not spoken.
    let finalCrisisBlock: string | null = null;

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
        // The server answers pre-stream rejections (rate limit 429, message
        // too long 400) with a friendly { error } body — show those words
        // instead of a generic failure line.
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        if (typeof body?.error === "string" && body.error) {
          const serverErr = new Error(body.error);
          (serverErr as { serverMessage?: boolean }).serverMessage = true;
          throw serverErr;
        }
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
            finalContent += chunk;
            // Batch chunk flushes to one state update per animation frame.
            // Long replies stream many small deltas; updating state per delta
            // re-rendered the whole page per network packet — the stutter
            // testers felt on long answers. The ref accumulates synchronously
            // (voice early-TTS below reads finalContent, not state).
            pendingStreamRef.current = finalContent;
            if (streamFlushRafRef.current === null) {
              streamFlushRafRef.current = requestAnimationFrame(() => {
                streamFlushRafRef.current = null;
                setStreamingContent(pendingStreamRef.current);
              });
            }

            // ── Voice early TTS ────────────────────────────────────────────
            // In voice call mode, start TTS on the first complete sentence
            // rather than waiting for the entire reply to finish streaming.
            // Sentence = ≥8 chars ending in . ! or ? followed by a space or end.
            if (continuousVoiceRef.current && voiceEngineRef.current !== "realtime" && !voiceEarlyFired && voiceTtsGenRef.current === ttsGen) {
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
      lang: speechLang,
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
            finalCrisisBlock =
              typeof data.crisisHelplineBlock === "string" ? data.crisisHelplineBlock : null;
            if (data.degraded === true) {
              const degradedId = Number(data.messageId);
              setDegradedMessageIds((prev) => new Set(prev).add(degradedId));
            }
            // Crisis floor (classic voice mode): the helpline card overlays the
            // call UI — the block itself is never spoken.
            if (continuousVoiceRef.current && finalCrisisBlock) {
              setVoiceCrisisCard({
                kind: "message",
                id: Number(data.messageId),
                blockText: finalCrisisBlock,
              });
            }
            // In voice call mode: expand the caption text to the full reply so
            // that when the remainder TTS fires, its word positions align with
            // the full text and the overlay reveals correctly word-by-word.
            // (Speakable body only — the helpline block stays on-screen.)
            if (continuousVoiceRef.current) {
              setVoiceCallCaptionText(splitCrisisBlock(finalContent).body);
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
      // Send failed (pre-stream rejection or mid-stream error). Drop the
      // optimistic bubble — a pre-stream rejection never persisted it, and for
      // a mid-stream failure the invalidate below refetches whatever the server
      // did save. This avoids the message flashing in, then vanishing.
      queryClient.setQueryData<Message[]>(messagesKey, (old = []) =>
        old.filter((m) => m.id !== optimisticUserId),
      );
      const serverMessage =
        err instanceof Error && (err as { serverMessage?: boolean }).serverMessage
          ? err.message
          : null;
      setStreamError(serverMessage ?? "Something went wrong. Please try sending again.");
      // In voice call mode: surface the error so the user can tap to retry
      if (continuousVoiceRef.current) {
        voiceCallPhaseRef.current = "error";
        setVoiceCallPhase("error");
        setVoiceCallMessage(serverMessage ?? "Something went wrong. Tap to try again.");
      }
    }

    setIsStreaming(false);
    if (streamFlushRafRef.current !== null) { cancelAnimationFrame(streamFlushRafRef.current); streamFlushRafRef.current = null; }
    pendingStreamRef.current = "";
    setStreamingContent("");

    if (finalMessageId && finalContent) {
      queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });

      // Crisis floor: TTS speaks Eos's words only — never the helpline block.
      const speakableContent = finalCrisisBlock
        ? splitCrisisBlock(finalContent).body
        : finalContent;

      if (continuousVoiceRef.current) {
        if (voiceTtsGenRef.current !== ttsGen) {
          // The user interrupted while this reply was in flight — don't speak
          // it over them. The reply still lands in the chat history above.
        } else if (voiceEarlyFired) {
          // Early TTS already started on sentence 1.  Compute the remainder.
          const remainder = speakableContent.slice(voiceEarlyText.length).trim();

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
          setVoiceCallCaptionText(speakableContent);
          setVoiceCallCaptionRevealed(0);
          speakVoiceRemainder(speakableContent, 0);
        }
      } else {
        // Main chat: NO TTS auto-play (cost guard — see lib/ttsAutoplay.ts).
        // Every reply used to auto-fire an ElevenLabs generation here even when
        // the user never asked to hear it. Now audio only plays when the user
        // taps the per-message "Listen" button (handleSpeak on click). During
        // ONBOARDING the warm auto-play is kept — but onboarding replies use the
        // submitAnswer path, not this streaming path, so the guard below is
        // belt-and-braces for any future refactor that routes an onboarding
        // reply through streaming.
        if (shouldAutoplayChatReply({ onboardingComplete: !!onboarding?.isComplete })) {
          setSpeakingMessageId(finalMessageId);
          setRevealedWords(0);
          handleSpeak(speakableContent, finalMessageId);
        }
      }
    } else {
      queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
    }
  };

  // ─── Send handler (onboarding + chat) ────────────────────────────────────

  const handleSend = async (data: ChatMessageFormValues) => {
    if (!data.content.trim()) return;
    const content = data.content.trim();
    playSendSound(); // user sends only — never on Eos's replies (opt-in, default off)
    setStreamError(null);
    setCustomGenderMode(false);
    // Explicit empty values: a bare reset() would restore defaultValues,
    // which may hold a draft restored from sessionStorage — the sent message
    // would reappear in the box (and get re-persisted by the watcher).
    form.reset({ content: "" });
    // collapse the auto-grow textarea back to one line
    if (composerRef.current) composerRef.current.style.height = "auto";

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

  // ─── Onboarding basics card (age + country in one gentle moment) ──────────
  // The age answer goes to the server as the ageBand step; the country answer
  // is then auto-submitted behind the scenes so the pair feels like ONE step —
  // the intermediate country question is never rendered.

  const submitBasicsCountryAnswer = (answer: string) => {
    submitAnswer.mutate(
      { data: { step: "country", answer } },
      {
        onSuccess: (status) => {
          queryClient.setQueryData(getGetOnboardingStatusQueryKey(), status);
          setIsTyping(false);
          if (status.companionFirstMessage) handleSpeak(status.companionFirstMessage);
        },
        onError: () => setIsTyping(false),
      },
    );
  };

  const handleBasicsSubmit = () => {
    if (isTyping || submitAnswer.isPending) return;
    const countryAnswer = basicsCountry?.code ?? "skip";

    if (currentStep === "country") {
      // Reloaded mid-flow: age already stored, only country remains.
      setIsTyping(true);
      submitBasicsCountryAnswer(countryAnswer);
      return;
    }

    const ageText = basicsAge.trim();
    if (!ageText) {
      setBasicsError("Just your age to continue. Eos is for adults 18 and over.");
      return;
    }
    setBasicsError(null);
    setIsTyping(true);
    submitAnswer.mutate(
      { data: { step: "ageBand", answer: ageText } },
      {
        onSuccess: (ageStatus) => {
          // Accepted — the in-progress draft has served its purpose.
          writeObDraft("age", "");
          writeObDraft("country", "");
          if (ageStatus.isComplete) {
            queryClient.setQueryData(getGetOnboardingStatusQueryKey(), ageStatus);
            setIsTyping(false);
            return;
          }
          if (ageStatus.currentStep === "ageBand") {
            // Blocked (under 18) or unparseable — show her message and stay.
            queryClient.setQueryData(getGetOnboardingStatusQueryKey(), ageStatus);
            setIsTyping(false);
            if (ageStatus.companionFirstMessage) handleSpeak(ageStatus.companionFirstMessage);
            return;
          }
          // Advanced — answer country silently (typing dots stay up meanwhile).
          submitBasicsCountryAnswer(countryAnswer);
        },
        onError: () => setIsTyping(false),
      },
    );
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
    // The caption FREEZES exactly where her voice stopped — the unspoken
    // remainder must never appear. (stopSpeaking() above already killed the
    // classic reveal timers; the full reply still lands in chat history.)
    setVoiceCallMessage(null);
    if (resume) {
      voiceCallPhaseRef.current = "listening";
      setVoiceCallPhase("listening");
      setVoiceCallRecognizedText("");
      voice.startListening();                 // no-op if the barge-in mic is already running
    }
  };

  // ── Realtime interrupt (barge-in fallback) ────────────────────────────────
  // In realtime calls the ElevenLabs agent owns turn-taking, and its SDK
  // exposes no "stop speaking" method — automatic barge-in depends entirely on
  // their server-side voice detection, which sometimes misses the user. This
  // gives a GUARANTEED manual stop: mute her audio immediately (setVolume 0),
  // hand the turn back, and signal user activity so the agent yields. Volume is
  // restored the moment her next reply starts (see onMode below).
  const interruptRealtime = () => {
    const convo = realtimeConvoRef.current;
    if (!convo) return;
    realtimeMutedRef.current = true;
    try { convo.setVolume({ volume: 0 }); } catch { /* best-effort */ }
    // Freeze the caption where her voice was cut and clear the live overlay.
    captionEngineRef.current?.markInterrupted();
    setVoiceCallCaptionText("");
    setVoiceCallCaptionRevealed(0);
    // Hand the turn to the user.
    voiceCallPhaseRef.current = "listening";
    setVoiceCallPhase("listening");
    setVoiceCallRecognizedText("");
    // Tell the agent the user is active so it stops waiting on its own turn.
    try { convo.sendUserActivity(); } catch { /* best-effort */ }
  };

  // Talk mode: auto-send. Mic mode: fill input for user review.
  const handleVoiceResult = (text: string) => {
    if (continuousVoiceRef.current) {
      // Realtime engine: the ElevenLabs agent owns mic AND audio. A locally
      // armed recognizer here would transcribe the user's (or the agent's)
      // speech and auto-send it into the classic chat pipeline, whose reply
      // then plays through speakText — the "second English voice underneath"
      // testers heard on non-English calls. Kill the mic and bail.
      if (voiceEngineRef.current === "realtime") {
        voice.stopListening();
        return;
      }
      const phase = voiceCallPhaseRef.current;

      if (phase === "speaking") {
        // Mic was armed for barge-in while she talks — filter out her own voice.
        if (isLikelyEcho(text)) {
          console.log("[voice-call] ignored echo (len " + text.length + ")");
          return;
        }
        // Genuine barge-in: cut her off and treat this as the user's turn.
        console.log("[voice-call] barge-in (final, len " + text.length + ")");
        interruptSpeech({ resumeListening: false });
      } else if (phase === "thinking") {
        // Already processing a turn — a late final result would double-send.
        console.log("[voice-call] ignored transcript during thinking (len " + text.length + ")");
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
      console.log("[voice-call] transcript received (len " + text.length + ")");
      handleSend({ content: text });
    } else {
      form.setValue("content", text);
    }
  };

  // Live interim results. Voice call mode: detect barge-in while she speaks.
  // Mic mode: fill the input as the user is still speaking.
  const handleVoiceInterim = (text: string) => {
    if (continuousVoiceRef.current) {
      if (voiceEngineRef.current === "realtime") return; // agent owns audio

      // Voice barge-in (best-effort): the user starts talking over her.
      // Cut her off as soon as we hear speech that isn't an echo of her own
      // voice. A short one-word interrupt ("stop", "wait", "no") must count —
      // the old ≥2-word gate silently ignored exactly those — so we require
      // only ≥2 non-space characters. The echo guard still blocks her own
      // voice from self-interrupting. Recognition keeps running, so the final
      // transcript of the user's sentence arrives normally and isn't lost.
      if (
        voiceCallPhaseRef.current === "speaking" &&
        text.replace(/\s/g, "").length >= 2 &&
        !isLikelyEcho(text)
      ) {
        console.log("[voice-call] barge-in (interim, len " + text.length + ")");
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
    if (voiceEngineRef.current === "realtime") return; // agent owns the mic
    const phase = voiceCallPhaseRef.current;
    if (phase !== "listening" && phase !== "speaking") return;
    // Brief pause before restart to avoid hammering the browser
    setTimeout(() => {
      if (!continuousVoiceRef.current) return;
      if (voiceEngineRef.current === "realtime") return; // connected meanwhile
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
          "Mic blocked, so voice interrupt is unavailable. Use the stop button below.",
        );
      }
      return;
    }

    if (errorType === "not-allowed" || errorType === "service-not-allowed") {
      // Hard failure — mic blocked. Common inside Replit's embedded iframe preview.
      voiceCallPhaseRef.current = "error";
      setVoiceCallPhase("error");
      setVoiceCallMessage(
        "I can't access the microphone. Please allow mic access and open " +
        "the app in its own browser tab (the mic is blocked inside the embedded preview).",
      );
    } else if (errorType === "no-speech") {
      // Nothing heard — stop the auto-loop. User must tap "Tap to speak" to retry.
      // Auto-restarting here causes an infinite "Listening…" loop with no transcript.
      voiceCallPhaseRef.current = "error";
      setVoiceCallPhase("error");
      setVoiceCallMessage("I didn't catch that. Tap to try again.");
    } else if (errorType === "network") {
      voiceCallPhaseRef.current = "error";
      setVoiceCallPhase("error");
      setVoiceCallMessage("Network error with voice recognition. Tap to retry.");
    } else if (errorType === "aborted") {
      // Fired when we call stop() ourselves — completely expected, ignore it.
    } else {
      voiceCallPhaseRef.current = "error";
      setVoiceCallPhase("error");
      setVoiceCallMessage(`Voice recognition issue (${errorType}). Tap to try again.`);
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
    // Classic-engine path only — during a realtime call the agent is the
    // single audio source and local TTS must never run on top of it.
    if (voiceEngineRef.current === "realtime") return;
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
    console.log("[voice-call] speaking reply (len " + text.length + ")");
    spokenTextRef.current = text; // echo-guard reference for barge-in
    speakText(text, {
      voiceId: activeVoiceId,
      lang: speechLang,
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
      "ElevenLabs rejected the configured API key. It may be wrong or revoked. Update ELEVENLABS_API_KEY and try again.",
    agent_not_found:
      "ElevenLabs couldn't find the configured agent. Double-check ELEVENLABS_AGENT_ID.",
    signed_url_failed: "ElevenLabs couldn't authorize the call.",
    elevenlabs_unreachable:
      "Couldn't reach ElevenLabs to start the call. Check the connection and try again.",
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

  // Connect-timing beacon (non-blocking) — same pattern as client-error above,
  // so slow connects and override-cascade retries are diagnosable server-side.
  const reportVoiceCallTiming = (timing: Record<string, unknown>) => {
    fetch(`${import.meta.env.BASE_URL}api/voice-agent/client-timing`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(timing),
    }).catch(() => {});
  };

  // Session prefetcher: the /voice-agent/session bootstrap (voice token +
  // ElevenLabs signed URL) is fetched quietly on call INTENT (hover/touch on
  // the Voice button) and handed over instantly on press — see
  // lib/voiceSessionPrefetch.ts for the freshness/consume rules.
  const voiceSessionPrefetcher = useMemo(
    () =>
      new VoiceSessionPrefetcher(async () => {
        // ?provider=hume is an OFFER, not a demand: the server returns a Hume
        // session only for allowlisted accounts (English profiles, Hume env
        // configured) and serves everyone else the ElevenLabs flow unchanged.
        const res = await fetch(`${import.meta.env.BASE_URL}api/voice-agent/session?provider=hume`, {
          method: "POST",
          credentials: "include",
        });
        const body = await res.json().catch(() => null);
        return { status: res.status, body };
      }),
    [],
  );

  // Call INTENT warmup: the session bootstrap AND the lazy-loaded voice SDK
  // module. The realtimeVoice chunk (~130KB gzipped) used to download at tap
  // time inside the connect path — the first call on a device after each
  // deploy paid it mid-connect. Warming it on hover/touch moves it off the
  // critical path; the browser's module cache makes the call-path import at
  // call start resolve instantly, and repeats are free.
  const warmVoiceCallPath = useCallback(() => {
    voiceSessionPrefetcher.prefetch();
    void import("@/lib/realtimeVoice").catch(() => {
      /* offline hover — the call-path import will surface any real error */
    });
  }, [voiceSessionPrefetcher]);

  // Warm the call path as soon as the chat screen is on screen, and again
  // when the tab returns to the foreground. Mobile taps land ~100ms after
  // touchstart — far less than the signed-URL round trip — so intent-time
  // warming alone leaves phones paying that fetch inline; screen-time warming
  // means a quick "open app → call" flow finds everything ready. Dedup and
  // 60s freshness live in the prefetcher, so this never spams the endpoint.
  useEffect(() => {
    if (!voiceCallEnabled) return;
    warmVoiceCallPath();
    const onVisible = () => {
      if (document.visibilityState === "visible") warmVoiceCallPath();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [voiceCallEnabled, warmVoiceCallPath]);

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
      captionEngineRef.current = null;
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
      // A call is starting: silence any in-flight chat TTS immediately, and
      // make sure no previous agent session is still alive (a language
      // switch must never leave two agents connected at once).
      stopSpeaking();
      realtimeConvoRef.current?.endSession().catch(() => {});
      realtimeConvoRef.current = null;
      setContinuousVoice(true);
      continuousVoiceRef.current = true; // sync now — recognition callbacks may fire before the re-render
      voiceEngineRef.current = null;
      setVoiceEngine(null);
      setRealtimeNote(null);
      captionEngineRef.current = null;
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
        captionEngineRef.current = null;
        voiceCallPhaseRef.current = "listening";
        setVoiceCallPhase("listening");
        setVoiceCallRecognizedText("");
        setVoiceCallMessage(null);
        setVoiceError(VOICE_REST_MESSAGE);
      };

      // Connect-timing telemetry for this attempt (beaconed once, on first
      // agent audio — see reportVoiceCallTiming).
      const tPress = Date.now();
      const timing = {
        sessionSource: "fresh" as string,
        sessionFetchMs: 0,
        attempts: [] as AttemptResult[],
        connectedLevel: undefined as string | undefined,
        connectMs: 0,
        firstAudioMs: 0,
      };
      let firstAudioReported = false;

      // ── 0) Session bootstrap + microphone permission IN PARALLEL ────────
      // The session fetch (voice token + signed URL) starts NOW — reusing a
      // fresh prefetch from Voice-button hover/touch when one exists — and
      // resolves while the user answers the mic prompt, instead of after it.
      // The immediate .catch() only parks rejections so bailing out early
      // (mic denied) can never surface an unhandled-rejection; the real
      // rejection still reaches the await below.
      const sessionPromise = voiceSessionPrefetcher.take();
      sessionPromise.catch(() => {});

      // Never open a session we can't feed audio into: connect only once the
      // mic is granted. The probe tracks are stopped immediately — the SDK
      // (or classic mode below) opens its own stream, and the browser keeps
      // the permission grant cached.
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
            "I can't access the microphone. Please allow mic access and open " +
            "the app in its own browser tab (the mic is blocked inside the embedded preview).",
          );
        } else if (name === "NotFoundError") {
          setVoiceCallMessage("No microphone found. Connect one, then end the call and try again.");
        } else {
          setVoiceCallMessage(
            `The microphone couldn't start (${name || "unknown error"}). End the call and try again.`,
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
        const taken = await sessionPromise;
        timing.sessionSource = taken.source;
        timing.sessionFetchMs = Math.round(taken.waitMs);
        const res = taken.result;
        if (res.status === 429) {
          // Per-user voice-call ceiling (middleware/usageLimits.ts): show the
          // server's friendly words and end the call cleanly — no classic
          // fallback, since the point of the limit is to stop paid usage.
          const body = res.body as { error?: unknown } | null;
          if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) return;
          setContinuousVoice(false);
          continuousVoiceRef.current = false;
          voiceEngineRef.current = null;
          setVoiceEngine(null);
          voiceCallPhaseRef.current = "listening";
          setVoiceCallPhase("listening");
          setVoiceCallMessage(null);
          setVoiceError(
            typeof body?.error === "string" && body.error
              ? body.error
              : "Voice calls need a short break. Please try again in a little while.",
          );
          return;
        }
        const session: RealtimeSessionInfo | null = res.status === 200 ? res.body : null;
        if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) return; // ended/superseded while connecting

        // ── 1a) Hume EVI engine (allowlist trial — see lib/humeVoice.ts) ────
        // Same call screen, same teardown paths: the returned controls are
        // structurally compatible with the ElevenLabs convo (endSession +
        // setVolume), so realtimeConvoRef-driven cleanup works unchanged.
        // Captions are sentence-level (Hume has no character alignment): the
        // full reply text is revealed at once.
        if (session?.available && session.mode === "hume") {
          connectStage = "handshake";
          const { startHumeCall, isHumeSession } = await import("@/lib/humeVoice");
          if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) return;
          if (!isHumeSession(session)) {
            throw new Error("Hume session response is missing accessToken/configId/userToken");
          }
          const convo = await startHumeCall(session, {
            onMode: (mode) => {
              if (realtimeGenRef.current !== rtGen || !continuousVoiceRef.current) return;
              // Mirror the ElevenLabs handler's unmute: a manual interrupt
              // muted the PREVIOUS reply (setVolume 0 in interruptRealtime);
              // this transition to "speaking" is a fresh reply, which must be
              // audible again. Without this, one tap of "Tap to interrupt" on
              // a Hume call silenced every later reply for the whole call.
              if (mode === "speaking" && realtimeMutedRef.current) {
                realtimeMutedRef.current = false;
                try { realtimeConvoRef.current?.setVolume({ volume: 1 }); } catch { /* best-effort */ }
              }
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
              setVoiceCallCaptionRevealed(text.split(/\s+/).filter(Boolean).length);
            },
            onFirstAudio: () => {
              if (realtimeGenRef.current !== rtGen) return;
              if (!firstAudioReported) {
                firstAudioReported = true;
                timing.firstAudioMs = Date.now() - tPress;
                reportVoiceCallTiming(timing);
              }
            },
            onDisconnect: (info) => {
              if (
                realtimeGenRef.current !== rtGen ||
                !continuousVoiceRef.current ||
                voiceEngineRef.current !== "realtime"
              ) return;
              realtimeGenRef.current++;
              realtimeConvoRef.current = null;
              voiceEngineRef.current = null;
              setVoiceEngine(null);
              setContinuousVoice(false);
              continuousVoiceRef.current = false;
              voiceCallPhaseRef.current = "listening";
              setVoiceCallPhase("listening");
              setVoiceCallRecognizedText("");
              setVoiceCallCaptionText("");
              setVoiceCallCaptionRevealed(0);
              setVoiceCallMessage(null);
              if (info.message) {
                setVoiceError(`Voice call disconnected: ${info.message}`);
                reportVoiceCallError("hume-disconnect", info.message);
              } else {
                setVoiceError("Voice call disconnected. Tap Voice call to reconnect.");
              }
              queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
            },
            onError: (message, context) => {
              if (realtimeGenRef.current !== rtGen) return;
              console.error("[voice-call] hume error:", message, context);
              reportVoiceCallError("hume-error", message);
            },
          });
          if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) {
            convo.endSession().catch(() => {});
            return;
          }
          timing.connectedLevel = "hume";
          timing.connectMs = Date.now() - tPress;
          realtimeConvoRef.current = convo as unknown as RealtimeConversation;
          voiceEngineRef.current = "realtime";
          stopSpeaking();
          voice.stopListening();
          setVoiceEngine("realtime");
          setVoiceCallMessage(null);
          console.log("[voice-call] hume engine connected");
          return;
        }

        if (session?.available) {
          connectStage = "handshake";
          // Fresh caption-sync engine for THIS call. Callbacks close over the
          // instance (not the ref), so a stale session can only ever mutate
          // its own dead engine — never a newer call's captions.
          const captionEngine = new CaptionSyncEngine();
          captionEngineRef.current = captionEngine;
          // Loaded on demand — see the type-only import note at the top.
          const { startRealtimeCall } = await import("@/lib/realtimeVoice");
          if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) return; // ended while the module loaded
          const convo = await startRealtimeCall(session, activeVoiceId, {
            onMode: (mode) => {
              if (realtimeGenRef.current !== rtGen || !continuousVoiceRef.current) return;
              // Her next reply is starting — undo any manual-interrupt mute so
              // this turn is audible again. (A manual interrupt muted the
              // PREVIOUS turn; this transition to "speaking" is a fresh reply.)
              if (mode === "speaking" && realtimeMutedRef.current) {
                realtimeMutedRef.current = false;
                try { realtimeConvoRef.current?.setVolume({ volume: 1 }); } catch { /* best-effort */ }
              }
              captionEngine.setMode(mode);
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
              // Full reply text — kept only as the engine's pacing fallback.
              // The visible caption is alignment-timed via the reveal loop, so
              // the user can never read ahead of her voice. (Chat-history
              // persistence is server-side and untouched by any of this.)
              captionEngine.noteAgentResponse(text);
            },
            onAudioFormat: (format) => {
              if (realtimeGenRef.current !== rtGen) return;
              captionEngine.setAudioFormat(format);
            },
            onAudioAlignment: (alignment) => {
              if (realtimeGenRef.current !== rtGen) return;
              captionEngine.addAlignment(alignment);
            },
            onAudioBytes: (bytes) => {
              if (realtimeGenRef.current !== rtGen) return;
              // First accepted audio chunk = the user is hearing her voice —
              // the moment the whole connect path is optimizing for. Beacon
              // the full timing picture once per call.
              if (!firstAudioReported) {
                firstAudioReported = true;
                timing.firstAudioMs = Date.now() - tPress;
                console.log(
                  `[voice-call] first audio in ${timing.firstAudioMs}ms ` +
                    `(session ${timing.sessionSource} ${timing.sessionFetchMs}ms, ` +
                    `connected at "${timing.connectedLevel}" after ${timing.connectMs}ms)`,
                );
                reportVoiceCallTiming(timing);
              }
              captionEngine.addAudioChunk(bytes);
            },
            onInterruption: () => {
              if (realtimeGenRef.current !== rtGen) return;
              captionEngine.markInterrupted();
            },
            onCorrection: (correctedText, originalText) => {
              if (realtimeGenRef.current !== rtGen) return;
              captionEngine.applyCorrection(correctedText, originalText);
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
              captionEngineRef.current = null;
              voiceEngineRef.current = null;
              setVoiceEngine(null);
              setContinuousVoice(false);
              continuousVoiceRef.current = false;
              voiceCallPhaseRef.current = "listening";
              setVoiceCallPhase("listening");
              setVoiceCallRecognizedText("");
              setVoiceCallCaptionText("");
              setVoiceCallCaptionRevealed(0);
              setVoiceCallMessage(null);
              if (info.message && isQuotaFailure(info.message)) {
                // Quota ran out mid-call: warm in-character note, no raw error.
                reportVoiceCallError("quota", info.message);
                setVoiceError(VOICE_REST_MESSAGE);
              } else if (info.message) {
                setVoiceError(`Voice call disconnected: ${info.message}`);
                reportVoiceCallError("disconnect", info.message);
              } else {
                setVoiceError("Voice call disconnected. Tap Voice call to reconnect.");
              }
              queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
            },
            onError: (message, context) => {
              if (realtimeGenRef.current !== rtGen) return;
              console.error("[voice-call] realtime error:", message, context);
              reportVoiceCallError("realtime-error", message);
            },
          },
          // Per-attempt cascade telemetry — which override level connected,
          // and how much each failed level cost (each is a full reconnect).
          (attempt) => {
            timing.attempts.push(attempt);
            if (attempt.ok) {
              timing.connectedLevel = attempt.level;
              timing.connectMs = Date.now() - tPress;
            }
          });
          if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) {
            // Call ended — or a newer call started — while the WebSocket
            // handshake was in flight. This session must not own anything.
            convo.endSession().catch(() => {});
            return;
          }
          realtimeConvoRef.current = convo;
          voiceEngineRef.current = "realtime";
          // From this instant the agent is the only audio source: kill any
          // classic TTS or local recognition that started during the
          // handshake window before the engine flag existed.
          stopSpeaking();
          voice.stopListening();
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
              ? "Realtime voice isn't set up yet. Using standard voice mode."
              : "Realtime voice unavailable. Using standard voice mode.",
          );
        } else if (!session) {
          setRealtimeNote("Realtime voice unavailable. Using standard voice mode.");
        }
      } catch (err) {
        console.error("[voice-call] realtime connect failed:", err);
        if (!continuousVoiceRef.current || realtimeGenRef.current !== rtGen) return;
        if (connectStage === "bootstrap") {
          // OUR api couldn't bootstrap the session — not an ElevenLabs
          // problem. Classic mode can still serve the call, with a visible
          // note (same treatment as a missing/failed session response).
          setRealtimeNote("Realtime voice couldn't connect. Using standard voice mode.");
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
          setVoiceCallMessage(`Voice call couldn't connect: ${msg}. End the call and try again.`);
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
          "Voice input isn't available in this browser. Try Chrome or Safari, or type instead.",
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
            "I can't access the microphone. Please allow mic access and open " +
            "the app in its own browser tab (the mic is blocked inside the embedded preview).",
          );
          return;
        }
        if (name === "NotFoundError") {
          voiceCallPhaseRef.current = "error";
          setVoiceCallPhase("error");
          setVoiceCallMessage("No microphone found. Please connect one and tap to try again.");
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

  // ─── Settings: about you (gender) ─────────────────────────────────────────

  const refreshProfile = () =>
    queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });

  const handleGenderSelect = (val: "man" | "woman" | "custom") => {
    if (genderChoice === val) {
      // Tap the active chip again to clear — back to "not shared"
      setGenderChoice(null);
      setGenderCustomValue("");
      updateProfile.mutate(
        { data: { userGender: "", userGenderCustom: "" } },
        { onSuccess: refreshProfile },
      );
      return;
    }
    setGenderChoice(val);
    if (val === "custom") return; // saved once they've written their words
    setGenderCustomValue("");
    updateProfile.mutate(
      { data: { userGender: val, userGenderCustom: "" } },
      { onSuccess: refreshProfile },
    );
  };

  const handleSaveCustomGender = () => {
    const words = genderCustomValue.trim();
    if (!words) return;
    updateProfile.mutate(
      { data: { userGender: "custom", userGenderCustom: words } },
      {
        onSuccess: () => {
          writeObDraft("genderCustom", "");
          refreshProfile();
        },
      },
    );
  };

  // ─── Settings: about you (age + country) ──────────────────────────────────

  const handleSaveAge = () => {
    const t = settingsAge.trim();
    if (!t) {
      // Cleared — back to "not shared"
      setSettingsAgeNote(null);
      updateProfile.mutate({ data: { ageYears: "" } }, { onSuccess: refreshProfile });
      return;
    }
    const n = Number(t);
    if (!Number.isInteger(n) || n < 18 || n > 120) {
      setSettingsAgeNote(
        Number.isFinite(n) && n >= 1 && n < 18
          ? "Eos is designed for adults 18 and over."
          : "That doesn't look like an age. Try a number like 34.",
      );
      return;
    }
    setSettingsAgeNote(null);
    updateProfile.mutate({ data: { ageYears: n } }, { onSuccess: refreshProfile });
  };

  const handleSaveCountry = (code: string) => {
    setSettingsCountryQuery("");
    updateProfile.mutate({ data: { country: code } }, { onSuccess: refreshProfile });
  };

  const handleClearCountry = () => {
    updateProfile.mutate({ data: { country: "" } }, { onSuccess: refreshProfile });
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
      // Fresh open — clear any leftover memory-export state so a new session
      // starts from clean buttons, not a stale "downloaded" note.
      setMemoryExportDone(false);
      setMemoryExportError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings]);

  // ── Membership (Dodo billing) ──────────────────────────────────────────────
  type BillingMe =
    | { kind: "legacy_full_access" }
    | {
        kind: "subscribed";
        displayName: string;
        status: string;
        trialEndsAt: string | null;
        currentPeriodEndsAt: string | null;
        voiceMinutesPerMonth: number;
      };
  const [billingMe, setBillingMe] = useState<BillingMe | null>(null);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);

  const refreshBillingMe = async () => {
    try {
      const res = await apiFetch(`${import.meta.env.BASE_URL}api/billing/me`);
      if (res.ok) setBillingMe((await res.json()) as BillingMe);
    } catch {
      // leave as-is — the section renders nothing without data
    }
  };

  useEffect(() => {
    if (showSettings) {
      setCancelArmed(false);
      setCancelNotice(null);
      refreshBillingMe();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings]);

  const handleCancelSubscription = async () => {
    setCancelBusy(true);
    setCancelNotice(null);
    try {
      const res = await apiFetch(`${import.meta.env.BASE_URL}api/billing/cancel`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        accessUntil?: string | null;
        error?: string;
      };
      if (res.ok) {
        // No-guilt confirmation — canceling should feel as safe as staying.
        setCancelNotice(
          body.accessUntil
            ? `Done. No further charges. Everything stays yours until ${new Date(body.accessUntil).toLocaleDateString()}.`
            : "Done. No further charges. Your membership ends at the close of this billing period.",
        );
        setCancelArmed(false);
        refreshBillingMe();
      } else {
        setCancelNotice(body.error ?? "That didn't go through. Please try again in a moment.");
      }
    } catch {
      setCancelNotice("That didn't go through. Please try again in a moment.");
    } finally {
      setCancelBusy(false);
    }
  };

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

  // ─── Memory export ("download your journal", Sprint E) ─────────────────────
  // A cleaner, portable take on the export: a nested JSON built for other tools,
  // and a warm Markdown "memoir" you can just read. Hits GET /api/memory/export,
  // which is rate-limited to 1/hour — so after a successful download we gently
  // note that and rest both buttons rather than inviting a guaranteed-fail
  // second click. Same friendly error UX as the Sprint 2B star-toggle.
  const [memoryExporting, setMemoryExporting] = useState<null | "json" | "markdown">(null);
  const [memoryExportError, setMemoryExportError] = useState<string | null>(null);
  const [memoryExportDone, setMemoryExportDone] = useState(false);

  const handleMemoryExport = async (format: "json" | "markdown") => {
    setMemoryExporting(format);
    setMemoryExportError(null);
    try {
      const res = await apiFetch(
        `${import.meta.env.BASE_URL}api/memory/export?format=${format}`,
      );
      if (!res.ok) {
        // 429 (once an hour) gets its own gentle line; everything else is the
        // standard try-again toast.
        if (res.status === 429) {
          setMemoryExportError(
            "You just downloaded your data. You can grab a fresh copy again in a little while.",
          );
        } else {
          setMemoryExportError("Couldn't generate your export. Try again in a minute.");
        }
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      a.download =
        format === "markdown"
          ? `eos-memory-export-${dateSlug}.md`
          : `eos-memory-export-${dateSlug}.json`;
      a.click();
      URL.revokeObjectURL(objectUrl);
      setMemoryExportDone(true);
    } catch {
      setMemoryExportError("Couldn't generate your export. Try again in a minute.");
    } finally {
      setMemoryExporting(null);
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

  // ─── Settings: voice-call delivery tone ───────────────────────────────────
  // (The legacy "Companion voice" picker was retired in Sprint 1.6 — voice
  // selection now lives entirely in the LANGUAGE/ACCENT/VOICE GENDER/VOICE
  // sections, saving through /api/settings/voice.)

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

  const companionName = profile?.companionName || "Eos";
  // Replying-status minimum display (never blinks, even on instant replies).
  const showReplying = useMinVisible(isTyping);
  // Streaming: hold the status until ~400ms have passed AND the first tokens
  // exist, then swap to the live streaming text. Replies stream, so short
  // replies show it briefly and long ones longer — no faked delays.
  const [streamHoldDone, setStreamHoldDone] = useState(true);
  const streamHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const companionInitials = companionName.substring(0, 2).toUpperCase();

  // Which steps show choice buttons instead of text input
  const currentStep = onboarding?.currentStep ?? "";
  const stepChoices = STEP_CHOICES[currentStep] ?? null;
  const showChoiceButtons = !onboarding?.isComplete && !!stepChoices;
  // Age + country share one composite card (rendered instead of chips/text input).
  const basicsStep = !onboarding?.isComplete && (currentStep === "ageBand" || currentStep === "country");
  // Voice picker card (Sprint 1.5) — replaces the text input, like the basics card.
  const voicePickStep = !onboarding?.isComplete && currentStep === "voice";
  const showTextInput =
    onboarding?.isComplete || (!stepChoices && !basicsStep && !voicePickStep && !onboarding?.isComplete);

  // ─── Memoized message thread (performance family, 2026-08) ────────────────
  // Chat.tsx is one large stateful component: before this, EVERY state change
  // — each composer keystroke, each Settings chip — re-rendered every bubble
  // in the thread (measured: ~250ms of main-thread blocking per keystroke on
  // a 4x-throttled mobile profile with a 60-message thread). The bubbles now
  // rebuild only when something they actually show changes. Handlers reach
  // the current closure through latest-refs so they never widen the deps.
  const handleSpeakRef = useRef(handleSpeak);
  handleSpeakRef.current = handleSpeak;
  const handleForgetMessageRef = useRef(handleForgetMessage);
  handleForgetMessageRef.current = handleForgetMessage;
  const handleDismissCrisisBlockRef = useRef(handleDismissCrisisBlock);
  handleDismissCrisisBlockRef.current = handleDismissCrisisBlock;

  const messageBubbles = useMemo(
    () =>
      messages.map((msg, idx) => {
        const isCompanion = msg.role === "assistant";
        const showLabel =
          isCompanion && (idx === 0 || messages[idx - 1]?.role !== "assistant");
        // Crisis floor: split the appended helpline block out of the
        // content so it renders as a distinct, dismissible card and never
        // enters TTS. Non-crisis messages pass through untouched.
        const { body: msgBody, block: crisisBlock } = isCompanion
          ? splitCrisisBlock(msg.content)
          : { body: msg.content, block: null };
        const crisisBlockVisible =
          crisisBlock !== null &&
          !msg.crisisBlockDismissed &&
          !dismissedCrisisIds.has(msg.id);

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
              onClick={() =>
                setForgetArmedId((cur) => (cur === msg.id ? null : msg.id))
              }
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
                    text={msgBody}
                    revealedWords={revealedWords}
                  />
                </p>
              ) : (
                <p className={cn(
                  isCompanion
                    ? cn("companion-message text-foreground/90", isBereavement ? "text-[17px]" : "text-[16px]")
                    : "font-sans text-[14.5px] text-user-bubble-text",
                )}>
                  {msgBody}
                </p>
              )}
              {msg.isMorningNote && (
                <span className="absolute -top-3 left-4 text-[9px] text-primary-strong/70 tracking-[0.2em] uppercase bg-background px-2 font-medium">
                  Morning Note
                </span>
              )}
            </div>

            {/* ── Crisis helpline card (crisis floor) — distinct + dismissible ── */}
            {crisisBlockVisible && crisisBlock && (
              <CrisisHelplineCard
                blockText={crisisBlock}
                onDismiss={() => handleDismissCrisisBlockRef.current(msg.id)}
                dismissing={crisisDismissBusyId === msg.id}
              />
            )}

            {/* ── Honest degraded-reply indicator (provider outage) ── */}
            {isCompanion && degradedMessageIds.has(msg.id) && (
              <span className="text-[10.5px] text-muted-foreground/55 italic mt-1 ml-1.5">
                A connection hiccup on our side. Eos will be back to its full self shortly.
              </span>
            )}

            {/* ── Forget this (Phase A privacy) — tap bubble to arm ── */}
            {forgetArmedId === msg.id && (
              <motion.div
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "flex items-center gap-3 mt-1.5",
                  isCompanion ? "ml-1" : "mr-1",
                )}
              >
                <span className="text-[10px] text-muted-foreground/50">
                  Forget this message permanently?
                </span>
                <button
                  onClick={() => handleForgetMessageRef.current(msg.id)}
                  disabled={forgetBusyId === msg.id}
                  className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400/90 hover:text-amber-300 transition-colors disabled:opacity-50"
                >
                  {forgetBusyId === msg.id ? "Forgetting…" : "Forget"}
                </button>
                <button
                  onClick={() => setForgetArmedId(null)}
                  className="text-[10px] uppercase tracking-wider text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors"
                >
                  Keep
                </button>
              </motion.div>
            )}

            {/* ── Per-message speaker button ── */}
            {isCompanion && (
              <button
                onClick={() => handleSpeakRef.current(msgBody, String(msg.id))}
                title={speakingMessageId === String(msg.id) ? "Playing…" : "Hear this message"}
                className={cn(
                  "mt-1 ml-1 flex items-center gap-1 px-2.5 py-1 rounded-full text-[10.5px] font-medium transition-all",
                  speakingMessageId === String(msg.id)
                    ? "bg-primary/20 text-primary-strong border border-primary/35"
                    : "text-muted-foreground/45 hover:text-primary-strong/80 hover:bg-primary/10 border border-transparent hover:border-primary/20",
                )}
              >
                <Volume2 className="w-3 h-3 shrink-0" />
                {speakingMessageId === String(msg.id) ? "Playing…" : "Listen"}
              </button>
            )}
          </motion.div>
        );
      }),
    // Everything the bubbles visually depend on — and nothing else. setForgetArmedId
    // is a state setter (stable); the three handlers arrive via latest-refs.
    [
      messages,
      companionName,
      isBereavement,
      speakingMessageId,
      revealedWords,
      forgetArmedId,
      forgetBusyId,
      dismissedCrisisIds,
      crisisDismissBusyId,
      degradedMessageIds,
    ],
  );

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
          {messageBubbles}
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
              <div className="px-[18px] py-3 rounded-2xl rounded-tl-sm bg-red-500/8 border border-red-500/20 text-[13.5px] text-red-700 dark:text-red-400/80 font-sans leading-relaxed">
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
              {/* In voice call mode: never show streaming text — the caption
                  overlay in the call panel is the only live text surface. The
                  "[name] is replying" status carries the name itself, so the
                  uppercase label only appears once the text takes over. */}
              {!continuousVoice && streamingContent && streamHoldDone ? (
                <>
                  <span className="text-[10px] text-muted-foreground/60 tracking-widests uppercase mb-1.5 ml-1">
                    {companionName}
                  </span>
                  <div className="px-[18px] py-3 leading-relaxed companion-bubble rounded-2xl rounded-tl-sm">
                    <p className={cn(
                      "companion-message text-foreground/90",
                      isBereavement ? "text-[17px]" : "text-[16px]",
                    )}>
                      {streamingContent}
                    </p>
                  </div>
                </>
              ) : (
                <ReplyingIndicator name={companionName} />
              )}
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
                <FileText className="w-4 h-4 text-primary-strong/70 shrink-0" />
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
                  className="text-[11px] text-muted-foreground/60 hover:text-primary-strong tracking-wider uppercase gap-1.5"
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
                    className="text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors"
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
      <header className="h-16 flex items-center justify-between px-5 border-b border-border bg-muted/95 backdrop-blur-xl z-20 shrink-0 relative">
        {/* Companion presence — left */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative shrink-0">
            <div className={cn(
              "w-8 h-8 rounded-full bg-card border flex items-center justify-center transition-all",
              isSpeaking ? "border-primary/60 shadow-[0_0_8px_hsl(var(--primary)/0.35)]" : "border-primary/25",
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
          <span className="font-serif text-[19px] font-medium tracking-[0.42em] text-foreground/90">E O S</span>
          <div className="h-px w-9 bg-primary/50 my-[3px]" />
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-1">
          {/* Settings — the one header action, so it carries the accent: soft
              green fill + green border (same family as active nav pills), not
              the old 45%-muted outline that vanished into the header. This is
              where users personalize Eos (name, tone, theme, voice) — it must
              read as a real button at first glance, still calm. */}
          <button
            onClick={() => setShowSettings((s) => !s)}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-medium tracking-wider uppercase transition-all duration-200 shadow-sm",
              showSettings
                ? "bg-primary/20 text-primary-strong border border-primary/45"
                : "bg-primary/12 text-primary-strong border border-primary/30 hover:bg-primary/20 hover:border-primary/45",
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
            className="bg-muted/95 border-b border-border backdrop-blur-xl z-10 shrink-0 overflow-hidden"
          >
            {/* The panel is taller than most viewports: the motion.div above
                must keep overflow-hidden for the height animation, so the
                SCROLLING lives on this inner wrapper — capped below the
                viewport height so every field stays reachable on laptop and
                mobile alike. */}
            <div className="max-h-[calc(100dvh-7rem)] overflow-y-auto overscroll-contain px-5 py-5 space-y-6">
            {/* ── Appearance — light default, opt-in calm dark for night ──── */}
            <div>
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">
                Appearance
              </p>
              <div className="flex gap-1.5">
                {([
                  { value: "light", label: "Light", Icon: Sun },
                  { value: "dark", label: "Dark", Icon: Moon },
                ] as const).map(({ value, label, Icon }) => (
                  <button
                    key={value}
                    onClick={() => setThemeMode(value)}
                    aria-pressed={themeMode === value}
                    className={cn(
                      "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-medium tracking-wider transition-all border",
                      themeMode === value
                        ? "bg-primary/15 text-primary-strong border-primary/30"
                        : "text-muted-foreground border-border hover:text-foreground/70 hover:border-secondary/40",
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              {/* Send sound — soft chime on YOUR sends only. ON by default
                  (it is deliberately very quiet); this switch is the one-tap
                  off. Turning it on plays the chime once as a preview. */}
              <div className="mt-4">
                <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                  Send sound
                </p>
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={sendSoundOn}
                    aria-label="Send sound"
                    onClick={() => {
                      const next = !sendSoundOn;
                      setSendSoundOn(next);
                      setSendSoundEnabled(next);
                      if (next) playSendSound(true); // preview what you enabled
                    }}
                    className={cn(
                      "relative w-11 h-6 rounded-full border transition-all shrink-0",
                      sendSoundOn ? "bg-primary/40 border-primary/60" : "bg-background/60 border-primary/25",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform duration-200",
                        sendSoundOn ? "translate-x-5 bg-primary" : "translate-x-0 bg-foreground/30",
                      )}
                    />
                  </button>
                  <p className="text-[12px] text-muted-foreground/70 leading-relaxed">
                    A soft chime when you send a message. On by default; turn it off here anytime. Never plays on {companionName}'s replies.
                  </p>
                </div>
              </div>
            </div>

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
                  className="bg-background/60 border-primary/20 text-sm text-foreground placeholder:text-muted-foreground h-9 flex-1"
                  onKeyDown={(e) => e.key === "Enter" && handleRename()}
                  maxLength={30}
                />
                <Button
                  size="sm"
                  className="h-9 bg-primary/15 text-primary-strong hover:bg-primary/25 border border-primary/25 px-4"
                  onClick={handleRename}
                  disabled={updateProfile.isPending}
                >
                  <Check className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* ── About you ───────────────────────────────────────────────── */}
            <div>
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">
                About you
              </p>
              <div className="flex gap-1.5 flex-wrap">
                {([["man", "Male"], ["woman", "Female"], ["custom", "In my own words"]] as const).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => handleGenderSelect(val)}
                    disabled={updateProfile.isPending}
                    className={cn(
                      "px-3 py-1.5 rounded-full text-[11px] font-medium tracking-wide border transition-all",
                      genderChoice === val
                        ? "bg-primary/20 border-primary/50 text-primary-strong"
                        : "border-primary/15 text-muted-foreground/55 hover:border-primary/30 hover:text-foreground/70",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {genderChoice === "custom" && (
                <div className="flex gap-2 mt-2.5">
                  <Input
                    value={genderCustomValue}
                    onChange={(e) => setGenderCustomValue(e.target.value)}
                    placeholder="in your own words, e.g. non-binary"
                    className="bg-background/60 border-primary/20 text-sm text-foreground placeholder:text-muted-foreground h-9 flex-1"
                    onKeyDown={(e) => e.key === "Enter" && handleSaveCustomGender()}
                    maxLength={120}
                  />
                  <Button
                    size="sm"
                    className="h-9 bg-primary/15 text-primary-strong hover:bg-primary/25 border border-primary/25 px-4"
                    onClick={handleSaveCustomGender}
                    disabled={updateProfile.isPending || !genderCustomValue.trim()}
                  >
                    <Check className="w-4 h-4" />
                  </Button>
                </div>
              )}
              <p className="text-[10.5px] text-muted-foreground/45 mt-2 leading-relaxed">
                Optional, so {profile?.companionName || "Eos"} speaks to you the way you'd want. Tap the selected one again to clear it.
              </p>

              {/* ── Language (Sprint 1.5) ─────────────────────────────────── */}
              <div className="mt-5">
                <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                  Language
                </p>
                {voiceOptions ? (
                  <>
                    <LanguageChips
                      languages={voiceOptions.languages}
                      current={voiceOptions.currentLanguage}
                      disabled={updateProfile.isPending}
                      onSelect={handleLanguageSelect}
                    />
                    {languageNote && (
                      <p className="text-[11px] text-primary-strong/70 mt-2 leading-relaxed">{languageNote}</p>
                    )}
                  </>
                ) : (
                  <p className="text-[11px] text-muted-foreground/40">Loading…</p>
                )}
              </div>

              {/* Hume-routed accounts (allowlist trial): VOICE GENDER now
                  applies on calls (the server maps it to a curated Hume
                  voice per gender), but the picker's specific voices and
                  accents are ElevenLabs voices with no Hume mapping yet —
                  those still shape message playback only. Say so up front
                  rather than letting a choice be silently ignored. */}
              {voiceOptions?.voiceCallProvider === "hume" && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400/90 mt-5 leading-relaxed">
                  Your voice calls are using Eos&rsquo;s new call engine. Your
                  voice gender choice applies to calls; the accent and
                  specific voice choices below shape message playback
                  (&ldquo;Listen&rdquo;) only, for now.
                </p>
              )}

              {/* ── Accent — an English concept: hidden for other active
                  languages, coming-soon helper for inactive ones ─────────── */}
              {(!voiceOptions ||
                voiceOptions.currentLanguage === "en" ||
                !voiceOptions.currentLanguageActive) && (
                <div className="mt-5">
                  <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                    Accent
                  </p>
                  {voiceOptions ? (
                    voiceOptions.currentLanguage === "en" ? (
                      <AccentChips
                        accents={voiceOptions.accents}
                        current={voiceOptions.currentAccent}
                        onSelect={handleAccentSelect}
                      />
                    ) : (
                      <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                        Accent options arrive with each language.
                      </p>
                    )
                  ) : (
                    <p className="text-[11px] text-muted-foreground/40">Loading…</p>
                  )}
                </div>
              )}

              {/* ── Voice gender ──────────────────────────────────────────── */}
              <div className="mt-5">
                <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                  Voice gender
                </p>
                {voiceOptions ? (
                  voiceOptions.currentLanguage === "en" || voiceOptions.currentLanguageActive ? (
                    <VoiceGenderChips
                      current={voiceOptions.currentVoiceGender}
                      onSelect={handleVoiceGenderSelect}
                    />
                  ) : (
                    <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                      Voice options arrive with each language.
                    </p>
                  )
                ) : (
                  <p className="text-[11px] text-muted-foreground/40">Loading…</p>
                )}
              </div>

              {/* ── Voice ─────────────────────────────────────────────────── */}
              <div className="mt-5">
                <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                  Voice
                </p>
                {voiceOptions ? (
                  voiceOptions.currentLanguage === "en" || voiceOptions.currentLanguageActive ? (
                    <>
                      <VoiceChips
                        voices={
                          voiceOptions.currentLanguage === "en"
                            ? (voiceOptions.accents.find(
                                (a) => a.code === voiceOptions.currentAccent,
                              )?.voices ?? [])
                            : (voiceOptions.accents[0]?.voices ?? [])
                        }
                        selectedVoiceId={voiceOptions.currentVoiceId}
                        previewingVoiceId={previewingCatalogVoiceId}
                        armedVoiceId={armedCatalogVoiceId}
                        onVoiceTap={handleCatalogVoiceTap}
                      />
                      <p className="text-[10.5px] text-muted-foreground/45 mt-2 leading-relaxed">
                        Tap a voice to hear it. Tap again to keep it.
                      </p>
                    </>
                  ) : (
                    <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                      Voice options arrive with each language.
                    </p>
                  )
                ) : (
                  <p className="text-[11px] text-muted-foreground/40">Loading…</p>
                )}
                {voiceSettingsError && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400/90 mt-2 leading-relaxed">
                    {voiceSettingsError}
                  </p>
                )}
              </div>

              {/* Age */}
              <div className="mt-5">
                <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                  Your age
                </p>
                <div className="flex gap-2 items-center">
                  <Input
                    value={settingsAge}
                    onChange={(e) => {
                      setSettingsAge(e.target.value);
                      setSettingsAgeNote(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveAge()}
                    placeholder="—"
                    inputMode="numeric"
                    autoComplete="off"
                    className="bg-background/60 border-primary/20 text-sm text-foreground placeholder:text-muted-foreground h-9 w-24"
                  />
                  <Button
                    size="sm"
                    className="h-9 bg-primary/15 text-primary-strong hover:bg-primary/25 border border-primary/25 px-4"
                    onClick={handleSaveAge}
                    disabled={updateProfile.isPending}
                  >
                    <Check className="w-4 h-4" />
                  </Button>
                </div>
                {settingsAgeNote && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400/70 mt-1.5 leading-relaxed">{settingsAgeNote}</p>
                )}
              </div>

              {/* Country */}
              <div className="mt-5">
                <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                  Your country
                </p>
                {profile?.country && countryName(profile.country) ? (
                  <div className="flex items-center gap-2.5">
                    <span className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-primary/15 border border-primary/40 text-primary-strong">
                      {countryName(profile.country)}
                    </span>
                    <button
                      onClick={handleClearCountry}
                      disabled={updateProfile.isPending}
                      className="text-[11px] text-muted-foreground/55 hover:text-foreground/75 transition-colors"
                    >
                      clear
                    </button>
                  </div>
                ) : (
                  <div>
                    <Input
                      value={settingsCountryQuery}
                      onChange={(e) => setSettingsCountryQuery(e.target.value)}
                      placeholder="Start typing, e.g. India"
                      autoComplete="off"
                      className="bg-background/60 border-primary/20 text-sm text-foreground placeholder:text-muted-foreground h-9"
                    />
                    {settingsCountryQuery.trim() && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {searchCountries(settingsCountryQuery, 6).map((c) => (
                          <button
                            key={c.code}
                            onClick={() => handleSaveCountry(c.code)}
                            disabled={updateProfile.isPending}
                            className="px-3 py-1.5 rounded-full text-[11px] border border-primary/15 text-foreground/70 hover:border-primary/40 hover:text-foreground transition-all"
                          >
                            {c.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <p className="text-[10.5px] text-muted-foreground/45 mt-2 leading-relaxed">
                  Both optional. They help {profile?.companionName || "Eos"} meet you where you are, and know who to point you to if you ever need local support.
                </p>
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
                    className="shrink-0 text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors"
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

            {/* ── Membership (Dodo billing) ───────────────────────────────── */}
            {billingMe && (
              <div>
                <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">
                  Membership
                </p>
                {billingMe.kind === "legacy_full_access" ? (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[13px] text-foreground/75">
                      Full access. You were here before memberships.
                    </p>
                    <a
                      href={`${import.meta.env.BASE_URL}pricing`}
                      className="shrink-0 text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors"
                    >
                      See plans
                    </a>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] text-foreground/75">
                          {billingMe.displayName}
                          <span className="text-muted-foreground/60"> · {billingMe.status === "trialing" ? "free trial" : billingMe.status.replace("_", " ")}</span>
                        </p>
                        <p className="text-[10.5px] text-muted-foreground/45 mt-1 leading-relaxed">
                          {billingMe.status === "trialing" && billingMe.trialEndsAt
                            ? `Trial ends ${new Date(billingMe.trialEndsAt).toLocaleDateString()}.`
                            : billingMe.status === "canceled" && billingMe.currentPeriodEndsAt
                              ? `Ends ${new Date(billingMe.currentPeriodEndsAt).toLocaleDateString()}. Everything stays yours until then.`
                              : billingMe.currentPeriodEndsAt
                                ? `Renews ${new Date(billingMe.currentPeriodEndsAt).toLocaleDateString()}.`
                                : ""}{" "}
                          {billingMe.voiceMinutesPerMonth.toLocaleString()} voice minutes / month.
                        </p>
                      </div>
                      <a
                        href={`${import.meta.env.BASE_URL}pricing`}
                        className="shrink-0 text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors"
                      >
                        Change plan
                      </a>
                    </div>
                    {billingMe.status !== "canceled" && (
                      !cancelArmed ? (
                        <button
                          onClick={() => setCancelArmed(true)}
                          className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground/80 tracking-wider uppercase transition-colors"
                        >
                          Cancel membership
                        </button>
                      ) : (
                        <div className="flex items-center gap-3">
                          <span className="text-[11px] text-muted-foreground/60">
                            Cancel at the end of this period? No guilt. You can come back anytime.
                          </span>
                          <button
                            onClick={handleCancelSubscription}
                            disabled={cancelBusy}
                            className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400/90 hover:text-amber-300 transition-colors disabled:opacity-50"
                          >
                            {cancelBusy ? "Cancelling…" : "Yes, cancel"}
                          </button>
                          <button
                            onClick={() => setCancelArmed(false)}
                            className="text-[10px] uppercase tracking-wider text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors"
                          >
                            Keep it
                          </button>
                        </div>
                      )
                    )}
                    {cancelNotice && (
                      <p className="text-[11.5px] text-foreground/60 leading-relaxed">{cancelNotice}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Notifications ───────────────────────────────────────────── */}
            <div>
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">
                Notifications
              </p>
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-foreground/75">Gentle nudges on this device</p>
                  <p className="text-[10.5px] text-muted-foreground/45 mt-1 leading-relaxed">
                    At most two a day: your Sunday chapter, and a morning note. Nothing else, ever.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={pushOn}
                  aria-label="Toggle notifications"
                  onClick={handlePushToggle}
                  disabled={pushBusy}
                  className={cn(
                    "relative w-11 h-6 rounded-full border transition-all shrink-0",
                    pushOn ? "bg-primary/40 border-primary/60" : "bg-background/60 border-primary/25",
                    pushBusy && "opacity-50",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform duration-200",
                      pushOn ? "translate-x-5 bg-primary" : "translate-x-0 bg-foreground/30",
                    )}
                  />
                </button>
              </div>
              {!pushOn && needsInstallFirst() && (
                <p className="text-[10.5px] text-muted-foreground/45 mt-2 leading-relaxed">
                  On iPhone or iPad: first add Eos to your Home Screen (Share → Add to Home Screen), then turn
                  this on from the installed app.
                </p>
              )}
              {pushOn && (
                <button
                  type="button"
                  onClick={handleSendTestPush}
                  className="mt-2 text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors"
                >
                  Send a test
                </button>
              )}
              {pushNote && (
                <p className="text-[10.5px] text-amber-700 dark:text-amber-400/70 mt-2 leading-relaxed">{pushNote}</p>
              )}
            </div>

            {/* ── Privacy ─────────────────────────────────────────────────── */}
            <div>
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">
                Privacy
              </p>
              <p className="text-[13px] text-foreground/75">Your words stay yours</p>
              <p className="text-[10.5px] text-muted-foreground/45 mt-1 leading-relaxed">
                What's kept, who helps run Eos, and how to take anything back, in plain language.
                To make {companionName} forget something specific, tap any message in your conversation, or a
                memory on the Memory page.
              </p>
              <a
                href={`${import.meta.env.BASE_URL}privacy`}
                target="_blank"
                rel="noreferrer"
                className="inline-block mt-2 text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors"
              >
                Read the privacy page
              </a>
            </div>

            {/* ── How Eos speaks — voice-call delivery preference ──────── */}
            <div>
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-1">
                How Eos speaks
              </p>
              <p className="text-[11px] text-muted-foreground/45 mb-3">
                Delivery on voice calls. The voice itself stays the one you chose.
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
                          ? "bg-primary/12 border-primary/45 shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]"
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
                    className="text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors"
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
                      className="w-full bg-background/60 border border-primary/20 rounded-lg text-[12px] text-foreground px-2.5 py-1.5 focus:outline-none focus:border-primary/45 transition-colors [color-scheme:dark]"
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <label className="text-[9.5px] text-muted-foreground/40 tracking-wider uppercase block">To</label>
                    <input
                      type="date"
                      value={exportTo}
                      min={exportFrom || undefined}
                      onChange={(e) => setExportTo(e.target.value)}
                      className="w-full bg-background/60 border border-primary/20 rounded-lg text-[12px] text-foreground px-2.5 py-1.5 focus:outline-none focus:border-primary/45 transition-colors [color-scheme:dark]"
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
                className="flex items-center justify-center gap-2 w-full text-[12px] text-primary-strong tracking-wider uppercase font-medium rounded-xl border border-primary/30 bg-primary/8 hover:bg-primary/15 hover:border-primary/45 transition-all py-2.5"
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
                  className="flex items-center gap-1.5 text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors disabled:opacity-40 font-medium"
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

              {/* ── Your journal (memory export, Sprint E) ─────────────── */}
              <div className="pt-3 mt-1 border-t border-primary/10 space-y-2.5">
                <p className="text-[13px] text-foreground/75 leading-relaxed">
                  This is everything {companionName} remembers about you: every
                  conversation, every fact, every chapter. Your data is yours.
                  Download it any time. Keep it somewhere safe.
                </p>
                {memoryExportDone ? (
                  <p className="text-[11px] text-primary-strong/70 leading-relaxed">
                    Downloaded. It's yours to keep. You can export again in a
                    little while.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      onClick={() => handleMemoryExport("json")}
                      disabled={memoryExporting !== null}
                      className="flex items-center gap-1.5 text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors disabled:opacity-40 font-medium rounded-lg border border-primary/25 bg-primary/8 hover:bg-primary/15 px-3 py-2"
                      title="Structured JSON, for backup or import into other tools"
                    >
                      {memoryExporting === "json" ? (
                        <motion.div
                          className="w-3 h-3 border border-primary/40 border-t-transparent rounded-full"
                          animate={{ rotate: 360 }}
                          transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                        />
                      ) : (
                        <Download className="w-3 h-3" />
                      )}
                      {memoryExporting === "json" ? "Generating…" : "Download as JSON"}
                    </button>
                    <button
                      onClick={() => handleMemoryExport("markdown")}
                      disabled={memoryExporting !== null}
                      className="flex items-center gap-1.5 text-[11px] text-primary-strong/80 hover:text-primary-strong tracking-wider uppercase transition-colors disabled:opacity-40 font-medium rounded-lg border border-primary/25 bg-primary/8 hover:bg-primary/15 px-3 py-2"
                      title="A warm, readable file you can open and read anywhere"
                    >
                      {memoryExporting === "markdown" ? (
                        <motion.div
                          className="w-3 h-3 border border-primary/40 border-t-transparent rounded-full"
                          animate={{ rotate: 360 }}
                          transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                        />
                      ) : (
                        <FileText className="w-3 h-3" />
                      )}
                      {memoryExporting === "markdown" ? "Generating…" : "Download as readable file"}
                    </button>
                  </div>
                )}
                {memoryExportError && (
                  <p className="text-[11px] text-destructive/70">{memoryExportError}</p>
                )}
              </div>
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
                      className="bg-background/60 border-destructive/20 text-sm h-9 flex-1 text-foreground placeholder:text-muted-foreground"
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
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Messages area ──────────────────────────────────────────────────── */}
      {/* hidden (not unmounted — keeps thread state/scroll) while Settings is
          open: the panel doesn't span the full column, so the tail of the
          conversation used to show through beneath it. */}
      <div
        ref={scrollRef}
        className={cn(
          "flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-7",
          // scroll-smooth during streaming makes every frame's follow-scroll
          // an animated scroll that fights the next one — instant while
          // streaming, smooth the rest of the time.
          !isStreaming && "scroll-smooth",
          showSettings && "hidden",
        )}
      >
        <div className="flex flex-col justify-end min-h-full pb-4 max-w-3xl mx-auto w-full">
          {chatContent()}

          <AnimatePresence>
            {showReplying && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="mt-6 self-start"
              >
                <ReplyingIndicator name={companionName} />
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
                  onClick={() => {
                    if (choice.value === "__custom__") {
                      setCustomGenderMode(true);
                      return;
                    }
                    setCustomGenderMode(false);
                    handleSend({ content: choice.value });
                  }}
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

      {/* ── Basics card (age + country, one gentle moment) ─────────────────── */}
      <AnimatePresence>
        {basicsStep && !isTyping && (
          <motion.div
            key={`basics-${currentStep}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="px-4 sm:px-6 pb-4 min-h-0 overflow-y-auto"
          >
            <div className="max-w-3xl mx-auto bg-card border border-primary/15 rounded-2xl px-5 py-5 space-y-5">
              {currentStep === "ageBand" && (
                <div>
                  <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                    How old are you?
                  </p>
                  <Input
                    value={basicsAge}
                    onChange={(e) => {
                      setBasicsAge(e.target.value);
                      if (basicsError) setBasicsError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && handleBasicsSubmit()}
                    placeholder="e.g. 27"
                    inputMode="numeric"
                    autoComplete="off"
                    className="bg-background/60 border-primary/20 text-sm text-foreground placeholder:text-muted-foreground h-10 w-36"
                  />
                  {basicsError && (
                    <p className="text-[12px] text-amber-700 dark:text-amber-400/75 mt-2 leading-relaxed">{basicsError}</p>
                  )}
                </div>
              )}

              <div>
                <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                  Your country{" "}
                  <span className="text-muted-foreground/45 normal-case tracking-normal">(optional)</span>
                </p>
                {basicsCountry ? (
                  <div className="flex items-center gap-2.5">
                    <span className="px-3 py-1.5 rounded-full text-[12px] font-medium bg-primary/15 border border-primary/40 text-primary-strong">
                      {basicsCountry.name}
                    </span>
                    <button
                      onClick={() => {
                        setBasicsCountry(null);
                        setBasicsCountryQuery("");
                      }}
                      className="text-[11px] text-muted-foreground/55 hover:text-foreground/75 transition-colors"
                    >
                      change
                    </button>
                  </div>
                ) : (
                  <>
                    <Input
                      value={basicsCountryQuery}
                      onChange={(e) => setBasicsCountryQuery(e.target.value)}
                      placeholder="Start typing, e.g. India"
                      autoComplete="off"
                      className="bg-background/60 border-primary/20 text-sm text-foreground placeholder:text-muted-foreground h-10"
                    />
                    {basicsCountryQuery.trim() ? (
                      (() => {
                        const matches = searchCountries(basicsCountryQuery, 6);
                        return matches.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {matches.map((c) => (
                              <button
                                key={c.code}
                                onClick={() => {
                                  setBasicsCountry(c);
                                  setBasicsCountryQuery("");
                                }}
                                className="px-3 py-1.5 rounded-full text-[12px] border border-primary/15 text-foreground/70 hover:border-primary/40 hover:text-foreground transition-all"
                              >
                                {c.name}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[11.5px] text-muted-foreground/45 mt-2 leading-relaxed">
                            No match. It's completely fine to leave this blank.
                          </p>
                        );
                      })()
                    ) : countrySuggestion ? (
                      <button
                        onClick={() => setBasicsCountry(countrySuggestion)}
                        className="mt-2 px-3 py-1.5 rounded-full text-[12px] border border-primary/20 text-foreground/70 hover:border-primary/45 hover:bg-primary/8 hover:text-foreground transition-all"
                      >
                        I'm in {countrySuggestion.name}
                      </button>
                    ) : null}
                  </>
                )}
              </div>

              <div className="flex items-center gap-3 pt-1">
                <Button
                  onClick={handleBasicsSubmit}
                  disabled={isTyping || submitAnswer.isPending}
                  className="h-10 px-6 bg-primary text-primary-foreground hover:bg-primary/85 rounded-full shadow-[0_2px_10px_hsl(var(--primary)/0.30)]"
                >
                  Continue
                </Button>
                {!basicsCountry && (
                  <span className="text-[11px] text-muted-foreground/45">
                    leaving country blank is completely fine
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Voice picker card (onboarding, Sprint 1.5) ─────────────────────── */}
      <AnimatePresence>
        {voicePickStep && !isTyping && (
          <motion.div
            key="voice-pick"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="px-4 sm:px-6 pb-4 min-h-0 overflow-y-auto"
          >
            <div className="max-w-3xl mx-auto bg-card border border-primary/15 rounded-2xl px-5 py-5 space-y-5">
              <div>
                <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                  Language
                </p>
                {voiceOptions ? (
                  <>
                    <LanguageChips
                      languages={voiceOptions.languages}
                      current={obVoiceLanguage}
                      onSelect={(l) => {
                        setObVoiceLanguage(l.code);
                        setObVoiceId(null); // voice lists differ per language
                        setArmedCatalogVoiceId(null);
                        setLanguageNote(l.active ? null : comingSoonNote(l));
                      }}
                    />
                    {languageNote && obVoiceLanguage !== "en" && (
                      <p className="text-[11px] text-primary-strong/70 mt-2 leading-relaxed">{languageNote}</p>
                    )}
                  </>
                ) : (
                  <p className="text-[11px] text-muted-foreground/40">Loading…</p>
                )}
              </div>

              {voiceOptions &&
                (obVoiceLanguage === "en" ||
                  voiceOptions.languages.find((l) => l.code === obVoiceLanguage)?.active) && (
                <>
                  {obVoiceLanguage === "en" && (
                    <div>
                      <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                        Accent
                      </p>
                      <AccentChips
                        accents={voiceOptions.accents}
                        current={obVoiceAccent}
                        onSelect={(a) => {
                          setObVoiceAccent(a);
                          setArmedCatalogVoiceId(null);
                        }}
                      />
                    </div>
                  )}

                  <div>
                    <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                      Voice gender
                    </p>
                    <VoiceGenderChips
                      current={obVoiceGender}
                      onSelect={(g) => {
                        setObVoiceGender(g);
                        setObGenderTouched(true);
                        setObVoiceId(null);
                        setArmedCatalogVoiceId(null);
                      }}
                    />
                  </div>

                  <div>
                    <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-2">
                      Its voice
                    </p>
                    <VoiceChips
                      voices={
                        obVoiceLanguage === "en"
                          ? (voiceOptions.accents.find((a) => a.code === obVoiceAccent)?.voices ?? [])
                          : (voiceOptions.accents[0]?.voices ?? [])
                      }
                      selectedVoiceId={obVoiceId ?? ""}
                      previewingVoiceId={previewingCatalogVoiceId}
                      armedVoiceId={armedCatalogVoiceId}
                      onVoiceTap={handleObVoiceTap}
                    />
                    <p className="text-[10.5px] text-muted-foreground/45 mt-2 leading-relaxed">
                      Tap to hear a voice. Tap again to keep it. Or just continue; you can change this any time.
                    </p>
                  </div>
                </>
              )}

              <div className="flex items-center gap-3 pt-1">
                <Button
                  onClick={handleVoiceStepContinue}
                  disabled={isTyping || submitAnswer.isPending}
                  className="h-10 px-6 bg-primary text-primary-foreground hover:bg-primary/85 rounded-full shadow-[0_2px_10px_hsl(var(--primary)/0.30)]"
                >
                  Continue
                </Button>
                <span className="text-[11px] text-muted-foreground/45">
                  skipping is completely fine
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Input area ─────────────────────────────────────────────────────── */}
      {/* Hidden with the messages area while Settings is open — same bleed fix. */}
      <div className={cn("shrink-0", showSettings && "hidden")}>
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
            <div className="h-px bg-border mb-4" />
            <div className="max-w-3xl mx-auto bg-card border border-border rounded-2xl px-5 py-5 flex flex-col items-center gap-4">

              {/* Companion avatar with phase animation */}
              <div className="relative">
                <div className={cn(
                  "w-16 h-16 rounded-full flex items-center justify-center transition-all duration-500",
                  voiceCallPhase === "speaking"
                    ? "bg-primary/15 border-2 border-primary/50 shadow-[0_0_24px_hsl(var(--primary)/0.28)]"
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
                      ? "text-red-700 dark:text-red-400/80"
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
                  <p className="text-center text-[10px] uppercase tracking-[0.18em] text-primary-strong/50">
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
                      ? "Just start talking, or tap the button below to stop Eos"
                      : "Start talking to interrupt, or tap the button below"}
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
                          ? "text-red-700 dark:text-red-400/70"
                          : "text-muted-foreground/55",
                      )}
                    >
                      {voiceCallMessage}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>

              {/* ── Crisis helpline card (crisis floor) — shown on-screen during
                  the call; the spoken reply deliberately never reads numbers
                  aloud. Dismissible; reappears on any future crisis turn. ── */}
              <AnimatePresence>
                {voiceCrisisCard && (
                  <CrisisHelplineCard
                    key={`${voiceCrisisCard.kind}-${voiceCrisisCard.id}`}
                    blockText={voiceCrisisCard.blockText}
                    onDismiss={handleDismissVoiceCrisisCard}
                    className="w-full"
                  />
                )}
              </AnimatePresence>

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
                    <div className="bg-muted/70 border border-border rounded-xl px-4 py-2.5 text-center">
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
                    <div className="bg-muted/90 border border-border rounded-xl px-4 py-3 text-center">
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
                  className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-primary/20 border-2 border-primary/50 text-primary-strong hover:bg-primary/30 text-[12px] font-semibold tracking-wider uppercase transition-all shadow-[0_0_16px_hsl(var(--primary)/0.18)]"
                >
                  <Square className="w-3 h-3 fill-current" />
                  Tap to interrupt
                </button>
              )}

              {/* Realtime engine: the ElevenLabs SDK can't force a stop, so this
                  mutes her instantly and hands the turn back — a guaranteed way
                  to interrupt when their voice detection misses you. */}
              {voiceCallPhase === "speaking" && voiceEngine === "realtime" && (
                <button
                  onClick={interruptRealtime}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-primary/20 border-2 border-primary/50 text-primary-strong hover:bg-primary/30 text-[12px] font-semibold tracking-wider uppercase transition-all shadow-[0_0_16px_hsl(var(--primary)/0.18)]"
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
                  className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary/10 border border-primary/20 text-primary-strong/70 hover:bg-primary/18 hover:text-primary-strong text-[12px] font-medium tracking-wider uppercase transition-all"
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
                  className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary/15 border border-primary/30 text-primary-strong/80 hover:bg-primary/25 text-[12px] font-medium tracking-wider uppercase transition-all"
                >
                  <Mic className="w-3 h-3" />
                  Tap to speak
                </button>
              )}

              {/* End call button */}
              <button
                onClick={toggleContinuousVoice}
                className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-red-500/10 border border-red-500/25 text-red-700 dark:text-red-400/75 hover:bg-red-500/18 hover:text-red-400 text-[12px] font-medium tracking-widest uppercase transition-all"
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
            <div className="h-px bg-border mb-4" />

            {showTextInput && (
              <>
                <Form {...form}>
                  <form
                    onSubmit={form.handleSubmit(handleSend)}
                    className={cn(
                      // items-end keeps mic/send pinned to the bottom row as
                      // the textarea grows; rounded-3xl stays soft at any height
                      "flex items-end gap-2 max-w-3xl mx-auto bg-popover border rounded-3xl pl-5 pr-2 py-1.5 shadow-sm transition-all",
                      voice.isListening
                        ? "border-primary/45 shadow-[0_0_0_3px_hsl(var(--primary)/0.10)]"
                        : "border-border",
                    )}
                  >
                    <FormField
                      control={form.control}
                      name="content"
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          <FormControl>
                            {/* Auto-grow textarea: height follows content up
                                to ~5 lines, then scrolls. 16px on touch
                                screens so mobile browsers don't zoom-jump on
                                focus. Enter sends, Shift+Enter adds a line. */}
                            <textarea
                              {...field}
                              ref={(el) => {
                                field.ref(el);
                                composerRef.current = el;
                              }}
                              rows={1}
                              onInput={(e) => {
                                const el = e.currentTarget;
                                el.style.height = "auto";
                                el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  form.handleSubmit(handleSend)();
                                }
                              }}
                              placeholder={
                                voice.isListening
                                  ? "Listening. Speak now…"
                                  : "Tell me what's on your mind…"
                              }
                              className="w-full resize-none border-0 bg-transparent outline-none placeholder:text-muted-foreground text-base sm:text-[14.5px] leading-relaxed py-1.5 text-foreground max-h-[132px] overflow-y-auto disabled:opacity-50"
                              disabled={isTyping || isStreaming}
                              autoComplete="off"
                              maxLength={4000}
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
                          // Call INTENT: quietly prefetch the session bootstrap
                          // (voice token + signed URL) AND the lazy voice SDK
                          // chunk so pressing the button skips both. Deduped +
                          // 60s freshness in lib/voiceSessionPrefetch.ts;
                          // touchstart covers mobile, hover/focus cover desktop.
                          onPointerEnter={warmVoiceCallPath}
                          onFocus={warmVoiceCallPath}
                          onTouchStart={warmVoiceCallPath}
                          title="Start voice call"
                          className="flex items-center gap-1.5 pl-3 pr-3.5 py-2 rounded-full bg-primary/12 text-primary-strong/80 border border-primary/20 text-[11.5px] font-medium tracking-widest uppercase shrink-0 hover:bg-primary/18 hover:text-primary-strong active:scale-95 transition-all"
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
                            ? "text-primary-strong bg-primary/18 shadow-[0_0_0_3px_hsl(var(--primary)/0.14),0_0_12px_hsl(var(--primary)/0.14)]"
                            : "text-muted-foreground/70 hover:text-primary-strong hover:bg-primary/10",
                        )}
                        onClick={() => {
                          if (!voice.isSupported) {
                            setVoiceError(
                              "Voice input isn't available in this browser. Try Chrome or Safari, or just type.",
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
                        className="rounded-full w-9 h-9 bg-primary text-primary-foreground hover:bg-primary/85 transition-all shrink-0 shadow-[0_2px_10px_hsl(var(--primary)/0.30)]"
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
                      className="text-center text-[12px] text-amber-700 dark:text-amber-400/75 mt-2.5 leading-relaxed px-2"
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
                {customGenderMode
                  ? "say it however feels right, e.g. non-binary"
                  : "or type your own answer below"}
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
                            key={customGenderMode ? "gender-custom" : "std"}
                            autoFocus={customGenderMode}
                            placeholder={customGenderMode ? "In your own words…" : "Or type your own answer..."}
                            className="bg-card border-primary/20 text-sm text-foreground placeholder:text-muted-foreground h-9"
                            disabled={isTyping}
                            autoComplete="off"
                            maxLength={4000}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    className="h-9 bg-primary/15 text-primary-strong hover:bg-primary/25 border border-primary/25"
                    disabled={isTyping || !form.watch("content")}
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </form>
              </Form>
            )}

            {/* AI disclosure (EU AI Act Art. 50) — plain-language, always
                visible at the point of conversation so a user can tell they're
                talking to an AI without asking. Present every session (not a
                one-time flash) and in both the normal composer and onboarding
                choice modes. */}
            <p className="text-center text-[11px] text-muted-foreground/50 mt-3 px-4 leading-relaxed max-w-3xl mx-auto">
              Eos is an AI. It's here to listen anytime, but it isn't a person or a substitute for professional help.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}
