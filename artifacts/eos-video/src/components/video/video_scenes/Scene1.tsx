import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 400),
      setTimeout(() => setPhase(2), 1200),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.04 }}
      transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* Dark atmospheric background */}
      <motion.div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at 50% 20%, rgba(199, 154, 91, 0.08) 0%, rgba(27, 25, 34, 1) 60%)',
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.5 }}
      />

      {/* Floating mist effect */}
      <motion.div
        className="absolute inset-0 opacity-20"
        style={{
          background: 'radial-gradient(circle at 70% 40%, rgba(199, 154, 91, 0.15) 0%, transparent 50%)',
        }}
        animate={{ scale: [1, 1.3, 1], x: [0, 30, 0] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Content container */}
      <div className="relative z-10 flex flex-col items-center px-[8vw] max-w-[90vw]">
        <motion.p
          className="text-[3.5vw] leading-[1.4] text-center mb-[2vh]"
          style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', fontWeight: 400 }}
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        >
          Grief and heartbreak leave us
        </motion.p>

        <motion.p
          className="text-[3.5vw] leading-[1.4] text-center mb-[5vh]"
          style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', fontWeight: 400 }}
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
        >
          alone at 2am with nowhere to turn.
        </motion.p>

        <motion.div
          className="h-[2px] mb-[5vh]"
          style={{ backgroundColor: 'var(--color-primary)' }}
          initial={{ width: 0, opacity: 0 }}
          animate={phase >= 2 ? { width: '12vw', opacity: 0.6 } : { width: 0, opacity: 0 }}
          transition={{ duration: 0.8, delay: 0.5 }}
        />

        <motion.h1
          className="text-[9vw] tracking-[0.3em] uppercase text-center"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-primary)', fontWeight: 300 }}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={phase >= 2 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.8 }}
          transition={{ duration: 1.2, delay: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          Eos
        </motion.h1>

        <motion.p
          className="text-[2vw] tracking-[0.2em] mt-[2vh]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-secondary)', fontWeight: 300, fontStyle: 'italic' }}
          initial={{ opacity: 0 }}
          animate={phase >= 2 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 1, delay: 1.2 }}
        >
          is there
        </motion.p>
      </div>
    </motion.div>
  );
}
