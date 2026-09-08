/**
 * Weekly review — the row of circular markers at the top of Journey.
 *
 * Each marker is a 78px disc holding a verbatim fragment of something the
 * person said that week — never an icon, never a mood colour. Unviewed: a
 * dawn-to-green conic ring. Viewed: a plain hairline and dimmed text. Viewing
 * clears the ring permanently: the viewed flag is persisted the moment a
 * story opens, and the marker re-renders as seen when it closes (the story
 * covers the page in between, exactly the prototype's effect).
 *
 * Renders nothing at all when there are no stories — the spec's "no marker
 * appears that week" — never a placeholder.
 *
 * Styled on the APP palette (index.css .week-marker*), not the story's: the
 * discs sit on the Journey page and their mask must match its background.
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { WeekStory } from "./WeekStory";
import type { WeekCard, WeekStory as WeekStoryData } from "./types";
import { formatWeekRange, weekLabels } from "./weekLabel";

interface ApiReview {
  id: number;
  weekStart: string;
  weekEnd: string;
  fragment: string;
  viewed: boolean;
  cards: WeekCard[];
}

const QUERY_KEY = ["weekly-reviews"] as const;

export function WeekMarkers() {
  const queryClient = useQueryClient();
  const { data } = useQuery<{ reviews: ApiReview[] }>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/weekly-reviews`);
      if (!r.ok) throw new Error("weekly reviews unavailable");
      return (await r.json()) as { reviews: ApiReview[] };
    },
    staleTime: 60_000,
    retry: false,
  });

  const reviews = data?.reviews ?? [];
  const labels = useMemo(() => weekLabels(reviews, new Date()), [reviews]);
  const [openId, setOpenId] = useState<number | null>(null);
  const close = useCallback(() => setOpenId(null), []);

  if (reviews.length === 0) return null;

  const open = (review: ApiReview) => {
    setOpenId(review.id);
    if (review.viewed) return;
    // Persist first, then flip the cache: the ring is gone when the story
    // closes, and it never comes back. Fire-and-forget — a failed save must
    // never keep someone from reading their week.
    void apiFetch(`${import.meta.env.BASE_URL}api/weekly-reviews/${review.id}/viewed`, { method: "POST" })
      .then((r) => {
        if (!r.ok) return;
        queryClient.setQueryData<{ reviews: ApiReview[] }>(QUERY_KEY, (old) =>
          old ? { reviews: old.reviews.map((x) => (x.id === review.id ? { ...x, viewed: true } : x)) } : old,
        );
      })
      .catch(() => {});
  };

  const openReview = openId == null ? null : reviews.find((r) => r.id === openId) ?? null;
  const story: WeekStoryData | null = openReview
    ? {
        id: String(openReview.id),
        label: labels[reviews.indexOf(openReview)] ?? "",
        fragment: openReview.fragment,
        range: formatWeekRange(openReview),
        cards: openReview.cards,
      }
    : null;

  return (
    <>
      {/* -mx-6 / px-6: bleed to the page edges so older markers scroll under
          the padding, as the prototype's row does; the first disc still
          aligns with the page's 24px inset. */}
      <div className="week-markers -mx-6 px-6 pb-7" role="group" aria-label="Your weeks">
        {reviews.map((r, i) => (
          <button
            key={r.id}
            type="button"
            onClick={() => open(r)}
            aria-label={`${labels[i]}: ${r.fragment}${r.viewed ? "" : " (new)"}`}
            className={cn("week-marker", !r.viewed && "is-new")}
          >
            <div className={cn("week-disc", r.viewed ? "is-seen" : "is-new")}>
              <em>{r.fragment}</em>
            </div>
            <span>{labels[i]}</span>
          </button>
        ))}
      </div>
      <div className="week-rule" aria-hidden="true" />

      {story && <WeekStory story={story} onClose={close} />}
    </>
  );
}
