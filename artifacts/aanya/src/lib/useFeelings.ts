/**
 * Feelings-in-context — the second memory layer beside facts. One shared
 * query so the Memory page and its "How things have felt" screen read the
 * same cache. Read-only: there is no API to star or forget a feeling.
 */

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface FeelingRow {
  id: number;
  feeling: string;
  category: string;
}

export const FEELINGS_QUERY_KEY = ["memory-feelings"] as const;

export function useFeelings() {
  return useQuery<FeelingRow[]>({
    queryKey: FEELINGS_QUERY_KEY,
    queryFn: async () => {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/memory/feelings`);
      if (!r.ok) throw new Error("feelings unavailable");
      const data = (await r.json()) as unknown;
      return Array.isArray(data) ? (data as FeelingRow[]) : [];
    },
    staleTime: 60_000,
    retry: false,
  });
}
