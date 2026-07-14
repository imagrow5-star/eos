import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Send, Mic, Phone, PhoneOff, Settings, X, Check, Play, Pause, Sparkles, Trash2, Download } from "lucide-react";
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

import { chatMessageSchema, type ChatMessageFormValues } from "@/lib/schemas";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSpeechRecognition, speakText, stopSpeaking } from "@/lib/voice";
import { cn } from "@/lib/utils";

// ─── Voice catalogue ──────────────────────────────────────────────────────────
// All times accent + feel labels so the user can choose by character, not ID.

const FEMALE_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel",  accent: "American", feel: "calm & warm" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella",   accent: "American", feel: "soft & friendly" },
  { id: "piTKgcLEGmPE4e6mEKli", label: "Nicole",  accent: "American", feel: "soft & intimate" },
  { id: "MF3mGyEYCl7XYWbV9V6O", label: "Elli",    accent: "American", feel: "emotional & expressive" },
  { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda", accent: "American", feel: "warm & friendly" },
  { id: "pFZP5JQG7iQjIQuC4Bku", label: "Lily",    accent: "British",  feel: "gentle & soothing" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", label: "Alice",   accent: "British",  feel: "confident & clear" },
];

const MALE_VOICES = [
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni",  accent: "American",   feel: "warm & easy" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam",    accent: "American",   feel: "deep & warm" },
  { id: "nPczCjzI2devNBz1zQrb", label: "Brian",   accent: "American",   feel: "deep & comforting" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", label: "Liam",    accent: "American",   feel: "natural & grounded" },
  { id: "JBFqnCBsd6RMkjVDRZzb", label: "George",  accent: "British",    feel: "warm & refined" },
  { id: "IKne3meq5aSn9XLyUdCD", label: "Charlie", accent: "Australian", feel: "casual & relaxed" },
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
    query: { enabled: !!onboarding?.isComplete },
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
  const morningNoteTriggered = useRef(false);

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

  // Build ordered voice sections: match companion gender first, then opposite, then romantic
  const femaleSec = { label: "Female voices", kind: "standard" as const, voices: FEMALE_VOICES };
  const maleSec   = { label: "Male voices",   kind: "standard" as const, voices: MALE_VOICES };
  const romanticSec = { label: "Romantic & intimate", kind: "romantic" as const, voices: romanticVoices };
  const voiceSections = companionGender === "man"
    ? [maleSec, femaleSec, romanticSec]
    : [femaleSec, maleSec, romanticSec];

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
      onStart: () => setIsSpeaking(true),
      onEnd: () => {
        setIsSpeaking(false);
        setSpeakingMessageId(null);
        setRevealedWords(0);
        if (continuousVoice) voice.startListening();
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

  const handleVoiceResult = (text: string) => {
    form.setValue("content", text);
    handleSend({ content: text });
  };

  const voice = useSpeechRecognition(handleVoiceResult);

  const toggleContinuousVoice = () => {
    if (continuousVoice) {
      setContinuousVoice(false);
      voice.stopListening();
    } else {
      setContinuousVoice(true);
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

  const handleExport = async () => {
    setIsExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/account/export`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setExportError((body as any)?.error ?? "Export failed. Please try again.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `asha-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError("Export failed. Please try again.");
    } finally {
      setIsExporting(false);
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
          {/* Voice toggle */}
          {onboarding?.isComplete && (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleContinuousVoice}
              className={cn(
                "rounded-full w-9 h-9 transition-all duration-500",
                continuousVoice
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-primary hover:bg-primary/10",
              )}
            >
              {continuousVoice ? <Phone className="w-4 h-4" /> : <PhoneOff className="w-4 h-4" />}
            </Button>
          )}

          {/* Settings */}
          {onboarding?.isComplete && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowSettings((s) => !s)}
              className={cn(
                "rounded-full w-9 h-9 transition-all",
                showSettings
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-primary hover:bg-primary/10",
              )}
            >
              {showSettings ? <X className="w-4 h-4" /> : <Settings className="w-4 h-4" />}
            </Button>
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

            {/* ── Voice picker ────────────────────────────────────────────── */}
            <div>
              <p className="text-[10px] text-muted-foreground/70 tracking-[0.2em] uppercase mb-3">
                Companion voice
              </p>
              <div className="max-h-72 overflow-y-auto space-y-4 pr-0.5">
                {voiceSections.map((section) => (
                  <div key={section.label}>
                    {/* Section heading */}
                    <p className="text-[9.5px] text-muted-foreground/40 tracking-[0.15em] uppercase mb-1.5 sticky top-0 bg-card/95 py-0.5 flex items-center gap-1.5">
                      {section.kind === "romantic" && (
                        <Sparkles className="w-2.5 h-2.5 text-secondary/50" />
                      )}
                      {section.label}
                    </p>

                    <div className="space-y-1.5">
                      {section.kind === "romantic" ? (
                        /* ── Romantic voices ── */
                        romanticVoices.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground/35 px-3 py-2">
                            Setting up — check back shortly
                          </p>
                        ) : (
                          romanticVoices.map((v) => {
                            const voiceId = v.accountVoiceId;
                            const isAvailable = v.resolved && !!voiceId;
                            const isSelected = !!voiceId && activeVoiceId === voiceId;
                            const isPreviewing = !!voiceId && previewingVoiceId === voiceId;
                            return (
                              <div
                                key={v.libraryId}
                                className={cn(
                                  "flex items-center gap-3 px-3 py-2 rounded-xl border transition-all",
                                  isAvailable ? "cursor-pointer" : "cursor-default opacity-50",
                                  isSelected
                                    ? "bg-secondary/10 border-secondary/40"
                                    : isAvailable
                                      ? "bg-background/50 border-primary/12 hover:border-secondary/25 hover:bg-secondary/5"
                                      : "bg-background/30 border-primary/8",
                                )}
                                onClick={() => isAvailable && voiceId && handleVoiceSelect(voiceId)}
                              >
                                <div className={cn(
                                  "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all",
                                  isSelected ? "border-secondary bg-secondary/30" : "border-foreground/20",
                                )}>
                                  {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-secondary" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <span className={cn(
                                    "text-[13px] font-medium",
                                    isSelected ? "text-foreground/90" : "text-foreground/60",
                                  )}>
                                    {v.label}
                                  </span>
                                  <span className={cn(
                                    "text-[11px] ml-1.5",
                                    isSelected ? "text-secondary/70" : "text-muted-foreground/50",
                                  )}>
                                    — {v.desc}
                                  </span>
                                  {!isAvailable && (
                                    <span className="text-[10px] ml-2 text-muted-foreground/30 italic">
                                      unavailable
                                    </span>
                                  )}
                                </div>
                                {isAvailable && voiceId && (
                                  <button
                                    className={cn(
                                      "w-6 h-6 rounded-full border flex items-center justify-center shrink-0 transition-all",
                                      isPreviewing
                                        ? "border-secondary/60 bg-secondary/15 text-secondary"
                                        : "border-foreground/15 text-muted-foreground/50 hover:border-secondary/30 hover:text-secondary/70",
                                    )}
                                    onClick={(e) => { e.stopPropagation(); handleVoicePreview(voiceId); }}
                                    title="Preview voice"
                                  >
                                    {isPreviewing
                                      ? <Pause className="w-2.5 h-2.5" />
                                      : <Play className="w-2.5 h-2.5 ml-px" />
                                    }
                                  </button>
                                )}
                              </div>
                            );
                          })
                        )
                      ) : (
                        /* ── Standard premade voices ── */
                        section.voices.map((v) => {
                          const isSelected = activeVoiceId === v.id;
                          const isPreviewing = previewingVoiceId === v.id;
                          return (
                            <div
                              key={v.id}
                              className={cn(
                                "flex items-center gap-3 px-3 py-2 rounded-xl border cursor-pointer transition-all",
                                isSelected
                                  ? "bg-primary/10 border-primary/40"
                                  : "bg-background/50 border-primary/12 hover:border-primary/25 hover:bg-primary/5",
                              )}
                              onClick={() => handleVoiceSelect(v.id)}
                            >
                              <div className={cn(
                                "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all",
                                isSelected ? "border-primary bg-primary/30" : "border-foreground/20",
                              )}>
                                {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-primary" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <span className={cn(
                                  "text-[13px] font-medium",
                                  isSelected ? "text-foreground/90" : "text-foreground/60",
                                )}>
                                  {v.label}
                                </span>
                                <span className="text-[10px] ml-1.5 text-muted-foreground/35">
                                  {v.accent}
                                </span>
                                <span className={cn(
                                  "text-[11px] ml-1",
                                  isSelected ? "text-secondary/60" : "text-muted-foreground/45",
                                )}>
                                  · {v.feel}
                                </span>
                              </div>
                              <button
                                className={cn(
                                  "w-6 h-6 rounded-full border flex items-center justify-center shrink-0 transition-all",
                                  isPreviewing
                                    ? "border-primary/60 bg-primary/15 text-primary"
                                    : "border-foreground/15 text-muted-foreground/50 hover:border-primary/30 hover:text-primary/70 hover:bg-primary/8",
                                )}
                                onClick={(e) => { e.stopPropagation(); handleVoicePreview(v.id); }}
                                title="Preview voice"
                              >
                                {isPreviewing
                                  ? <Pause className="w-2.5 h-2.5" />
                                  : <Play className="w-2.5 h-2.5 ml-px" />
                                }
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/40 mt-2.5 text-center">
                Press ▶ to hear a sample · any voice, any gender
              </p>
            </div>

            {/* ── Export + Delete account ─────────────────────────────── */}
            <div className="pt-2 border-t border-destructive/10 space-y-3">
              {/* Download my data */}
              <div>
                <button
                  onClick={handleExport}
                  disabled={isExporting}
                  className="flex items-center gap-2 text-[11px] text-muted-foreground/50 hover:text-primary/70 tracking-wider uppercase transition-colors disabled:opacity-40"
                >
                  {isExporting ? (
                    <motion.div
                      className="w-3 h-3 border border-muted-foreground/40 border-t-transparent rounded-full"
                      animate={{ rotate: 360 }}
                      transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                    />
                  ) : (
                    <Download className="w-3 h-3" />
                  )}
                  {isExporting ? "Preparing download…" : "Download my data"}
                </button>
                {exportError && (
                  <p className="text-[11px] text-destructive/70 mt-1">{exportError}</p>
                )}
              </div>

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
      <div className="px-4 sm:px-6 pb-5 pt-3 bg-background shrink-0 relative z-10">
        <div className="h-px bg-primary/15 mb-4" />

        {showTextInput && (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSend)}
              className="flex items-center gap-2 max-w-3xl mx-auto bg-card border border-primary/20 rounded-full pl-5 pr-2 py-1.5 shadow-sm"
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
                          continuousVoice ? "Listening..." : "Tell me what's on your mind..."
                        }
                        className="border-0 bg-transparent shadow-none focus-visible:ring-0 px-0 placeholder:text-muted-foreground/40 text-[14.5px] h-auto py-1.5 text-foreground/85"
                        disabled={isTyping || continuousVoice || isStreaming}
                        autoComplete="off"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "rounded-full w-9 h-9 transition-colors shrink-0",
                    voice.isListening
                      ? "text-primary bg-primary/15"
                      : "text-muted-foreground hover:text-primary hover:bg-primary/10",
                  )}
                  onClick={() => {
                    if (voice.isListening) voice.stopListening();
                    else voice.startListening();
                  }}
                  disabled={isTyping || continuousVoice || isStreaming}
                >
                  <Mic className="w-[17px] h-[17px]" strokeWidth={2} />
                </Button>
                <Button
                  type="submit"
                  size="icon"
                  className="rounded-full w-9 h-9 bg-primary/15 text-primary hover:bg-primary/25 transition-all border border-primary/25 shrink-0"
                  disabled={
                    isTyping ||
                    continuousVoice ||
                    isStreaming ||
                    !form.watch("content")
                  }
                >
                  <Send className="w-[16px] h-[16px] ml-0.5" strokeWidth={2} />
                </Button>
              </div>
            </form>
          </Form>
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
      </div>
    </div>
  );
}
