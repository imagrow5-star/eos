import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 800),
      setTimeout(() => setPhase(3), 1400),
      setTimeout(() => setPhase(4), 2000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0, scale: 1.05 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, x: '-5vw' }}
      transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at 30% 50%, rgba(43, 39, 53, 1) 0%, rgba(27, 25, 34, 1) 60%)' }}
      />

      <motion.div
        className="absolute w-[25vw] h-[25vw] rounded-full blur-[100px]"
        style={{ background: 'var(--color-primary)', opacity: 0.12, right: '15%', top: '20%' }}
        animate={{ y: [0, -20, 0], scale: [1, 1.1, 1] }}
        transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative z-10 w-full px-[8vw]">
        <motion.h2
          className="text-[5.5vw] mb-[5vh] leading-[1.1]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-foreground)', fontWeight: 400 }}
          initial={{ opacity: 0, x: -30 }}
          animate={phase >= 1 ? { opacity: 1, x: 0 } : { opacity: 0, x: -30 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        >
          Your companion
        </motion.h2>

        <div className="flex flex-col gap-[2vh] max-w-[70vw]">
          <motion.div
            className="p-[2vw] rounded-2xl"
            style={{ background: 'var(--color-surface-card)', borderLeft: '2px solid var(--color-primary)' }}
            initial={{ opacity: 0, x: -20 }}
            animate={phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <p className="text-[1.8vw] leading-[1.5]" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-foreground)', fontWeight: 400 }}>
              I'm here to listen. What's on your mind tonight?
            </p>
          </motion.div>

          <motion.div
            className="p-[2vw] rounded-2xl ml-[8vw]"
            style={{ background: 'var(--color-user-bubble)' }}
            initial={{ opacity: 0, x: 20 }}
            animate={phase >= 3 ? { opacity: 1, x: 0 } : { opacity: 0, x: 20 }}
            transition={{ duration: 0.6, delay: 0.3 }}
          >
            <p className="text-[1.6vw] leading-[1.5]" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', fontWeight: 400 }}>
              I keep replaying that last conversation...
            </p>
          </motion.div>

          <motion.div
            className="p-[2vw] rounded-2xl"
            style={{ background: 'var(--color-surface-card)', borderLeft: '2px solid var(--color-primary)' }}
            initial={{ opacity: 0, x: -20 }}
            animate={phase >= 4 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
            transition={{ duration: 0.6, delay: 0.5 }}
          >
            <p className="text-[1.8vw] leading-[1.5]" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-foreground)', fontWeight: 400 }}>
              That's natural. Our minds try to make sense of pain by revisiting it.
            </p>
          </motion.div>
        </div>

        <motion.p
          className="text-[2vw] mt-[5vh] ml-[2vw]"
          style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', fontWeight: 400 }}
          initial={{ opacity: 0 }}
          animate={phase >= 4 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 1, delay: 0.8 }}
        >
          Like talking to a trusted friend who understands
        </motion.p>
      </div>
    </motion.div>
  );
}
