import { Play, Pause, Check } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Language + voice picker building blocks ─────────────────────────────────
// Pure presentational chips shared by the four Settings sections (LANGUAGE /
// ACCENT / VOICE GENDER / VOICE) and the onboarding voice card. All data
// comes from GET /api/settings/voice-options; all persistence stays with the
// caller.

export interface LanguageOption {
  code: string;
  nameEnglish: string;
  nameNative: string;
  flag: string;
  active: boolean;
}

export interface CatalogVoiceOption {
  voiceId: string;
  displayName: string;
  gender: "female" | "male";
}

export interface AccentWithVoices {
  code: string;
  label: string;
  flag: string;
  primary: boolean;
  voices: CatalogVoiceOption[];
}

export interface VoiceOptionsData {
  languages: LanguageOption[];
  currentLanguage: string;
  /** True when the language is fully activated (voices + safety detection). */
  currentLanguageActive: boolean;
  currentAccent: string;
  currentVoiceId: string;
  companionGender: string;
  /** Voice gender used to filter the voice lists ("female" | "male"). */
  currentVoiceGender: "female" | "male";
  /** False when the value above is only the display default (never saved). */
  voiceGenderExplicit: boolean;
  /** English: the six accents. Active non-English: one "std" entry. */
  accents: AccentWithVoices[];
}

/** The helper line shown after choosing a not-yet-active language. */
export function comingSoonNote(lang: LanguageOption): string {
  return `This arrives next week — we're extending our safety detection to ${lang.nameEnglish} first. She'll speak English with you until then.`;
}

const chipClass = (selected: boolean) =>
  cn(
    "px-3 py-1.5 rounded-full text-[11px] font-medium tracking-wide border transition-all",
    selected
      ? "bg-primary/20 border-primary/50 text-primary-strong"
      : "border-primary/15 text-muted-foreground/55 hover:border-primary/30 hover:text-foreground/70",
  );

export function LanguageChips({
  languages,
  current,
  disabled,
  onSelect,
}: {
  languages: LanguageOption[];
  current: string;
  disabled?: boolean;
  onSelect: (lang: LanguageOption) => void;
}) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {languages.map((l) => (
        <button key={l.code} onClick={() => onSelect(l)} disabled={disabled} className={chipClass(current === l.code)}>
          {l.flag} {l.nameNative}
        </button>
      ))}
    </div>
  );
}

export function AccentChips({
  accents,
  current,
  disabled,
  onSelect,
}: {
  accents: Pick<AccentWithVoices, "code" | "label" | "flag">[];
  current: string;
  disabled?: boolean;
  onSelect: (accent: string) => void;
}) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {accents.map((a) => (
        <button key={a.code} onClick={() => onSelect(a.code)} disabled={disabled} className={chipClass(current === a.code)}>
          {a.flag} {a.label}
        </button>
      ))}
    </div>
  );
}

export function VoiceGenderChips({
  current,
  disabled,
  onSelect,
}: {
  current: "female" | "male";
  disabled?: boolean;
  onSelect: (gender: "female" | "male") => void;
}) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {([
        ["female", "🚺 Female"],
        ["male", "🚹 Male"],
      ] as const).map(([value, label]) => (
        <button key={value} onClick={() => onSelect(value)} disabled={disabled} className={chipClass(current === value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function VoiceChips({
  voices,
  selectedVoiceId,
  previewingVoiceId,
  armedVoiceId,
  disabled,
  onVoiceTap,
}: {
  voices: CatalogVoiceOption[];
  selectedVoiceId: string;
  /** Voice currently playing its preview. */
  previewingVoiceId: string | null;
  /** Voice previewed once — next tap saves it. */
  armedVoiceId: string | null;
  disabled?: boolean;
  onVoiceTap: (voiceId: string) => void;
}) {
  if (voices.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
        Voices for this accent are being added — she'll keep her current voice meanwhile.
      </p>
    );
  }
  return (
    <div className="flex gap-1.5 flex-wrap">
      {voices.map((v) => {
        const isSelected = selectedVoiceId === v.voiceId;
        const isPreviewing = previewingVoiceId === v.voiceId;
        const isArmed = armedVoiceId === v.voiceId && !isSelected;
        return (
          <button
            key={v.voiceId}
            onClick={() => onVoiceTap(v.voiceId)}
            disabled={disabled}
            title={
              isSelected ? "Your current voice"
              : isArmed ? "Tap again to keep this voice"
              : "Tap to hear"
            }
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium tracking-wide border transition-all",
              isSelected
                ? "bg-primary text-primary-foreground border-primary shadow-[0_2px_8px_hsl(var(--primary)/0.3)]"
                : isArmed
                  ? "bg-primary/15 border-primary/55 text-primary-strong"
                  : "border-primary/15 text-muted-foreground/60 hover:border-primary/35 hover:text-foreground/75",
            )}
          >
            {isSelected ? (
              <Check className="w-3 h-3 shrink-0" />
            ) : isPreviewing ? (
              <Pause className="w-3 h-3 shrink-0" />
            ) : (
              <Play className="w-3 h-3 shrink-0" />
            )}
            {v.displayName}
            {isArmed && <span className="text-[9px] opacity-80">tap to keep</span>}
          </button>
        );
      })}
    </div>
  );
}
