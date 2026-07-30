import { useState } from "react";
import { Play, Pause, Check } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Language + voice picker building blocks (Sprint 1.5) ────────────────────
// Pure presentational chips shared by the Settings sections and the
// onboarding voice card. All data comes from GET /api/settings/voice-options;
// all persistence stays with the caller.

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
  currentAccent: string;
  currentVoiceId: string;
  companionGender: string;
  accents: AccentWithVoices[];
}

/** The helper line shown after choosing a not-yet-active language. */
export function comingSoonNote(lang: LanguageOption): string {
  return `This arrives next week — we're extending our safety detection to ${lang.nameEnglish} first. She'll speak English with you until then.`;
}

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
        <button
          key={l.code}
          onClick={() => onSelect(l)}
          disabled={disabled}
          className={cn(
            "px-3 py-1.5 rounded-full text-[11px] font-medium tracking-wide border transition-all",
            current === l.code
              ? "bg-primary/20 border-primary/50 text-primary"
              : "border-primary/15 text-muted-foreground/55 hover:border-primary/30 hover:text-foreground/70",
          )}
        >
          {l.flag} {l.nameNative}
        </button>
      ))}
    </div>
  );
}

export function AccentVoicePicker({
  data,
  selectedAccent,
  selectedVoiceId,
  previewingVoiceId,
  armedVoiceId,
  disabled,
  onAccentSelect,
  onVoiceTap,
}: {
  data: VoiceOptionsData;
  selectedAccent: string;
  selectedVoiceId: string;
  /** Voice currently playing its preview (spinner/pause state). */
  previewingVoiceId: string | null;
  /** Voice that has been previewed once — next tap saves it. */
  armedVoiceId: string | null;
  disabled?: boolean;
  onAccentSelect: (accent: string) => void;
  onVoiceTap: (voiceId: string) => void;
}) {
  const [showMoreAccents, setShowMoreAccents] = useState(false);
  const primary = data.accents.filter((a) => a.primary);
  const secondary = data.accents.filter((a) => !a.primary);
  const secondarySelected = secondary.some((a) => a.code === selectedAccent);
  const accentsShown = showMoreAccents || secondarySelected ? [...primary, ...secondary] : primary;
  const active = data.accents.find((a) => a.code === selectedAccent);
  const voices = active?.voices ?? [];

  return (
    <div>
      {/* Accent chips */}
      <div className="flex gap-1.5 flex-wrap items-center">
        {accentsShown.map((a) => (
          <button
            key={a.code}
            onClick={() => onAccentSelect(a.code)}
            disabled={disabled}
            className={cn(
              "px-3 py-1.5 rounded-full text-[11px] font-medium tracking-wide border transition-all",
              selectedAccent === a.code
                ? "bg-primary/20 border-primary/50 text-primary"
                : "border-primary/15 text-muted-foreground/55 hover:border-primary/30 hover:text-foreground/70",
            )}
          >
            {a.flag} {a.label}
          </button>
        ))}
        {!showMoreAccents && !secondarySelected && secondary.length > 0 && (
          <button
            onClick={() => setShowMoreAccents(true)}
            className="px-2.5 py-1.5 text-[10.5px] text-muted-foreground/45 hover:text-foreground/70 tracking-wide transition-colors"
          >
            more accents…
          </button>
        )}
      </div>

      {/* Voice chips for the selected accent */}
      {voices.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/50 mt-2.5 leading-relaxed">
          Voices for this accent are being added — she'll keep her current voice meanwhile.
        </p>
      ) : (
        <div className="flex gap-1.5 flex-wrap mt-2.5">
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
                    ? "bg-primary text-primary-foreground border-primary shadow-[0_2px_8px_hsl(35_49%_57%/0.3)]"
                    : isArmed
                      ? "bg-primary/15 border-primary/55 text-primary"
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
      )}
    </div>
  );
}
