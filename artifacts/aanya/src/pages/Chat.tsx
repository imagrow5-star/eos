import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Send, Mic, Phone, PhoneOff, Settings, X, Check, Play, Pause } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";

import {
  useGetOnboardingStatus,
  useSubmitOnboardingAnswer,
  useGetMessages,
  useSendMessage,
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
import { useSpeechRecognition, speakText } from "@/lib/voice";
import { cn } from "@/lib/utils";

// ─── Voice options ────────────────────────────────────────────────────────────

const FEMALE_VOICES = [
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah",   desc: "soft & warm (younger)" },
  { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda", desc: "bright & friendly (younger)" },
  { id: "pFZP5JQG7iQjIQuC4Bku", label: "Lily",    desc: "gentle, British" },
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel",  desc: "calm & grounded (mature)" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", label: "Alice",   desc: "confident, British (mature)" },
] as const;

const MALE_VOICES = [
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni",  desc: "warm & easy (younger)" },
  { id: "IKne3meq5aSn9XLyUdCD", label: "Charlie", desc: "casual, Australian (younger)" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam",    desc: "deep & warm (mature)" },
  { id: "JBFqnCBsd6RMkjVDRZzb", label: "George",  desc: "warm, British (mature)" },
  { id: "VR6AewLTigWG4xSOukaG", label: "Arnold",  desc: "crisp & steady (mature)" },
] as const;

const PREVIEW_SAMPLE = "Hi, I'm here with you. Take your time.";
const DEFAULT_FEMALE_VOICE = "EXAVITQu4vr4xnSDxMaL";
const DEFAULT_MALE_VOICE   = "pNInz6obpgDQGcFmaJgB";

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
  const sendMessage = useSendMessage();
  const updateProfile = useUpdateProfile();

  const [isTyping, setIsTyping] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [continuousVoice, setContinuousVoice] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const morningNoteTriggered = useRef(false);

  const isBereavement = profile?.userPath === "bereavement";
  const companionGender = (profile as any)?.companionGender ?? "woman";
  const activeVoiceId = (profile as any)?.voiceId ?? (companionGender === "man" ? DEFAULT_MALE_VOICE : DEFAULT_FEMALE_VOICE);
  const voiceSections = companionGender === "man"
    ? [{ label: "Male voices", voices: MALE_VOICES }, { label: "Female voices", voices: FEMALE_VOICES }]
    : [{ label: "Female voices", voices: FEMALE_VOICES }, { label: "Male voices", voices: MALE_VOICES }];

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

  // Scroll to bottom on new content
  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, onboarding?.currentStep, isTyping]);

  // ─── Shared speak helper ──────────────────────────────────────────────────

  const handleSpeak = (text: string) => {
    speakText(text, {
      voiceId: activeVoiceId,
      onStart: () => setIsSpeaking(true),
      onEnd: () => {
        setIsSpeaking(false);
        if (continuousVoice) voice.startListening();
      },
    });
  };

  // ─── Send handler (onboarding + chat) ────────────────────────────────────

  const handleSend = async (data: ChatMessageFormValues) => {
    if (!data.content.trim()) return;
    const content = data.content.trim();
    form.reset();

    if (!onboarding?.isComplete) {
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
      setIsTyping(true);
      sendMessage.mutate(
        { data: { content } },
        {
          onSuccess: (reply) => {
            queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
            setIsTyping(false);
            handleSpeak(reply.assistantMessage.content);
          },
          onError: () => setIsTyping(false),
        },
      );
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
    if (previewingVoiceId === voiceId) return; // already playing
    setPreviewingVoiceId(voiceId);
    speakText(PREVIEW_SAMPLE, {
      voiceId,
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
                  <span className="text-[10px] text-muted-foreground/60 tracking-widest uppercase mb-1.5 ml-1">
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
                  <p className={cn(
                    isCompanion
                      ? cn("companion-message text-foreground/90", isBereavement ? "text-[17px]" : "text-[16px]")
                      : "font-sans text-[14.5px] text-foreground/70",
                  )}>
                    {msg.content}
                  </p>
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
              <div className="max-h-64 overflow-y-auto space-y-4 pr-0.5">
                {voiceSections.map((section) => (
                  <div key={section.label}>
                    <p className="text-[9.5px] text-muted-foreground/40 tracking-[0.15em] uppercase mb-1.5 sticky top-0 bg-card/95 py-0.5">
                      {section.label}
                    </p>
                    <div className="space-y-1.5">
                      {section.voices.map((v) => {
                        const isSelected = activeVoiceId === v.id;
                        const isPreviewing = previewingVoiceId === v.id;
                        return (
                          <div
                            key={v.id}
                            className={cn(
                              "flex items-center gap-3 px-3 py-2 rounded-xl border cursor-pointer transition-all",
                              isSelected
                                ? "bg-primary/10 border-primary/40 text-foreground"
                                : "bg-background/50 border-primary/12 text-muted-foreground hover:border-primary/25 hover:bg-primary/5",
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
                              <span className={cn(
                                "text-[11px] ml-1.5",
                                isSelected ? "text-secondary/60" : "text-muted-foreground/50",
                              )}>
                                — {v.desc}
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
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/40 mt-2.5 text-center">
                Press ▶ to hear a sample · any voice, any gender
              </p>
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
                        disabled={isTyping || continuousVoice}
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
                  disabled={isTyping || continuousVoice}
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
            or type your answer above
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
