import { z } from "zod";

export const chatMessageSchema = z.object({
  content: z.string().min(1, "Message cannot be empty"),
});

export type ChatMessageFormValues = z.infer<typeof chatMessageSchema>;

export const habitSchema = z.object({
  name: z.string().min(1, "Habit name is required"),
  whenThen: z.string().min(1, "When-then anchor is required"),
  reason: z.string().min(1, "Reason is required"),
});

export type HabitFormValues = z.infer<typeof habitSchema>;

export const winSchema = z.object({
  content: z.string().min(1, "Win description is required"),
});

export type WinFormValues = z.infer<typeof winSchema>;
