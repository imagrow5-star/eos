import { useEffect, useRef } from "react";
import { motion } from "framer-motion";

interface SplashScreenProps {
  onDone: () => void;
}

/**
 * Full-screen intro splash — shown once per session.
 * Renders as a fixed overlay so AuthGate can prefetch /api/auth/me in the
 * background while the animation plays.  When it finishes (or the user taps
 * to skip), it simply calls onDone() and the parent unmounts it via
 * AnimatePresence which plays the exit fade.
 */
export function SplashScreen({ onDone }: SplashScreenProps) {
  const calledRef = useRef(false);

  const finish = () => {
    if (calledRef.current) return;
    calledRef.current = true;
    onDone();
  };

  useEffect(() => {
    // Auto-advance after 2.8 s (animation is ~1.4 s in + 1 s hold)
    const auto = setTimeout(finish, 2800);
    // Safety net: no matter what, unblock the user after 4.5 s
    const safety = setTimeout(() => {
      if (!calledRef.current) onDone();
    }, 4500);

    return () => {
      clearTimeout(auto);
      clearTimeout(safety);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <motion.div
      key="eos-splash"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background cursor-pointer select-none"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.55, ease: "easeInOut" } }}
      onClick={finish}
      aria-label="Eos intro — tap to skip"
    >
      {/* ── Wordmark ────────────────────────────────────────────────────────── */}
      <motion.h1
        className="font-serif text-6xl text-foreground tracking-[0.35em] uppercase"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.65, ease: "easeOut" }}
      >
        EOS
      </motion.h1>

      {/* ── Gold divider ────────────────────────────────────────────────────── */}
      <motion.div
        className="h-px bg-primary/55 mt-4 mb-3"
        initial={{ width: 0 }}
        animate={{ width: 40 }}
        transition={{ duration: 0.45, ease: "easeOut", delay: 0.55 }}
      />

      {/* ── Tagline ─────────────────────────────────────────────────────────── */}
      <motion.p
        className="font-serif italic text-muted-foreground text-sm tracking-wider"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, ease: "easeOut", delay: 0.75 }}
      >
        a new dawn
      </motion.p>

      {/* ── Skip hint — appears after 1 s so it doesn't distract on first play ── */}
      <motion.p
        className="absolute bottom-10 text-[10px] text-muted-foreground/30 tracking-widest uppercase"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.1, duration: 0.4 }}
      >
        Tap to skip
      </motion.p>
    </motion.div>
  );
}
