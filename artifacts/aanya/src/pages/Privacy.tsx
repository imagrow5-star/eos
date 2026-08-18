/**
 * Plain-language privacy page (Phase A).
 *
 * ── INTERNAL NOTE (not user-facing) ──────────────────────────────────────────
 * This page needs review by a qualified lawyer before any PAID launch. It is
 * written for honesty and clarity, not as a legally vetted policy document.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Publicly reachable (no login) so the consent screen and sign-up flow can
 * link to it before an account exists.
 */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-serif text-[21px] text-foreground/85">{title}</h2>
      <div className="space-y-3 text-[14px] text-muted-foreground/85 leading-relaxed">
        {children}
      </div>
    </section>
  );
}

export function Privacy() {
  const appHome = import.meta.env.BASE_URL || "/";
  return (
    <div className="min-h-[100dvh] bg-background overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-10 pb-24">
        {/* Header */}
        <div className="space-y-3">
          <a
            href={appHome}
            className="text-[11px] text-primary-strong/70 hover:text-primary-strong tracking-[0.2em] uppercase transition-colors"
          >
            ← Back to Eos
          </a>
          <h1 className="font-serif text-[32px] text-foreground/90 tracking-wide">
            Your privacy, in plain words
          </h1>
          <div className="h-px bg-primary/20" />
          <p className="text-[13px] text-muted-foreground/60">
            Last updated July 22, 2026 · Questions? Write to{" "}
            <a href="mailto:hello@eoscompanion.com" className="text-primary-strong/80 hover:text-primary-strong">
              hello@eoscompanion.com
            </a>
          </p>
        </div>

        <p className="text-[15px] text-foreground/80 leading-relaxed font-serif italic">
          Eos exists so you have somewhere private to put things down. That only works if you can
          trust what happens to your words, so here it is, without legal fog.
        </p>

        <Section title="What Eos keeps, and why">
          <ul className="space-y-2.5 list-none">
            <li>
              <span className="text-foreground/80">Your account</span>: email and a scrambled
              (hashed) password. We can't see the password itself.
            </li>
            <li>
              <span className="text-foreground/80">Profile basics</span>: your name, age band,
              country, timezone, and the choices you made when setting up your companion. This
              shapes how Eos speaks to you and which crisis resources it would point to.
            </li>
            <li>
              <span className="text-foreground/80">Conversations</span>: what you write and say
              (voice calls become text). Kept so Eos remembers you; deleted the moment you say so.
            </li>
            <li>
              <span className="text-foreground/80">Memories, chapters, notes, moods, habits</span>{" "}
              : the things Eos writes about your journey, always built from what you shared.
            </li>
          </ul>
          <p>
            That's the whole list. There are no ad trackers, no analytics companies watching you,
            and no selling of anything, ever.
          </p>
        </Section>

        <Section title="Who helps run Eos">
          <p>Four services touch your data, each for exactly one job:</p>
          <ul className="space-y-2.5 list-none">
            <li>
              <span className="text-foreground/80">Anthropic</span>: the "thinking." Your messages
              pass through their AI to generate each reply. They don't train their models on your
              words. For abuse prevention they may hold data briefly, up to about 30 days, then
              it's gone from their side too.
            </li>
            <li>
              <span className="text-foreground/80">ElevenLabs</span>: the voice. Turns Eos's words
              into speech and yours into text during calls. We've set their retention so
              transcripts and audio are deleted right after processing rather than stored.
            </li>
            <li>
              <span className="text-foreground/80">Resend</span>: delivers the emails you asked
              for (like the morning note). They see your email address and the email content.
            </li>
            <li>
              <span className="text-foreground/80">Render</span>: the secure hosting and
              database where everything lives. Your conversations, memories, and the other
              personal things on this page are encrypted inside the database itself, so a stolen
              copy of the database can't reveal your words. Eos holds the key so it can read your
              history back to you and reply. That means our systems can access your content to run
              Eos, and for nothing else. What stays visible in the database even encrypted:
              counts and timestamps (that you wrote, not what you wrote).
            </li>
          </ul>
          <p className="text-[13px] text-muted-foreground/60">
            An honest note: any service can be legally required to preserve data in rare
            trust-and-safety cases. We pick partners whose default is deletion, and we don't add
            any storage beyond what's listed here.
          </p>
        </Section>

        <Section title="What we never do">
          <ul className="space-y-2 list-none">
            <li>· Sell or rent your data, to anyone, for any reason.</li>
            <li>· Use your conversations to train AI models.</li>
            <li>· Show you ads or share data with advertisers.</li>
            <li>· Read your conversations for our own purposes. There's no admin screen for it, and it isn't part of how we run Eos. (The AI does process your messages to write each reply — see "Who helps run Eos" above.)</li>
          </ul>
        </Section>

        <Section title="Making Eos forget">
          <ul className="space-y-2.5 list-none">
            <li>
              <span className="text-foreground/80">One message</span>: tap any message in your
              conversation and choose <em>forget</em>. It's permanently deleted and can never
              appear in a future chapter or reflection.
            </li>
            <li>
              <span className="text-foreground/80">One memory</span>: on the Memory page, tap the
              × on anything Eos has remembered.
            </li>
            <li>
              <span className="text-foreground/80">Everything</span>: Settings → delete account.
              Every message, memory, chapter, note, and your account itself are erased immediately.
              There's no recycle bin and no "30-day grace period."
            </li>
          </ul>
          <p className="text-[13px] text-muted-foreground/60">
            One nuance: weekly chapters quote your own words back to you. Forgetting a message
            keeps it out of everything written <em>after</em> that moment; a chapter that was
            already written keeps its wording until you delete it or your account.
          </p>
          <p>
            You can also download everything Eos knows about you (Settings → export) as a file
            that's yours to keep and works without the internet.
          </p>
        </Section>

        <Section title="What Eos is, and isn't">
          <p>
            Eos is companionship and gentle structure for hard seasons. It is not a medical
            device, a therapist, or a crisis line. If you're ever in danger of hurting yourself,
            please contact local emergency services or a crisis line. Eos will always step out of
            the way and point you to real humans.
          </p>
        </Section>

        <Section title="Questions, worries, requests">
          <p>
            Write to{" "}
            <a href="mailto:hello@eoscompanion.com" className="text-primary-strong/80 hover:text-primary-strong">
              hello@eoscompanion.com
            </a>{" "}
            . A person reads it. If anything on this page ever changes in a way that matters,
            you'll be asked to look again before continuing, not silently opted in.
          </p>
        </Section>

        <div className="pt-4">
          <a
            href={appHome}
            className="text-[11px] text-primary-strong/70 hover:text-primary-strong tracking-[0.2em] uppercase transition-colors"
          >
            ← Back to Eos
          </a>
        </div>
      </div>
    </div>
  );
}
