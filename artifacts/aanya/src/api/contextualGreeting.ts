/**
 * Manual hook for the contextual greeting endpoint.
 * The server decides whether to generate a greeting based on time-of-day slot,
 * recent absence, and last greeting timestamp — so the response may be null.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getGetMessagesQueryKey } from "@workspace/api-client-react";

interface GreetingMessage {
  id: string;
  role: string;
  content: string;
  isMorningNote: boolean;
  createdAt: string;
}

interface GreetingResponse {
  message: GreetingMessage | null;
}

export function useContextualGreeting() {
  const queryClient = useQueryClient();

  return useMutation<GreetingResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/chat/contextual-greeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Greeting failed: ${res.status}`);
      return res.json() as Promise<GreetingResponse>;
    },
    onSuccess: (data) => {
      // Only invalidate message cache if a greeting was actually generated
      if (data.message !== null) {
        queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
      }
    },
  });
}
