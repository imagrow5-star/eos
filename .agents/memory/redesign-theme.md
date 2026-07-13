---
name: Redesign theme — navy/ivory/gold
description: Complete visual redesign from purple/violet to midnight navy, ivory text, 24k gold accents. Font choices and wordmark.
---

## Theme system

**Palette (CSS custom properties):**
- `--background`: #0F172A midnight navy (`220 50% 11%`)
- `--card`: #131D35 lighter navy panel (`222 47% 14%`)
- `--foreground` (ivory): #F4EADE (`37 47% 91%`)
- `--primary` = 24k gold #C69B3C (`40 56% 50%`) — used in restraint: thin borders, small icons ONLY
- `--secondary` = champagne #EBDAB0 (`43 50% 80%`) — highlights, stat numbers
- `--muted-foreground`: soft ivory-gray (`37 20% 58%`)
- `--border`: gold hairline (`40 25% 22%`)

**Fonts:**
- `--font-sans`: Inter (all UI copy, user messages)
- `--font-serif`: Cormorant Garamond (companion messages, headings, stat numbers)
- Google Fonts: `Inter:opsz,wght@14..32,300;400;500;600` and `Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500`

**Companion message class:** `.companion-message` (font-family: Cormorant Garamond)

**ASHA wordmark in Chat header:** `A S H <span class="text-primary">A</span>` — letterspaced serif, final A in gold, centered absolutely in header.

**Gentle mode (bereavement path):** `.gentle-mode` CSS class on outer Chat div; makes `.companion-message` slightly larger (1.0625rem) and `.btn-action` taller.

**Why:**
User explicitly specified "rich and royal, not achieved"; quiet luxury like a private members' club; no saturated colors; gold ONLY in restraint.

**How to apply:**
When adding any new UI: use `text-primary` only for gold hairlines, small icons, thin accents. Use `text-secondary` for champagne highlights. Use `text-foreground/80` or `/90` for body text. Never use any purple, violet, rose, or saturated colors.
