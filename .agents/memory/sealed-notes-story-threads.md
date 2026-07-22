---
name: Sealed notes & story threads (chapters phase 2)
description: Ritual safety invariants, paired-row transaction rule, thread state machine gates
---
- Sealed note: one per chapter (UNIQUE chapter_id; pg 23505 read at `err.cause.code` → 409). Crisis language at WRITE time → immediate `{care:{message,crisisLine}}` in the API reply (never a seven-day timer); the row still saves sealed with crisisFlagged. Crisis notes are NEVER quoted back — resolution uses a fixed warm template and the UI hides the prompt.
- **Paired-row transitions must be one transaction with row-count asserts.** Chapter insert + note→resolved move together (roll back the chapter if the note is no longer 'sealed'); defer = conditional-UPDATE claim clearing chapter.sealResolution + note back to 'sealed' with deferrals+1, also in one transaction. **Why:** architect review flagged the original two-statement versions — a mid-flight failure leaves chapter and note disagreeing, letting a note be resolved twice.
- Defer is only offered BEFORE the seal is broken; the broken-seal reveal is client-side theatre only (localStorage `eos-seal-broken-<chapterId>`), DB untouched.
- Story threads state machine: watch/evolving/frozen. Frozen needs streak ≥3 AND ≥14-day span (crammed retellings can't freeze); evolving resets instantly; sameness below 0.7 confidence counts as NOT same. Frozen threads never surface in chapters — only soft-raised in live conversation; chapters show only the evolving-thread "workingThrough" relief framing with digit-free week labels.
- LLM question excerpts are validated against a Map pool (same shape as the chapter quote pool — passing the raw array was a real bug); unverifiable excerpt downgrades to paraphrase (questionMessageId null); crisis text is never stored as a question.
- `noteSealed` boolean on GET /chapters drives invite visibility; the invite renders only on the CURRENT chapter, never the archive.
