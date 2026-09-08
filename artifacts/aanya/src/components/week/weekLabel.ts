/**
 * Weekly review — marker labels and the story's date range, computed on the
 * client because "this week" is relative to the person's own clock.
 *
 * Labels recede with time, as in the prototype (This week · Last week ·
 * August · 14 Aug): the current and previous weeks are named as such; older
 * markers show the month name the first time a month appears in the row and
 * the start date ("14 Aug") for further weeks in that same month.
 */

import { format, isSameDay, isSameMonth, parseISO, startOfWeek, subWeeks } from "date-fns";

export interface WeekSpan {
  /** ISO date of the week's Monday. */
  weekStart: string;
  /** ISO date of the week's Sunday. */
  weekEnd: string;
}

/** One label per span, in the order given (newest first). */
export function weekLabels(spans: WeekSpan[], now: Date): string[] {
  const thisMonday = startOfWeek(now, { weekStartsOn: 1 });
  const lastMonday = subWeeks(thisMonday, 1);
  const monthsShown = new Set<string>();
  return spans.map((s) => {
    const start = parseISO(s.weekStart);
    if (isSameDay(start, thisMonday) || start > thisMonday) return "This week";
    if (isSameDay(start, lastMonday)) return "Last week";
    const key = format(start, "yyyy-MM");
    if (!monthsShown.has(key)) {
      monthsShown.add(key);
      return format(start, "MMMM");
    }
    return format(start, "d MMM");
  });
}

/** "2–8 September" within one month; "31 August – 6 September" across two. */
export function formatWeekRange(span: WeekSpan): string {
  const a = parseISO(span.weekStart);
  const b = parseISO(span.weekEnd);
  if (isSameMonth(a, b)) return `${format(a, "d")}–${format(b, "d MMMM")}`;
  return `${format(a, "d MMMM")} – ${format(b, "d MMMM")}`;
}
