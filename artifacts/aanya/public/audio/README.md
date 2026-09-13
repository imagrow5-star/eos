# The landing-page recording

`sample-conversation.mp3` — one short voice conversation with Eos, played from
the "A conversation, three weeks in" section of `welcome.html`. The player
hides itself when this file is missing, so the page is safe without it.

Format: MP3, mono, 44.1 kHz, 64–96 kbps, under 60 seconds, normalised to
about −16 LUFS with a short fade in and out. Keep it under 1 MB.

Replacing it: swap the file and bump the `?v=` query on the `src` in
`welcome.html` so browsers that cached the old one (30-day cache) fetch the new.
