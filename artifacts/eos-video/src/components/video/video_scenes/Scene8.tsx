import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene8() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600),
      setTimeout(() => setPhase(2), 1400),
      setTimeout(() => setPhase(3), 2200),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
    >
      <motion.div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at 50% 30%, rgba(199, 154, 91, 0.12) 0%, rgba(27, 25, 34, 1) 50%)' }}
        animate={{ scale: [1, 1.05, 1] }}
        transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
      />

      <motion.div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(to bottom, transparent 0%, rgba(199, 154, 91, 0.05) 50%, transparent 100%)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.6, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative z-10 flex flex-col items-center px-[8vw]">
        <motion.h1
          className="text-[11vw] tracking-[0.35em] uppercase mb-[3vh]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-primary)', fontWeight: 300 }}
          initial={{ opacity: 0, scale: 0.85, y: 20 }}
          animate={phase >= 1 ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0.85, y: 20 }}
          transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
        >
          E O S
        </motion.h1>

        <motion.div
          className="h-[2px] mb-[3vh]"
          style={{ backgroundColor: 'var(--color-primary)' }}
          initial={{ width: 0, opacity: 0 }}
          animate={phase >= 2 ? { width: '20vw', opacity: 0.8 } : { width: 0, opacity: 0 }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
        />

        <motion.p
          className="text-[3.5vw] tracking-[0.25em]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-foreground)', fontWeight: 300, fontStyle: 'italic' }}
          initial={{ opacity: 0, y: 10 }}
          animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
          transition={{ duration: 1.5, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
        >
          a new dawn
        </motion.p>
      </div>

      {[...Array(6)].map((_, i) => (
        <motion.div
          key={i}
          className="absolute w-[0.4vw] h-[0.4vw] rounded-full"
          style={{ background: 'var(--color-primary)', left: `${20 + i * 12}%`, top: `${30 + (i % 2) * 20}%` }}
          animate={{ y: [-20, 20, -20], opacity: [0.2, 0.6, 0.2] }}
          transition={{ duration: 4 + i * 0.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.3 }}
        />
      ))}
    </motion.div>
  );
}
