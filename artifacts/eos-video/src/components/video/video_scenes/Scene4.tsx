import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 1700),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ clipPath: 'circle(0% at 50% 50%)' }}
      animate={{ clipPath: 'circle(100% at 50% 50%)' }}
      exit={{ clipPath: 'circle(0% at 50% 50%)' }}
      transition={{ duration: 1, ease: [0.4, 0, 0.2, 1] }}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(180deg, rgba(33, 30, 43, 1) 0%, rgba(27, 25, 34, 1) 100%)' }}
      />

      <motion.div
        className="absolute w-[35vw] h-[35vw] rounded-full blur-[130px]"
        style={{ background: 'var(--color-primary)', opacity: 0.08, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
        animate={{ scale: [1, 1.3, 1] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative z-10 flex flex-col items-center px-[10vw]">
        <motion.h2
          className="text-[5vw] text-center mb-[6vh] leading-[1.2]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-foreground)', fontWeight: 400 }}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={phase >= 1 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        >
          You can actually talk
        </motion.h2>

        <motion.div
          className="flex items-center gap-[1vw] mb-[5vh]"
          initial={{ opacity: 0 }}
          animate={phase >= 2 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <motion.div
              key={i}
              className="w-[0.8vw] rounded-full"
              style={{ background: 'var(--color-primary)' }}
              animate={{ height: ['4vh', '10vh', '6vh', '12vh', '4vh'] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.1, ease: 'easeInOut' }}
            />
          ))}
        </motion.div>

        <motion.p
          className="text-[2.5vw] text-center mb-[3vh]"
          style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', fontWeight: 400 }}
          initial={{ opacity: 0, y: 10 }}
          animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
          transition={{ duration: 0.8, delay: 0.4 }}
        >
          Voice call mode
        </motion.p>

        <motion.p
          className="text-[2vw] text-center max-w-[60vw]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-secondary)', fontStyle: 'italic', fontWeight: 300 }}
          initial={{ opacity: 0 }}
          animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 1, delay: 0.6 }}
        >
          Your voice, its voice — real conversation
        </motion.p>
      </div>
    </motion.div>
  );
}
