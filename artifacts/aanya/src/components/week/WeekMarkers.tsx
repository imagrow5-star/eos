/**
 * The row of circular story markers at the top of Journey.
 *
 * Six kinds, left to right: Goals · Routines · this week · earlier weeks ·
 * a month · the first week. This build carries Goals, Routines and the
 * weekly stories; month and first-week join in step 2, the row rules
 * (how many show, what drops off) in step 4.
 *
 * Goals and Routines are always present. Their circle holds the name of the
 * goal or routine that last spoke (or just "Goals" / "Routines" before
 * anything has), and their ring shows only while there is an unviewed
 * card. Tapping opens that card as a story; with nothing to say, it opens
 * the Goals or Routines row below instead.
 *
 * Weekly markers hold a verbatim fragment of something the person said that
 * week — never an icon, never a mood colour. Unviewed: a dawn-to-green conic
 * ring. Viewed: a plain hairline and dimmed text. Viewing clears the ring
 * permanently: the viewed flag is persisted the moment a story opens, and
 * the marker re-renders as seen when it closes.
 *
 * Styled on the APP palette (index.css .week-marker*), not the story's: the
 * discs sit on the Journey page and their mask must match its background.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { WeekStory } from "./WeekStory";
import type { StoryKind, WeekCard, WeekStory as WeekStoryData } from "./types";
import { formatWeekRange, weekLabels } from "./weekLabel";

export interface ApiStory {
  id: number;
  kind: StoryKind;
  periodStart: string;
  periodEnd: string;
  subjectId: number | null;
  fragment: string;
  viewed: boolean;
  cards: WeekCard[];
}

export const STORIES_QUERY_KEY = ["stories"] as const;

export type SubjectSection = "goals" | "routines";

interface Marker {
  key: string;
  label: string;
  fragment: string;
  isNew: boolean;
  story: ApiStory | null;
  /** Where a tap lands when there is no story to open. */
  section: SubjectSection | null;
}

export function WeekMarkers({ onOpenSection }: { onOpenSection?: (section: SubjectSection) => void }) {
  const queryClient = useQueryClient();
  const { data } = useQuery<{ stories: ApiStory[] }>({
    queryKey: STORIES_QUERY_KEY,
    queryFn: async () => {
      const r = await apiFetch(`${import.meta.env.BASE_URL}api/stories`);
      if (!r.ok) throw new Error("stories unavailable");
      return (await r.json()) as { stories: ApiStory[] };
    },
    staleTime: 60_000,
    retry: false,
  });

  // First load of the session: ask the server for today's Goals / Routines
  // (and a due weekly) story. Idempotent and throttled server-side; the row
  // refetches only when something was actually written, so the ring appears
  // the moment there is something new — not an hour later when the
  // scheduled job gets round to it.
  const refreshed = useRef(false);
  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    void apiFetch(`${import.meta.env.BASE_URL}api/stories/refresh`, { method: "POST" })
      .then(async (r) => {
        if (!r.ok) return;
        const body = (await r.json()) as { throttled?: boolean; week?: { generated?: number }; subjects?: { goalsGenerated?: number; routinesGenerated?: number } };
        const wrote = (body.week?.generated ?? 0) + (body.subjects?.goalsGenerated ?? 0) + (body.subjects?.routinesGenerated ?? 0);
        if (wrote > 0) void queryClient.invalidateQueries({ queryKey: STORIES_QUERY_KEY });
      })
      .catch(() => {});
  }, [queryClient]);

  const stories = data?.stories ?? [];
  const markers = useMemo<Marker[]>(() => {
    const goals = stories.find((s) => s.kind === "goals") ?? null;
    const routines = stories.find((s) => s.kind === "routines") ?? null;
    const weeks = stories.filter((s) => s.kind === "week");
    const labels = weekLabels(weeks.map((w) => ({ weekStart: w.periodStart, weekEnd: w.periodEnd })), new Date());
    return [
      { key: "goals", label: "Goals", fragment: goals?.fragment ?? "Goals", isNew: goals != null && !goals.viewed, story: goals, section: "goals" },
      { key: "routines", label: "Routines", fragment: routines?.fragment ?? "Routines", isNew: routines != null && !routines.viewed, story: routines, section: "routines" },
      ...weeks.map((w, i) => ({ key: `week-${w.id}`, label: labels[i] ?? "", fragment: w.fragment, isNew: !w.viewed, story: w, section: null })),
    ];
  }, [stories]);

  const [openId, setOpenId] = useState<number | null>(null);
  const close = useCallback(() => setOpenId(null), []);

  const open = (m: Marker) => {
    if (!m.story) {
      if (m.section) onOpenSection?.(m.section);
      return;
    }
    const story = m.story;
    setOpenId(story.id);
    if (story.viewed) return;
    // Persist first, then flip the cache: the ring is gone when the story
    // closes, and it never comes back. Fire-and-forget — a failed save must
    // never keep someone from reading their story.
    void apiFetch(`${import.meta.env.BASE_URL}api/stories/${story.id}/viewed`, { method: "POST" })
      .then((r) => {
        if (!r.ok) return;
        queryClient.setQueryData<{ stories: ApiStory[] }>(STORIES_QUERY_KEY, (old) =>
          old ? { stories: old.stories.map((x) => (x.id === story.id ? { ...x, viewed: true } : x)) } : old,
        );
      })
      .catch(() => {});
  };

  const openStory = openId == null ? null : stories.find((s) => s.id === openId) ?? null;
  const openMarker = openStory ? markers.find((m) => m.story?.id === openStory.id) ?? null : null;
  const story: WeekStoryData | null = openStory
    ? {
        id: String(openStory.id),
        kind: openStory.kind,
        label: openMarker?.label ?? "",
        fragment: openStory.fragment,
        range: openStory.kind === "week" ? formatWeekRange({ weekStart: openStory.periodStart, weekEnd: openStory.periodEnd }) : openMarker?.label ?? "",
        cards: openStory.cards,
      }
    : null;

  return (
    <>
      <div className="week-markers -mx-6 px-6 pb-7" role="group" aria-label="Your stories">
        {markers.map((m) => (
          <button
            key={m.key}
            type="button"
            className={cn("week-marker", m.isNew && "is-new")}
            onClick={() => open(m)}
            aria-label={`${m.label}: ${m.fragment}${m.isNew ? " (new)" : ""}`}
          >
            <span className={cn("week-disc", m.isNew ? "is-new" : "is-seen")}>
              <em>{m.fragment}</em>
            </span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>
      <div className="week-rule" />
      {story && <WeekStory story={story} onClose={close} />}
    </>
  );
}
