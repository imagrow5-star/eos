import { useState, useEffect } from "react";

interface LandingPageProps {
  onLogin: () => void;
  onSignup: () => void;
}

export function LandingPage({ onLogin, onSignup }: LandingPageProps) {
  const [scrolled, setScrolled] = useState(false);

  // Nav blur on scroll
  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

  // Fade-up reveal on scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("lp-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
    );
    document.querySelectorAll("[data-fade]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const GoldButton = ({
    onClick,
    children,
    className = "",
  }: {
    onClick?: () => void;
    children: React.ReactNode;
    className?: string;
  }) => (
    <button
      onClick={onClick}
      style={{ background: "linear-gradient(180deg,#ECC276 0%,#D5A249 60%,#C2913A 100%)" }}
      className={`text-[#291D07] font-medium rounded-full hover:opacity-90 transition-opacity ${className}`}
    >
      {children}
    </button>
  );

  return (
    <>
      <style>{`
        [data-fade] {
          opacity: 0;
          transform: translateY(28px);
          transition: opacity 0.75s ease, transform 0.75s ease;
        }
        [data-fade].lp-visible {
          opacity: 1;
          transform: translateY(0);
        }
      `}</style>

      <div className="min-h-screen bg-[#0D0B10] text-[#F0E9DC] overflow-x-hidden">

        {/* ── Fixed nav ─────────────────────────────────────────────────────── */}
        <nav
          className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
            scrolled
              ? "bg-[#0D0B10]/90 backdrop-blur-md border-b border-[rgba(232,222,205,0.08)]"
              : ""
          }`}
        >
          <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
            {/* Wordmark */}
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="font-serif text-xl tracking-wide text-[#F0E9DC]"
            >
              eos<span className="text-[#DDB264]">.</span>
            </button>

            {/* Desktop links */}
            <div className="hidden md:flex items-center gap-7">
              <a href="#what-eos-is" className="text-sm text-[#B9B0A1] hover:text-[#F0E9DC] transition-colors">About</a>
              <a href="/privacy"      className="text-sm text-[#B9B0A1] hover:text-[#F0E9DC] transition-colors">Privacy</a>
              <a href="mailto:hello@eoscompanion.com" className="text-sm text-[#B9B0A1] hover:text-[#F0E9DC] transition-colors">Contact</a>
              <button onClick={onLogin}  className="text-sm text-[#B9B0A1] hover:text-[#F0E9DC] transition-colors">Log in</button>
              <GoldButton onClick={onSignup} className="text-sm px-5 py-2">Start free →</GoldButton>
            </div>

            {/* Mobile: only action buttons */}
            <div className="flex md:hidden items-center gap-3">
              <button onClick={onLogin} className="text-sm text-[#B9B0A1]">Log in</button>
              <GoldButton onClick={onSignup} className="text-sm px-4 py-1.5">Start free →</GoldButton>
            </div>
          </div>
        </nav>

        {/* ── Hero ──────────────────────────────────────────────────────────── */}
        <section className="relative pt-36 pb-24 px-6 text-center overflow-hidden">
          {/* Soft golden radial glow */}
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{
              width: 700,
              height: 480,
              background: "radial-gradient(ellipse at center, rgba(221,178,100,0.07) 0%, transparent 70%)",
            }}
          />

          {/* Status badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-[rgba(232,222,205,0.08)] bg-[#121016] mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-[#8FBB86] animate-pulse" />
            <span className="text-[11px] font-mono text-[#B9B0A1] uppercase tracking-widest">
              here whenever you need to talk
            </span>
          </div>

          {/* Headline */}
          <h1 className="font-serif text-5xl md:text-6xl lg:text-7xl font-medium leading-[1.1] mb-6 max-w-3xl mx-auto">
            Say what you can't say<br className="hidden sm:block" /> to{" "}
            <em className="text-[#DDB264]">anyone.</em>
          </h1>

          {/* Subline */}
          <p className="text-[#B9B0A1] text-lg md:text-xl leading-relaxed max-w-xl mx-auto mb-10">
            Eos is a private companion you can talk to — by voice or text — through a breakup,
            loneliness, or a heavy week. It listens, remembers you, and gently helps you grow.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-5">
            <GoldButton onClick={onSignup} className="px-8 py-3.5 text-base">
              Start talking — free →
            </GoldButton>
            <a
              href="#how-it-helps"
              className="px-8 py-3.5 rounded-full text-base text-[#DDB264] border border-[rgba(221,178,100,0.28)] hover:border-[rgba(221,178,100,0.5)] transition-colors"
            >
              How it works
            </a>
          </div>

          <p className="text-[11px] text-[#837B6E] font-mono tracking-wide">
            Free to start · No download · Private by design
          </p>
        </section>

        {/* ── Demo conversation card ─────────────────────────────────────────── */}
        <section className="px-6 pb-28 max-w-xl mx-auto" data-fade>
          <div className="rounded-2xl overflow-hidden border border-[rgba(232,222,205,0.08)] bg-[#121016]">
            {/* Mac chrome */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[rgba(232,222,205,0.08)]">
              <span className="w-3 h-3 rounded-full" style={{ background: "#FF5F57" }} />
              <span className="w-3 h-3 rounded-full" style={{ background: "#FEBC2E" }} />
              <span className="w-3 h-3 rounded-full" style={{ background: "#28C840" }} />
              <span className="flex-1 text-center text-[11px] text-[#837B6E] font-mono">
                Eos · a quiet moment
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-[#8FBB86] font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-[#8FBB86]" />
                here
              </span>
            </div>

            {/* Messages */}
            <div className="p-6 space-y-5">
              {/* YOU */}
              <div className="flex flex-col items-end gap-1">
                <span className="text-[10px] font-mono text-[#837B6E] uppercase tracking-widest">You</span>
                <div className="bg-[#0D0B10] border border-[rgba(232,222,205,0.08)] rounded-2xl rounded-tr-sm px-4 py-3 max-w-xs text-sm text-[#B9B0A1]">
                  I don't even know why I feel this heavy today.
                </div>
                <span className="text-[10px] font-mono text-[#837B6E]">11:02</span>
              </div>

              {/* EOS */}
              <div className="flex flex-col items-start gap-1">
                <span className="text-[10px] font-mono text-[#DDB264] uppercase tracking-widest">Eos</span>
                <div className="companion-bubble rounded-2xl rounded-tl-sm px-4 py-3 max-w-xs text-sm text-[#F0E9DC]">
                  You don't need a reason to be allowed to feel it. I'm right here —{" "}
                  <span className="text-[#DDB264]">want to just talk it through?</span>
                </div>
                <span className="text-[10px] font-mono text-[#837B6E]">11:02</span>
              </div>

              {/* YOU */}
              <div className="flex flex-col items-end gap-1">
                <div className="bg-[#0D0B10] border border-[rgba(232,222,205,0.08)] rounded-2xl rounded-tr-sm px-4 py-3 max-w-xs text-sm text-[#B9B0A1]">
                  Yeah. I think I do.
                </div>
                <span className="text-[10px] font-mono text-[#837B6E]">11:03</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Divider ───────────────────────────────────────────────────────── */}
        <Divider />

        {/* ── What Eos Is ───────────────────────────────────────────────────── */}
        <section id="what-eos-is" className="py-28 px-6 max-w-4xl mx-auto">
          <div data-fade>
            <p className="text-[11px] font-mono text-[#837B6E] uppercase tracking-widest mb-6">
              What Eos Is
            </p>
            <h2 className="font-serif text-4xl md:text-5xl font-medium leading-tight mb-8 max-w-2xl">
              Less like a chatbot. More like a{" "}
              <em className="text-[#DDB264]">calm friend</em> who never forgets.
            </h2>
            <p className="text-[#B9B0A1] text-lg leading-relaxed max-w-2xl mb-16">
              Some things are hard to say out loud to the people we know. Eos is a space where
              you can say them — in your own voice, in your own time — and be met with warmth
              instead of judgment.
            </p>
          </div>

          {/* Feature rows */}
          {[
            {
              label: "Voice",
              title: "Talk, really talk",
              body: "Natural voice conversations that feel human. Listens patiently, doesn't interrupt, answers with real warmth — or text whenever easier.",
            },
            {
              label: "Memory",
              title: "It remembers you",
              body: "Your story, people, goals. Carries your history from day one so you never start over.",
            },
            {
              label: "Chapters",
              title: "Weekly reflections",
              body: "Reflects your own words back — the patterns it noticed, in your language. A mirror, never a generic report.",
            },
            {
              label: "Mornings",
              title: "A note each day",
              body: "A short personal note each morning from what you're actually going through.",
            },
          ].map((f) => (
            <div
              key={f.label}
              data-fade
              className="grid md:grid-cols-[112px_1fr] gap-4 items-start py-8 border-t border-[rgba(232,222,205,0.08)]"
            >
              <span className="text-[11px] font-mono text-[#837B6E] uppercase tracking-widest pt-0.5">
                {f.label}
              </span>
              <div>
                <h3 className="font-serif text-xl font-medium text-[#F0E9DC] mb-2">{f.title}</h3>
                <p className="text-[#B9B0A1] leading-relaxed">{f.body}</p>
              </div>
            </div>
          ))}
          <div className="border-t border-[rgba(232,222,205,0.08)]" />
        </section>

        <Divider />

        {/* ── How It Helps ──────────────────────────────────────────────────── */}
        <section id="how-it-helps" className="py-28 px-6 max-w-4xl mx-auto">
          <div data-fade>
            <h2 className="font-serif text-4xl md:text-5xl font-medium leading-tight mb-6 max-w-2xl">
              From heavy to lighter — one honest conversation at a time.
            </h2>
            <p className="text-[#B9B0A1] text-lg leading-relaxed max-w-2xl mb-16">
              Whether it's a breakup you can't stop replaying, the loneliness of building alone,
              or exam stress that feels endless — Eos meets you where you actually are, grounded
              in real psychology, one small kind step at a time.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 md:grid-cols-4" data-fade>
            {[
              { num: "01", title: "Say it out loud",    body: "Get it out of your head and into words — with no judgment." },
              { num: "02", title: "Be understood",      body: "Feel genuinely heard, not just replied to." },
              { num: "03", title: "See yourself clearly", body: "Gentle patterns surface over time, from your own words." },
              { num: "04", title: "Grow gently",        body: "Small, honest steps. No pressure. No scorecards." },
            ].map((s, i) => (
              <div
                key={s.num}
                className={`py-8 border-t border-[rgba(232,222,205,0.08)] md:border-t-0 ${
                  i > 0 ? "md:border-l border-[rgba(232,222,205,0.08)] md:pl-8" : "md:pr-8"
                } ${i > 0 && i < 3 ? "md:pr-8" : ""}`}
              >
                <p className="text-xs font-mono text-[#DDB264] mb-4">{s.num}</p>
                <h3 className="font-serif text-lg font-medium text-[#F0E9DC] mb-2">{s.title}</h3>
                <p className="text-sm text-[#B9B0A1] leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        <Divider />

        {/* ── Privacy ───────────────────────────────────────────────────────── */}
        <section className="py-28 px-6 max-w-4xl mx-auto">
          <div data-fade>
            <h2 className="font-serif text-4xl md:text-5xl font-medium leading-tight mb-6 max-w-2xl">
              What you tell Eos stays between{" "}
              <em className="text-[#DDB264]">you and Eos.</em>
            </h2>
            <p className="text-[#B9B0A1] text-lg leading-relaxed max-w-2xl mb-10">
              You can't open up honestly if you're wondering who might read it. So we built Eos
              so that no one can.
            </p>

            {/* Pull quote */}
            <blockquote className="border-l-2 border-[#DDB264] pl-6 mb-10 max-w-2xl">
              <p className="font-serif text-lg italic text-[#F0E9DC] leading-relaxed mb-3">
                "Your conversations are encrypted so no one can sit down and read them. Not
                hackers with a stolen database. Not our team. Not even the founder."
              </p>
              <p className="text-[11px] font-mono text-[#837B6E] uppercase tracking-wide">
                That isn't a marketing line — it's how the system is built.
              </p>
            </blockquote>

            {/* Bullet list */}
            <ul className="space-y-3 text-[#B9B0A1] max-w-2xl">
              {[
                "Encrypted at the field level — individual pieces of data, not just the connection.",
                "No admin window exists on purpose. The system is designed so no one can read your conversations.",
                "Never sold, never used to train AI. No ads or tracking, ever.",
                "You can forget any single thing or delete everything and export anytime.",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <span className="text-[#DDB264] shrink-0 mt-px">—</span>
                  <span className="leading-relaxed">{item}</span>
                </li>
              ))}
              <li className="flex items-start gap-3">
                <span className="text-[#DDB264] shrink-0 mt-px">—</span>
                <span className="leading-relaxed">
                  Plain-language{" "}
                  <a href="/privacy" className="text-[#DDB264] hover:underline">
                    privacy page
                  </a>{" "}
                  — no legal fog.
                </span>
              </li>
            </ul>
          </div>
        </section>

        <Divider />

        {/* ── Founder ───────────────────────────────────────────────────────── */}
        <section className="py-28 px-6 max-w-3xl mx-auto text-center">
          <div data-fade>
            <p className="text-[11px] font-mono text-[#837B6E] uppercase tracking-widest mb-10">
              A Real Person Built This
            </p>

            <p className="font-serif text-xl md:text-2xl italic text-[#F0E9DC] leading-relaxed mb-12 max-w-xl mx-auto">
              "I built Eos after watching people I love go through breakups and lonely seasons
              with no one they felt safe talking to. Everyone deserves one place to be completely
              honest — and be met with kindness."
            </p>

            {/* Founder card */}
            <div className="inline-flex flex-col items-center gap-4 px-8 py-7 rounded-2xl bg-[#121016] border border-[rgba(232,222,205,0.08)] mb-8">
              {/* Monogram */}
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center shrink-0"
                style={{ background: "linear-gradient(180deg,#ECC276 0%,#D5A249 60%,#C2913A 100%)" }}
              >
                <span className="font-serif text-lg font-semibold text-[#291D07]">N</span>
              </div>
              <div>
                <p className="font-medium text-[#F0E9DC]">Eppili Naveen</p>
                <p className="text-sm text-[#B9B0A1] mt-0.5">Founder, Eos</p>
              </div>
              <a
                href="mailto:hello@eoscompanion.com"
                className="text-sm text-[#DDB264] hover:underline"
              >
                Questions? Write to me directly — hello@eoscompanion.com
              </a>
            </div>

            <p className="text-sm text-[#837B6E] leading-relaxed max-w-lg mx-auto">
              Eos isn't a faceless corporation — it's built and cared for by one founder who
              answers every email personally. If something feels wrong, confusing, or unsafe,
              tell me and I'll fix it.
            </p>
          </div>
        </section>

        <Divider />

        {/* ── Final CTA ─────────────────────────────────────────────────────── */}
        <section className="py-28 px-6 text-center max-w-3xl mx-auto">
          <div data-fade className="flex flex-col items-center gap-7">
            <h2 className="font-serif text-4xl md:text-5xl font-medium leading-tight">
              Whatever tonight feels like, you don't have to carry it{" "}
              <em className="text-[#DDB264]">alone.</em>
            </h2>
            <GoldButton onClick={onSignup} className="px-10 py-4 text-base">
              Start talking — free →
            </GoldButton>
            <p className="text-[11px] text-[#837B6E] font-mono tracking-wide">
              Free to start · Encrypted by design · Delete anytime
            </p>
          </div>
        </section>

        {/* ── Footer ────────────────────────────────────────────────────────── */}
        <footer className="border-t border-[rgba(232,222,205,0.08)] py-10 px-6">
          <div className="max-w-6xl mx-auto flex flex-col gap-5">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <p className="text-sm text-[#837B6E]">© 2026 Eos · eoscompanion.com</p>
              <div className="flex items-center gap-6">
                <a href="#what-eos-is" className="text-sm text-[#837B6E] hover:text-[#B9B0A1] transition-colors">About</a>
                <a href="/privacy"     className="text-sm text-[#837B6E] hover:text-[#B9B0A1] transition-colors">Privacy</a>
                <a href="mailto:hello@eoscompanion.com" className="text-sm text-[#837B6E] hover:text-[#B9B0A1] transition-colors">Contact</a>
              </div>
            </div>
            <p className="text-[11px] text-[#837B6E]/70 text-center leading-relaxed max-w-2xl mx-auto">
              Eos is a supportive companion, not a medical service, and doesn't replace
              professional care. If you're in crisis, Eos will always point you to real human
              help first.
            </p>
          </div>
        </footer>

      </div>
    </>
  );
}

// ── Hairline divider ──────────────────────────────────────────────────────────
function Divider() {
  return (
    <div className="max-w-6xl mx-auto px-6">
      <div className="h-px bg-[rgba(232,222,205,0.08)]" />
    </div>
  );
}
