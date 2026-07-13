import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Send, Mic, Phone, PhoneOff } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";

import {
  useGetOnboardingStatus,
  useSubmitOnboardingAnswer,
  useGetMessages,
  useSendMessage,
  useGenerateMorningNote,
  useGetProfile,
  getGetOnboardingStatusQueryKey,
  getGetMessagesQueryKey,
} from "@workspace/api-client-react";

import { chatMessageSchema, type ChatMessageFormValues } from "@/lib/schemas";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSpeechRecognition, speakText } from "@/lib/voice";
import { cn } from "@/lib/utils";

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

  const [isTyping, setIsTyping] = useState(false);
  const [continuousVoice, setContinuousVoice] = useState(false);
  const morningNoteTriggered = useRef(false);

  const isBereavement = profile?.userPath === "bereavement";

  const form = useForm<ChatMessageFormValues>({
    resolver: zodResolver(chatMessageSchema),
    defaultValues: { content: "" },
  });

  const generateMorningNoteMutate = generateMorningNote.mutate;

  // Morning Note — only run once per session when onboarding completes
  useEffect(() => {
    if (onboarding?.isComplete && !morningNoteTriggered.current) {
      morningNoteTriggered.current = true;
      generateMorningNoteMutate(undefined, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding?.isComplete]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, onboarding?.currentStep, isTyping]);

  // ─── Send handler (works for onboarding and chat) ──────────────────────────

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
            if (newStatus.isComplete && newStatus.companionFirstMessage && continuousVoice) {
              speakText(newStatus.companionFirstMessage, () => {
                if (continuousVoice) voice.startListening();
              });
            }
          },
          onError: () => setIsTyping(false),
        }
      );
    } else {
      setIsTyping(true);
      sendMessage.mutate(
        { data: { content } },
        {
          onSuccess: (reply) => {
            queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
            setIsTyping(false);
            if (continuousVoice) {
              speakText(reply.assistantMessage.content, () => {
                if (continuousVoice) voice.startListening();
              });
            }
          },
          onError: () => setIsTyping(false),
        }
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

  const companionName = profile?.companionName || "Asha";
  const companionInitials = companionName.substring(0, 2).toUpperCase();

  // ─── Chat content renderer ─────────────────────────────────────────────────

  const chatContent = () => {
    if (!onboarding?.isComplete) {
      return (
        <div className="flex flex-col gap-4">
          <motion.div
            key={onboarding?.currentStep}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="flex items-end gap-2 max-w-[85%]"
          >
            <div className="bg-card border border-primary/15 px-5 py-3.5 rounded-2xl rounded-bl-sm shadow-sm">
              <p className={cn(
                "companion-message leading-relaxed text-foreground/88",
                isBereavement ? "text-[17px]" : "text-[16px]"
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
            const showAvatar =
              isCompanion && (idx === 0 || messages[idx - 1].role !== "assistant");

            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
                className={cn(
                  "flex flex-col w-full max-w-[85%]",
                  isCompanion ? "self-start" : "self-end items-end"
                )}
              >
                {showAvatar && (
                  <span className="text-[10px] text-muted-foreground/60 tracking-widest uppercase mb-1.5 ml-1">
                    {companionName}
                  </span>
                )}
                <div
                  className={cn(
                    "px-[18px] py-3 leading-relaxed shadow-sm relative",
                    isCompanion
                      ? "bg-card border border-primary/15 rounded-2xl rounded-tl-sm"
                      : "bg-muted/60 border border-white/5 rounded-2xl rounded-tr-sm"
                  )}
                >
                  <p className={cn(
                    isCompanion
                      ? cn("companion-message text-foreground/90", isBereavement ? "text-[17px]" : "text-[16px]")
                      : "font-sans text-[14.5px] text-foreground/70"
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

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={cn(
      "flex flex-col h-full w-full relative bg-background",
      isBereavement && "gentle-mode"
    )}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="h-16 flex items-center justify-between px-5 border-b border-primary/20 bg-background/98 backdrop-blur-xl z-20 shrink-0 relative">
        {/* Companion presence — left */}
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <div className="w-8 h-8 rounded-full bg-card border border-primary/25 flex items-center justify-center">
              <span className="font-serif text-[11px] text-secondary/80 tracking-wider">
                {companionInitials}
              </span>
            </div>
            <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-primary/70 rounded-full border border-background animate-pulse-slow" />
          </div>
          <span className="text-[10px] text-muted-foreground/80 tracking-widest uppercase font-medium">
            {companionName}
          </span>
        </div>

        {/* ASHA wordmark — centered */}
        <div className="absolute left-1/2 -translate-x-1/2 select-none pointer-events-none">
          <span className="font-serif text-[13px] font-medium tracking-[0.48em] text-foreground/70">
            A S H{" "}
          </span>
          <span className="font-serif text-[13px] font-medium text-primary">
            A
          </span>
        </div>

        {/* Voice toggle — right */}
        {onboarding?.isComplete && (
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleContinuousVoice}
            className={cn(
              "rounded-full w-9 h-9 transition-all duration-500",
              continuousVoice
                ? "bg-primary/15 text-primary voice-active"
                : "text-muted-foreground hover:text-primary hover:bg-primary/10"
            )}
          >
            {continuousVoice
              ? <Phone className="w-4 h-4" />
              : <PhoneOff className="w-4 h-4" />}
          </Button>
        )}
      </header>

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

      {/* ── Input area ─────────────────────────────────────────────────────── */}
      <div className="px-4 sm:px-6 pb-5 pt-3 bg-background shrink-0 relative z-20">
        {/* Gold hairline above input */}
        <div className="h-px bg-primary/15 mb-4" />
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
                        continuousVoice
                          ? "Listening..."
                          : "Tell me what's on your mind..."
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
                    ? "text-primary bg-primary/15 voice-active"
                    : "text-muted-foreground hover:text-primary hover:bg-primary/10"
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
                  (!form.watch("content") && !voice.isListening)
                }
              >
                <Send className="w-[16px] h-[16px] ml-0.5" strokeWidth={2} />
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
