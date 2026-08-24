import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

interface SplashScreenProps {
  onDone: () => void;
}

/**
 * Bulletproof intro splash.
 *
 * Two-stage dismissal:
 *  1. As soon as dismiss() fires we set pointer-events:none so the login
 *     screen underneath is immediately interactive — the user is never blocked.
 *  2. We play a short CSS opacity fade (400 ms) purely for aesthetics, then
 *     call onDone() to let the parent remove us from the DOM entirely.
 *
 * We deliberately do NOT use Framer Motion's AnimatePresence exit transition
 * for the container — if the browser throttles RAF (slow devices, background
 * tabs) the exit animation can stall forever and leave a transparent z-50
 * layer covering the login screen.  Plain CSS transitions are synchronous and
 * always complete.
 */
export function SplashScreen({ onDone }: SplashScreenProps) {
  const calledRef = useRef(false);
  const [fading, setFading] = useState(false);

  const dismiss = () => {
    if (calledRef.current) return;
    calledRef.current = true;
    // Step 1 — immediately stop blocking interaction
    setFading(true);
    // Step 2 — remove from DOM after fade
    setTimeout(onDone, 450);
  };

  useEffect(() => {
    // Auto-dismiss after 2.2 s (covers the ~1.4 s animation + brief hold)
    const auto = setTimeout(dismiss, 2200);
    return () => clearTimeout(auto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onClick={dismiss}
      aria-label="Eos intro, tap to skip"
      style={{
        opacity: fading ? 0 : 1,
        pointerEvents: fading ? "none" : "auto",
        transition: "opacity 0.4s ease",
      }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background cursor-pointer select-none"
    >
      {/* ── Wordmark ── */}
      <motion.h1
        className="font-serif font-[520] text-6xl text-foreground"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.65, ease: "easeOut" }}
      >
        eos<span className="text-primary">.</span>
      </motion.h1>

      {/* ── Gold divider ── */}
      <motion.div
        className="h-px bg-primary/55 mt-4 mb-3"
        initial={{ width: 0 }}
        animate={{ width: 40 }}
        transition={{ duration: 0.45, ease: "easeOut", delay: 0.55 }}
      />

      {/* ── Skip hint ── */}
      <motion.p
        className="absolute bottom-10 text-[10px] text-muted-foreground/30 tracking-widest uppercase"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.0, duration: 0.4 }}
      >
        Tap to skip
      </motion.p>
    </div>
  );
}
