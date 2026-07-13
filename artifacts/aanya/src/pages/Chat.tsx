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
  getGetMessagesQueryKey
} from "@workspace/api-client-react";

import { chatMessageSchema, type ChatMessageFormValues } from "@/lib/schemas";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSpeechRecognition, speakText } from "@/lib/voice";
import { cn } from "@/lib/utils";

function TypingIndicator() {
  return (
    <div className="flex space-x-1.5 items-center bg-card/50 w-fit px-4 py-3 rounded-2xl rounded-tl-sm border border-card-border/50 shadow-sm backdrop-blur-sm">
      <motion.div
        className="w-1.5 h-1.5 bg-primary/60 rounded-full"
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 0.6, repeat: Infinity, delay: 0 }}
      />
      <motion.div
        className="w-1.5 h-1.5 bg-primary/60 rounded-full"
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 0.6, repeat: Infinity, delay: 0.2 }}
      />
      <motion.div
        className="w-1.5 h-1.5 bg-primary/60 rounded-full"
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 0.6, repeat: Infinity, delay: 0.4 }}
      />
    </div>
  );
}

export default function Chat() {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const { data: onboarding } = useGetOnboardingStatus();
  const { data: profile } = useGetProfile();
  const { data: messages = [] } = useGetMessages({ 
    query: { enabled: !!onboarding?.isComplete } 
  });

  const generateMorningNote = useGenerateMorningNote();
  const submitAnswer = useSubmitOnboardingAnswer();
  const sendMessage = useSendMessage();

  const [isTyping, setIsTyping] = useState(false);
  const [continuousVoice, setContinuousVoice] = useState(false);
  const morningNoteTriggered = useRef(false);

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
    // generateMorningNoteMutate is stable from react-query; morningNoteTriggered is a ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding?.isComplete]);

  // Scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, onboarding?.currentStep, isTyping]);

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
          onError: () => setIsTyping(false)
        }
      );
    } else {
      setIsTyping(true);
      // Optimistic user message can be added if needed, but we rely on invalidation for now
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
          onError: () => setIsTyping(false)
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

  const companionName = profile?.companionName || "Aanya";
  const companionInitials = companionName.substring(0, 2).toUpperCase();

  const chatContent = () => {
    if (!onboarding?.isComplete) {
      return (
        <div className="flex flex-col gap-4">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-end gap-2 max-w-[85%]"
          >
            <div className="bg-secondary/20 text-foreground border border-secondary/30 px-4 py-3 rounded-2xl rounded-bl-sm shadow-sm backdrop-blur-sm">
              <p className="text-sm font-serif leading-relaxed text-secondary-foreground/90">
                {onboarding?.currentStep === "name" && "Hi. It's late. You don't have to be strong here. What should I call you?"}
                {onboarding?.currentStep === "relationshipType" && "And who am I to you? A friend to sit with, or someone closer?"}
                {onboarding?.currentStep === "energy" && "Do you need me to be playful to distract you, calm to ground you, or deep so we can just talk about it?"}
                {onboarding?.currentStep === "companionName" && "I'll be whatever you need. Do you have a name for me?"}
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
            const showAvatar = isCompanion && (idx === 0 || messages[idx - 1].role !== "assistant");
            
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "flex flex-col w-full max-w-[85%]",
                  isCompanion ? "self-start" : "self-end items-end"
                )}
              >
                <div 
                  className={cn(
                    "px-[18px] py-3 text-[15px] leading-relaxed shadow-sm relative group",
                    isCompanion 
                      ? "bg-secondary/15 text-foreground border border-secondary/20 rounded-2xl rounded-tl-[4px]" 
                      : "bg-muted text-muted-foreground border border-white/5 rounded-2xl rounded-tr-[4px]"
                  )}
                >
                  <p className={cn(isCompanion ? "font-serif text-[15.5px]" : "font-sans text-[14.5px]")}>
                    {msg.content}
                  </p>
                  {msg.isMorningNote && (
                    <span className="absolute -top-3 left-4 text-[10px] text-primary/70 tracking-widest uppercase bg-background px-2 font-medium">Morning Note</span>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full w-full relative bg-gradient-to-b from-background via-background to-card/30">
      {/* Header */}
      <header className="h-[72px] flex items-center justify-between px-6 border-b border-white/5 bg-background/80 backdrop-blur-xl z-20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-secondary/20 border border-secondary/30 flex items-center justify-center shadow-[0_0_20px_rgba(225,29,72,0.15)] relative overflow-hidden">
             <div className="absolute inset-0 bg-gradient-to-tr from-secondary/20 to-transparent" />
             <span className="font-serif text-sm font-medium text-secondary-foreground relative z-10 tracking-wider">
               {companionInitials}
             </span>
          </div>
          <div className="flex flex-col">
            <h1 className="font-serif text-lg text-foreground leading-tight tracking-wide">
              {companionName}
            </h1>
            <span className="text-[11px] text-primary/70 tracking-wider uppercase flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-primary animate-pulse-slow shadow-[0_0_8px_var(--color-primary)]" />
              Here for you
            </span>
          </div>
        </div>
        {onboarding?.isComplete && (
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleContinuousVoice}
            className={cn(
              "rounded-full transition-all duration-500",
              continuousVoice 
                ? "bg-secondary/20 text-secondary hover:bg-secondary/30 shadow-[0_0_15px_rgba(225,29,72,0.3)]" 
                : "text-muted-foreground hover:text-primary"
            )}
          >
            {continuousVoice ? <Phone className="w-4 h-4 animate-pulse-slow" /> : <PhoneOff className="w-4 h-4" />}
          </Button>
        )}
      </header>

      {/* Messages */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 scroll-smooth"
      >
        <div className="flex flex-col justify-end min-h-full pb-4">
          {chatContent()}
          
          <AnimatePresence>
            {isTyping && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
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

      {/* Input Area */}
      <div className="p-4 sm:p-6 bg-gradient-to-t from-background via-background/95 to-transparent pt-8 shrink-0 relative z-20">
        <Form {...form}>
          <form 
            onSubmit={form.handleSubmit(handleSend)} 
            className="flex items-center gap-2 max-w-3xl mx-auto bg-card border border-white/5 rounded-full pl-5 pr-2 py-2 shadow-lg backdrop-blur-xl"
          >
            <FormField
              control={form.control}
              name="content"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormControl>
                    <Input 
                      {...field} 
                      placeholder={continuousVoice ? "Listening..." : "Tell me what's on your mind..."} 
                      className="border-0 bg-transparent shadow-none focus-visible:ring-0 px-0 placeholder:text-muted-foreground/50 text-[15px] h-auto py-1"
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
                  "rounded-full w-10 h-10 transition-colors",
                  voice.isListening 
                    ? "text-primary bg-primary/20 voice-active" 
                    : "text-muted-foreground hover:text-primary hover:bg-white/5"
                )}
                onClick={() => {
                  if (voice.isListening) voice.stopListening();
                  else voice.startListening();
                }}
                disabled={isTyping || continuousVoice}
              >
                <Mic className="w-[18px] h-[18px]" strokeWidth={2.5} />
              </Button>
              <Button 
                type="submit" 
                size="icon" 
                className="rounded-full w-10 h-10 bg-primary/20 text-primary hover:bg-primary/30 hover:text-primary shadow-[0_0_10px_rgba(157,113,232,0.2)] transition-all"
                disabled={isTyping || continuousVoice || (!form.watch("content") && !voice.isListening)}
              >
                <Send className="w-[18px] h-[18px] ml-0.5" strokeWidth={2.5} />
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
