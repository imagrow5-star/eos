/**
 * Weekly review — stage 3, the pure composer.
 *
 * Takes what already exists for one user's week (their verbatim messages,
 * their wins, this week's chapter quote pairs, their open commitments, a
 * pending sealed note) and shapes the 3–6 cards of the story plus the
 * marker fragment. No database, no model: everything here is deterministic
 * and unit-tested. The one model-assisted piece (the "moment" card and a
 * proposed fragment) arrives as a `ModelProposal` and is VALIDATED here —
 * the model may propose, never decide.
 *
 * Hard rules, enforced structurally in this file:
 *  - no prosody or voice-emotion data: none is read, none is passed in;
 *  - no inferred emotional states: the moment card is rejected if it names a
 *    feeling, praises, or interprets (BANNED_MOMENT_WORDS);
 *  - no mood aggregates, no streaks, no scores: no card carries a number
 *    except "N times this month" — a count of their own word;
 *  - quotes are verbatim: the fragment must be a substring of a stored
 *    message; then/now pairs come from the chapter engine's verbatim gate;
 *  - minimum three real cards or no story — never padded;
 *  - the grief/crisis guardrail suppresses "did" and "forward".
 */

import { type WeekCard, FRAGMENT_MAX } from "./weeklyReview.js";
import { nearIdentical } from "./chapters/quotes.js";

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface WeekMessage {
  id: number;
  content: string;
  /** YYYY-MM-DD in the user's timezone. */
  localDate: string;
}
export interface WeekWin {
  content: string;
  localDate: string;
}
export interface WeekQuotePair {
  then: { text: string; date: string };
  now: { text: string; date: string };
}
export interface WeekCommitment {
  content: string;
  localDate: string;
  scheduledDate: string | null;
}

export interface WeekSources {
  weekStart: string;
  weekEnd: string;
  userName: string | null;
  companionName: string;
  /** The user's own messages this week — crisis lines and dismissed quotes already removed. */
  messages: WeekMessage[];
  /** The user's messages over the trailing 28 days (same filtering) — the pattern card's pool. */
  monthMessages: WeekMessage[];
  /** Wins logged this week (first person, from extraction). */
  wins: WeekWin[];
  /** Then/now pairs from this week's chapter (already verbatim-gated). */
  quotePairs: WeekQuotePair[];
  /** Commitments still open at the end of the week. */
  openCommitments: WeekCommitment[];
  /** The day a still-sealed note was written, or null. */
  pendingNoteDate: string | null;
  /** The day of their first message, or null. */
  firstMessageDate: string | null;
  /** Grief/crisis guardrail: bereavement path, or a crisis detection this week. */
  guardrail: boolean;
}

export interface ModelProposal {
  /** One sentence for the moment card, second person, no feeling, no verdict. */
  moment?: string | null;
  /** A verbatim excerpt of one of this week's messages, for the marker. */
  fragment?: { messageId: number; excerpt: string } | null;
}

export type ComposeSkip = "quiet_week" | "too_few_cards" | "no_fragment";
export type ComposeResult =
  | { story: { fragment: string; cards: WeekCard[] }; skipped?: undefined }
  | { story?: undefined; skipped: ComposeSkip };

/** Fewer user messages than this in the week → no story (a quiet week is a quiet week). */
export const MIN_WEEK_MESSAGES = 5;

// ── Dates ───────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parseYmd(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`);
}

export function weekdayName(ymd: string): string {
  return WEEKDAYS[parseYmd(ymd).getUTCDay()]!;
}

export function longDate(ymd: string): string {
  const d = parseYmd(ymd);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "2–8 September" or "31 August – 6 September" (mirrors the client's weekLabel). */
export function formatWeekRange(weekStart: string, weekEnd: string): string {
  const a = parseYmd(weekStart);
  const b = parseYmd(weekEnd);
  if (a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[a.getUTCMonth()]}`;
  }
  return `${longDate(weekStart)} – ${longDate(weekEnd)}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86_400_000);
}

const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export function numberWord(n: number): string {
  return n >= 0 && n < SMALL_NUMBERS.length ? SMALL_NUMBERS[n]! : String(n);
}
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** A stamp for a quote's date relative to the week: a weekday inside the
 *  week, "Last week", "Three weeks ago", or the date once it's far back. */
export function relativeStamp(ymd: string, weekStart: string, weekEnd: string): string {
  if (ymd >= weekStart && ymd <= weekEnd) return weekdayName(ymd);
  const before = daysBetween(ymd, weekStart);
  if (before > 0) {
    if (before <= 7) return "Last week";
    const weeks = Math.round(before / 7);
    if (weeks <= 8) return `${capitalize(numberWord(weeks))} weeks ago`;
  }
  return longDate(ymd);
}

function ordinal(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

// ── Voice: first person → second person ─────────────────────────────────────
// Wins are stored in the user's own first-person voice ("I walked two days
// running, even though it felt heavy."). The card addresses them, so the
// pronouns flip and nothing else changes: "You walked two days running, even
// though it felt heavy." Legacy entries ("User went for a walk", "Went for a
// walk") are normalised the same way.

const PRONOUN_SWAPS: Array<[RegExp, string]> = [
  [/\bI am\b/g, "you are"],
  [/\bI was\b/g, "you were"],
  [/\bI['’]m\b/g, "you're"],
  [/\bI['’]ve\b/g, "you've"],
  [/\bI['’]ll\b/g, "you'll"],
  [/\bI['’]d\b/g, "you'd"],
  [/\bI\b/g, "you"],
  [/\bme\b/gi, "you"],
  [/\bmyself\b/gi, "yourself"],
  [/\bmine\b/gi, "yours"],
  [/\bmy\b/gi, "your"],
];

export function toSecondPerson(input: string): string {
  let text = input.trim().replace(/\s+/g, " ");
  if (text.length === 0) return text;
  // Legacy third-person openers.
  text = text.replace(/^(the user|user|they|she|he)\s+/i, "");
  const hadFirstPerson = /\b(I|I['’]m|I['’]ve|I['’]ll|I['’]d|me|my|mine|myself)\b/.test(text);
  for (const [re, to] of PRONOUN_SWAPS) text = text.replace(re, to);
  if (!hadFirstPerson && !/^you\b/i.test(text)) {
    // "Went for a walk" → "You went for a walk".
    text = `you ${text[0]!.toLowerCase()}${text.slice(1)}`;
  }
  text = capitalize(text);
  if (!/[.!?…]$/.test(text)) text += ".";
  return text;
}

/** A commitment ("I'll call the GP on Tuesday morning") as the thing they
 *  said they'd do: "call the GP on Tuesday morning". */
export function commitmentAsPromise(input: string): string {
  let text = input.trim().replace(/\s+/g, " ");
  text = text.replace(/^(the user|user)\s+/i, "");
  text = text.replace(
    /^(I['’]ll|I will|I am going to|I['’]m going to|I want to|I['’]d like to|I plan to|I['’]m planning to|I need to|I should|going to|you['’]ll|you will|you said you['’]d)\s+/i,
    "",
  );
  for (const [re, to] of PRONOUN_SWAPS) text = text.replace(re, to);
  text = text.replace(/[.!?…]+$/, "");
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

// ── The moment card — validating what the model proposed ────────────────────
// The sentence may only say WHAT they talked about and WHEN. Any feeling,
// verdict, praise or reading between the lines is a rejection.

const BANNED_MOMENT_WORDS = [
  "feel", "feels", "felt", "feeling", "feelings", "emotion", "emotional", "mood",
  "proud", "pride", "brave", "bravery", "courage", "strong", "stronger", "strength",
  "progress", "healing", "heal", "healed", "growth", "grow", "growing", "journey",
  "well done", "good job", "amazing", "great", "wonderful", "beautiful", "impressive",
  "better", "worse", "sad", "sadness", "happy", "happiness", "anxious", "anxiety",
  "hope", "hopeful", "lonely", "loneliness", "grief", "grieving", "angry", "anger",
  "resilient", "resilience", "deserve", "should", "seems", "seemed", "sounds like",
  "clearly", "must have", "probably", "struggling", "struggle", "coping", "cope",
  "streak", "score", "points", "days in a row",
];

export function validateMoment(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length < 12 || t.length > 120) return null;
  if (!/^You\b/.test(t)) return null;
  // One sentence: a single terminal mark, at the end.
  if ((t.match(/[.!?]/g) ?? []).length !== 1 || !/[.!?]$/.test(t)) return null;
  const lower = t.toLowerCase();
  for (const w of BANNED_MOMENT_WORDS) {
    if (new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`).test(lower)) return null;
  }
  return t;
}

// ── The fragment — the marker's verbatim words ──────────────────────────────

function wrapQuotes(s: string): string {
  const t = s.trim().replace(/^[“"']+|[”"']+$/g, "");
  return `“${t}”`;
}

/** Accepts the model's excerpt only if it is a verbatim substring of the named
 *  message and fits the disc. */
export function validateFragment(
  proposal: ModelProposal["fragment"] | undefined,
  messages: WeekMessage[],
): string | null {
  if (!proposal || typeof proposal.messageId !== "number" || typeof proposal.excerpt !== "string") return null;
  const excerpt = proposal.excerpt.trim();
  if (excerpt.length < 4 || excerpt.length > FRAGMENT_MAX - 2) return null;
  const src = messages.find((m) => m.id === proposal.messageId);
  if (!src || !src.content.includes(excerpt)) return null;
  const words = excerpt.split(/\s+/).length;
  if (words < 2 || words > 7) return null;
  return wrapQuotes(excerpt);
}

/** Deterministic fallback: a short clause from their most recent message. */
export function fallbackFragment(messages: WeekMessage[]): string | null {
  const ordered = [...messages].sort((a, b) => (a.localDate === b.localDate ? b.id - a.id : b.localDate.localeCompare(a.localDate)));
  for (const m of ordered) {
    const clauses = m.content
      .split(/[.,;:!?…\n()]+|\s[—–-]\s/)
      .map((c) => c.trim().replace(/^["“'‘]+|["”'’]+$/g, ""))
      .filter((c) => c.length >= 8 && c.length <= FRAGMENT_MAX - 2);
    const fit = clauses.filter((c) => {
      const w = c.split(/\s+/).length;
      return w >= 2 && w <= 7;
    });
    if (fit.length > 0) {
      // The fullest clause that fits the disc: most words, then longest.
      const words = (c: string) => c.split(/\s+/).length;
      fit.sort((a, b) => words(b) - words(a) || b.length - a.length);
      return wrapQuotes(fit[0]!);
    }
  }
  return null;
}

// ── The pattern card — a word they keep using ───────────────────────────────

const STOPWORDS = new Set([
  // function words
  "about", "above", "after", "again", "against", "all", "also", "and", "another", "any", "are", "around", "because",
  "been", "before", "being", "below", "between", "both", "but", "can", "cannot", "could", "did", "does", "doing",
  "done", "down", "during", "each", "either", "else", "even", "ever", "every", "for", "from", "further", "had",
  "has", "have", "having", "her", "here", "hers", "him", "his", "how", "into", "its", "itself", "just", "least",
  "less", "like", "made", "make", "makes", "making", "many", "may", "might", "more", "most", "much", "must",
  "myself", "neither", "never", "nor", "not", "now", "off", "once", "one", "only", "other", "ought", "our",
  "ours", "out", "over", "own", "same", "she", "should", "since", "some", "still", "such", "than", "that", "the",
  "their", "theirs", "them", "then", "there", "these", "they", "this", "those", "though", "through", "too",
  "under", "until", "upon", "very", "was", "were", "what", "when", "where", "which", "while", "who", "whom",
  "whose", "why", "will", "with", "within", "without", "would", "yes", "yet", "you", "your", "yours",
  "yourself", "yeah", "okay", "thanks", "thank", "please", "hello", "sorry", "well", "anyway", "actually",
  "really", "maybe", "probably", "definitely", "something", "anything", "nothing", "everything", "someone",
  "anyone", "everyone", "thing", "things", "stuff", "lot", "lots", "bit", "kind", "sort", "know", "think",
  "thought", "guess", "mean", "want", "wanted", "need", "needed", "going", "gonna", "get", "got", "gets",
  "getting", "went", "come", "came", "say", "said", "says", "tell", "told", "see", "saw", "look", "looked",
  "feel", "feels", "felt", "feeling", "today", "tonight", "tomorrow", "yesterday", "morning", "evening",
  "night", "week", "weeks", "day", "days", "time", "times", "year", "years", "month", "months", "hour", "hours",
  "back", "right", "good", "bad", "fine", "sure", "little", "long", "last", "next", "first", "new", "old",
  "way", "ways", "let", "lets", "take", "took", "give", "gave", "put", "keep", "kept", "try", "tried", "trying",
  "talk", "talked", "talking", "ask", "asked", "work", "working", "home", "people", "person", "life", "world",
  "always", "sometimes", "often", "usually", "already", "almost", "quite", "pretty", "enough", "though",
  "whatever", "whenever", "wherever", "somehow", "anymore", "cant", "dont", "didnt", "doesnt", "wont",
  "wouldnt", "couldnt", "shouldnt", "isnt", "arent", "wasnt", "werent", "havent", "hasnt", "hadnt", "thats",
  "theres", "heres", "whats", "youre", "theyre", "were", "hes", "shes", "ive", "youve", "weve", "theyve",
  "ill", "youll", "well", "theyll", "id", "youd", "wed", "theyd",
]);

export interface RecurringWord {
  word: string;
  count: number;
  days: number;
}

export const PATTERN_MIN_COUNT = 4;
export const PATTERN_MIN_DAYS = 3;

/** The word they used most over the month, by count then by days — their
 *  word, counted, nothing read into it. Null when nothing recurs enough. */
export function recurringWord(messages: WeekMessage[], exclude: string[] = []): RecurringWord | null {
  const excluded = new Set(exclude.map((w) => w.toLowerCase()).filter(Boolean));
  const counts = new Map<string, { count: number; days: Set<string> }>();
  for (const m of messages) {
    const tokens = m.content
      .toLowerCase()
      .replace(/[’]/g, "'")
      .replace(/[^a-z'\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/^'+|'+$/g, "").replace(/'/g, ""))
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !excluded.has(w));
    for (const w of tokens) {
      const entry = counts.get(w) ?? { count: 0, days: new Set<string>() };
      entry.count++;
      entry.days.add(m.localDate);
      counts.set(w, entry);
    }
  }
  let best: RecurringWord | null = null;
  for (const [word, { count, days }] of counts) {
    if (count < PATTERN_MIN_COUNT || days.size < PATTERN_MIN_DAYS) continue;
    const candidate = { word, count, days: days.size };
    if (
      !best ||
      candidate.count > best.count ||
      (candidate.count === best.count && candidate.days > best.days) ||
      (candidate.count === best.count && candidate.days === best.days && candidate.word < best.word)
    ) {
      best = candidate;
    }
  }
  return best;
}

// ── Compose ─────────────────────────────────────────────────────────────────

export function composeStory(src: WeekSources, proposal: ModelProposal = {}): ComposeResult {
  if (src.messages.length < MIN_WEEK_MESSAGES) return { skipped: "quiet_week" };

  const cards: WeekCard[] = [];
  const range = formatWeekRange(src.weekStart, src.weekEnd);

  // 1 — moment (model-proposed, validated).
  const moment = validateMoment(proposal.moment);
  if (moment) cards.push({ kind: "moment", eyebrow: range, text: moment });

  // 2 — did (suppressed under the guardrail).
  if (!src.guardrail && src.wins.length > 0) {
    const latest = [...src.wins].sort((a, b) => b.localDate.localeCompare(a.localDate))[0]!;
    const text = toSecondPerson(latest.content);
    if (text.length >= 8) {
      const day = weekdayName(latest.localDate);
      cards.push({ kind: "did", eyebrow: cards.length > 0 ? `And on ${day}` : `On ${day}`, text });
    }
  }

  // 3 — then / now (verbatim pairs from the chapter).
  const pair = src.quotePairs.find((p) => !nearIdentical(p.then.text, p.now.text));
  if (pair) {
    cards.push({
      kind: "thenNow",
      eyebrow: "Your words",
      then: { stamp: relativeStamp(pair.then.date, src.weekStart, src.weekEnd), quote: wrapQuotes(pair.then.text) },
      now: { stamp: relativeStamp(pair.now.date, src.weekStart, src.weekEnd), quote: wrapQuotes(pair.now.text) },
    });
  }

  // 4 — open: the oldest thing still sitting there. Overdue ones first.
  if (src.openCommitments.length > 0) {
    const byAge = [...src.openCommitments].sort((a, b) => a.localDate.localeCompare(b.localDate));
    const overdue = byAge.filter((c) => c.scheduledDate != null && c.scheduledDate <= src.weekEnd);
    const chosen = overdue[0] ?? byAge[0]!;
    const promise = commitmentAsPromise(chosen.content);
    if (promise.length >= 4) {
      cards.push({ kind: "open", eyebrow: "Still sitting there", text: `You said you’d ${promise}. You haven’t yet.` });
    }
  }

  // 5 — pattern: their own recurring word, counted.
  const word = recurringWord(src.monthMessages, [src.userName ?? "", src.companionName]);
  if (word) {
    cards.push({
      kind: "pattern",
      eyebrow: "Something you keep saying",
      phrase: `“${word.word}”`,
      said: `${capitalize(numberWord(word.count))} times this month.`,
    });
  }

  // 6 — forward (suppressed under the guardrail).
  if (!src.guardrail) {
    let text = "There’ll be another of these next Sunday.";
    if (src.firstMessageDate && daysBetween(src.firstMessageDate, src.weekEnd) >= 28) {
      const firstMonth = MONTHS[parseYmd(src.firstMessageDate).getUTCMonth()]!;
      const thisMonth = MONTHS[parseYmd(src.weekEnd).getUTCMonth()]!;
      if (firstMonth !== thisMonth) text = `You’re not who you were in ${firstMonth}.`;
    }
    const sub = src.pendingNoteDate
      ? `There’s a note here you wrote to yourself on the ${ordinal(parseYmd(src.pendingNoteDate).getUTCDate())}. It isn’t time yet.`
      : null;
    cards.push({ kind: "forward", text, sub });
  }

  if (cards.length < 3) return { skipped: "too_few_cards" };

  const fragment = validateFragment(proposal.fragment, src.messages) ?? fallbackFragment(src.messages);
  if (!fragment) return { skipped: "no_fragment" };

  return { story: { fragment, cards } };
}
