import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

const POINTS = [
  'Crisis support when you need it most',
  'Local crisis lines for your country',
  'End-to-end encrypted conversations',
];

export function Scene7() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 1100),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: '2vh' }}
      transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at 50% 50%, rgba(33, 30, 43, 1) 0%, rgba(27, 25, 34, 1) 70%)' }}
      />

      <motion.div
        className="absolute w-[40vw] h-[40vw] rounded-full blur-[120px]"
        style={{ background: 'var(--color-primary)', opacity: 0.08, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
        animate={{ scale: [1, 1.15, 1], opacity: [0.08, 0.12, 0.08] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative z-10 flex flex-col items-center px-[8vw]">
        <motion.h2
          className="text-[5vw] text-center mb-[5vh]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-foreground)', fontWeight: 400 }}
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        >
          Always safe
        </motion.h2>

        <div className="flex flex-col gap-[3vh]">
          {POINTS.map((text, i) => (
            <motion.div
              key={text}
              className="flex items-start gap-[2vw]"
              initial={{ opacity: 0, x: -20 }}
              animate={phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
              transition={{ duration: 0.7, delay: 0.1 + i * 0.2 }}
            >
              <div className="w-[1vw] h-[1vw] rounded-full mt-[1vh] shrink-0" style={{ background: 'var(--color-primary)' }} />
              <p className="text-[2.3vw]" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', fontWeight: 400 }}>
                {text}
              </p>
            </motion.div>
          ))}
        </div>

        <motion.p
          className="text-[2.2vw] text-center mt-[6vh]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-secondary)', fontStyle: 'italic', fontWeight: 300 }}
          initial={{ opacity: 0 }}
          animate={phase >= 2 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 1, delay: 0.8 }}
        >
          Your pain is yours alone
        </motion.p>
      </div>
    </motion.div>
  );
}
