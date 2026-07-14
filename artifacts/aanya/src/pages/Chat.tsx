import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Send, Mic, Phone, PhoneOff, Settings, X, Check, Play, Pause, Sparkles, Trash2, Download, FileText } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  useGetOnboardingStatus,
  useSubmitOnboardingAnswer,
  useGetMessages,
  useGenerateMorningNote,
  useGetProfile,
  useUpdateProfile,
  getGetOnboardingStatusQueryKey,
  getGetMessagesQueryKey,
  getGetProfileQueryKey,
} from "@workspace/api-client-react";

import { ChangeEmailForm } from "@/components/ChangeEmailForm";
import { chatMessageSchema, type ChatMessageFormValues } from "@/lib/schemas";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSpeechRecognition, speakText, stopSpeaking } from "@/lib/voice";
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

  const generateMorningNote = useGenerateMorningNote();
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
  const [voiceCallPhase, setVoiceCallPhase] = useState<"listening" | "thinking" | "speaking">("listening");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Voice picker filters
  const [voiceGenderFilter, setVoiceGenderFilter] = useState<"all" | "female" | "male">("all");
  const [voiceAccentFilter, setVoiceAccentFilter] = useState<"all" | "American" | "British" | "Australian">("all");
  const [voiceAgeFilter, setVoiceAgeFilter] = useState<"all" | "younger" | "middle" | "mature">("all");
  const morningNoteTriggered = useRef(false);
  // Ref so async TTS callbacks always read the latest continuousVoice value
  const continuousVoiceRef = useRef(false);
  useEffect(() => { continuousVoiceRef.current = continuousVoice; }, [continuousVoice]);

  const isBereavement = profile?.userPath === "bereavement";
  const companionGender = (profile as any)?.companionGender ?? "woman";
  const activeVoiceId = (profile as any)?.voiceId ?? (companionGender === "man" ? DEFAULT_MALE_VOICE : DEFAULT_FEMALE_VOICE);

  // Fetch romantic voice availability from the server
  const { data: voicesStatus } = useQuery<{ romantic: RomanticVoiceStatus[] }>({
    queryKey: ["voices-status"],
    queryFn: () => fetch(`${import.meta.env.BASE_URL}api/voices/status`).then((r) => r.json()),
    staleTime: 60_000,
    retry: false,
  });
  const romanticVoices = voicesStatus?.romantic ?? [];

  // Current account email — reuse the auth/me cache the AuthGate already populated.
  const { data: authMe } = useQuery<{ user: { id: number; email: string }; emailVerified: boolean }>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const r = await fetch(`${import.meta.env.BASE_URL}api/auth/me`);
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

  const generateMorningNoteMutate = generateMorningNote.mutate;

  // Morning Note — once per session on completion
  useEffect(() => {
    if (onboarding?.isComplete && !morningNoteTriggered.current) {
      morningNoteTriggered.current = true;
      generateMorningNoteMutate(undefined, {
        onSuccess: () =>
          queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() }),
      });
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
    if (messageId) {
      setSpeakingMessageId(messageId);
      setRevealedWords(0);
    }
    speakText(text, {
      voiceId: activeVoiceId,
      onStart: () => {
        setIsSpeaking(true);
        if (continuousVoiceRef.current) setVoiceCallPhase("speaking");
      },
      onEnd: () => {
        setIsSpeaking(false);
        setSpeakingMessageId(null);
        setRevealedWords(0);
        if (continuousVoiceRef.current) {
          setVoiceCallPhase("listening");
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
    setIsStreaming(true);
    setStreamingContent("");
    setStreamError(null);

    let finalContent = "";
    let finalMessageId: string | null = null;

    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
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
          } else if (eventName === "done") {
            finalMessageId = String(data.messageId);
            finalContent = data.content as string;
          } else if (eventName === "error") {
            throw new Error(data.error as string);
          }
        }
      }
    } catch (err) {
      console.error("[stream] Error:", err);
      setStreamError("Something went wrong. Please try sending again.");
    }

    setIsStreaming(false);
    setStreamingContent("");

    if (finalMessageId && finalContent) {
      // Prime the caption state before the query re-fetch lands, so the bubble
      // enters LiveCaption mode immediately (no flash of full text).
      setSpeakingMessageId(finalMessageId);
      setRevealedWords(0);
      queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
      handleSpeak(finalContent, finalMessageId);
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

  // Talk mode: auto-send. Mic mode: fill input for user review.
  const handleVoiceResult = (text: string) => {
    if (continuousVoiceRef.current) {
      setVoiceCallPhase("thinking");
      handleSend({ content: text });
    } else {
      form.setValue("content", text);
    }
  };

  // Live interim results: fill the input as the user is still speaking
  const handleVoiceInterim = (text: string) => {
    if (!continuousVoiceRef.current) {
      form.setValue("content", text);
    }
  };

  const voice = useSpeechRecognition(handleVoiceResult, { onInterimResult: handleVoiceInterim });

  const toggleContinuousVoice = () => {
    if (continuousVoice) {
      setContinuousVoice(false);
      voice.stopListening();
      stopSpeaking();
      setVoiceCallPhase("listening");
    } else {
      if (!voice.isSupported) {
        setVoiceError(
          "Voice input isn't available in this browser — try Chrome or Safari, or type instead.",
        );
        return;
      }
      setVoiceError(null);
      voice.clearError();
      setContinuousVoice(true);
      setVoiceCallPhase("listening");
      voice.startListening();
    }
  };

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
      const res = await fetch(`${import.meta.env.BASE_URL}api/account/export/summary`);
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
      const res = await fetch(`${import.meta.env.BASE_URL}api/account/report${qs ? `?${qs}` : ""}`);
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
      const res = await fetch(url);
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
      a.download = isHtml ? `asha-report-${dateSlug}.html` : `asha-export-${dateSlug}.json`;
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
      const res = await fetch(`${import.meta.env.BASE_URL}api/auth/account`, { method: "DELETE" });
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
            <div className="bg-card border border-primary/15 px-5 py-3.5 rounded-2xl rounded-bl-sm shadow-sm">
              <p className={cn(
                "companion-message leading-relaxed text-foreground/88",
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
                    "px-[18px] py-3 leading-relaxed shadow-sm relative",
                    isCompanion
                      ? "bg-card border border-primary/15 rounded-2xl rounded-tl-sm"
                      : "bg-muted/60 border border-white/5 rounded-2xl rounded-tr-sm",
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
                        : "font-sans text-[14.5px] text-foreground/70",
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
              <div className="px-[18px] py-3 leading-relaxed shadow-sm bg-card border border-primary/15 rounded-2xl rounded-tl-sm">
                <p className={cn(
                  "companion-message text-foreground/90",
                  isBereavement ? "text-[17px]" : "text-[16px]",
                )}>
                  {streamingContent || (
                    /* Pulsing dot while waiting for first token */
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
      <header className="h-16 flex items-center justify-between px-5 border-b border-primary/20 bg-background/98 backdrop-blur-xl z-20 shrink-0 relative">
        {/* Companion presence — left */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative shrink-0">
            <div className={cn(
              "w-8 h-8 rounded-full bg-card border flex items-center justify-center transition-all",
              isSpeaking ? "border-primary/60 shadow-[0_0_8px_hsl(40_56%_50%/0.35)]" : "border-primary/25",
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

        {/* ASHA wordmark — centered */}
        <div className="absolute left-1/2 -translate-x-1/2 select-none pointer-events-none">
          <span className="font-serif text-[13px] font-medium tracking-[0.48em] text-foreground/70">
            A S H{" "}
          </span>
          <span className="font-serif text-[13px] font-medium text-primary">A</span>
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-1">
          {/* Settings */}
          {onboarding?.isComplete && (
            <button
              onClick={() => setShowSettings((s) => !s)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium tracking-wider uppercase transition-all",
                showSettings
                  ? "bg-primary/20 text-primary"
                  : "text-primary/70 hover:text-primary hover:bg-primary/10 border border-primary/25",
              )}
            >
              {showSettings
                ? <><X className="w-3.5 h-3.5" /> Close</>
                : <><Settings className="w-3.5 h-3.5" /> Settings</>
              }
            </button>
          )}
        </div>
      </header>

      {/* ── Settings panel ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-card/95 border-b border-primary/20 px-5 py-5 backdrop-blur-xl z-10 shrink-0 space-y-6 overflow-hidden"
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
        {continuousVoice ? (
          /* ── Voice call overlay (replaces input bar while in talk mode) ── */
          <motion.div
            key="voice-call"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="px-4 sm:px-6 pb-5 pt-3 bg-background shrink-0 z-10"
          >
            <div className="h-px bg-primary/15 mb-4" />
            <div className="max-w-3xl mx-auto bg-card border border-primary/20 rounded-2xl px-5 py-5 flex flex-col items-center gap-4">

              {/* Companion avatar with phase animation */}
              <div className="relative">
                <div className={cn(
                  "w-16 h-16 rounded-full flex items-center justify-center transition-all duration-500",
                  voiceCallPhase === "speaking"
                    ? "bg-primary/15 border-2 border-primary/50 shadow-[0_0_24px_hsl(40_56%_50%/0.3)]"
                    : voiceCallPhase === "listening"
                      ? "bg-primary/8 border-2 border-primary/25"
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
              <div className="flex items-center gap-2">
                <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/60">
                  {voiceCallPhase === "listening" ? "Listening…"
                    : voiceCallPhase === "thinking" ? "Thinking…"
                    : "Speaking…"}
                </p>
                {voiceCallPhase === "speaking" && <SpeakingBars />}
              </div>

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
            <div className="h-px bg-primary/15 mb-4" />

            {showTextInput && (
              <>
                <Form {...form}>
                  <form
                    onSubmit={form.handleSubmit(handleSend)}
                    className={cn(
                      "flex items-center gap-2 max-w-3xl mx-auto bg-card border rounded-full pl-5 pr-2 py-1.5 shadow-sm transition-all",
                      voice.isListening
                        ? "border-primary/50 shadow-[0_0_0_3px_hsl(40_56%_50%/0.12)]"
                        : "border-primary/20",
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
                            ? "text-primary bg-primary/20 shadow-[0_0_0_3px_hsl(40_56%_50%/0.18),0_0_14px_hsl(40_56%_50%/0.18)]"
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
                        className="rounded-full w-9 h-9 bg-primary/15 text-primary hover:bg-primary/25 transition-all border border-primary/25 shrink-0"
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

                {/* ── Talk button — prominent gold call button ── */}
                {onboarding?.isComplete && (
                  <div className="max-w-3xl mx-auto mt-3">
                    <button
                      onClick={toggleContinuousVoice}
                      className="flex items-center justify-center gap-2.5 w-full py-3.5 rounded-full bg-primary text-background text-[13px] font-semibold tracking-[0.12em] uppercase shadow-[0_4px_20px_hsl(40_56%_50%/0.35)] hover:shadow-[0_4px_28px_hsl(40_56%_50%/0.5)] hover:bg-primary/90 active:scale-[0.97] transition-all duration-200"
                    >
                      <Phone className="w-4 h-4" strokeWidth={2.2} />
                      Start Voice Call
                    </button>
                    {voiceError && (
                      <p className="text-center text-[12px] text-amber-400/75 mt-2 leading-relaxed px-2">
                        {voiceError}
                      </p>
                    )}
                  </div>
                )}
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
