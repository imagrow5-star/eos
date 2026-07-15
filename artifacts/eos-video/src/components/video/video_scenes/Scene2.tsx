import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 900),
      setTimeout(() => setPhase(3), 1600),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ clipPath: 'inset(0 100% 0 0)' }}
      animate={{ clipPath: 'inset(0 0% 0 0)' }}
      exit={{ clipPath: 'inset(0 0 0 100%)' }}
      transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
    >
      <motion.div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(135deg, rgba(27, 25, 34, 1) 0%, rgba(33, 30, 43, 1) 100%)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8 }}
      />

      <motion.div
        className="absolute w-[40vw] h-[40vw] rounded-full opacity-10 blur-[120px]"
        style={{ background: 'var(--color-primary)', top: '30%', left: '10%' }}
        animate={{ scale: [1, 1.2, 1], opacity: [0.1, 0.15, 0.1] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative z-10 flex flex-col items-center px-[10vw] max-w-[85vw]">
        <motion.h2
          className="text-[5vw] text-center mb-[4vh] leading-[1.2]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-foreground)', fontWeight: 400 }}
          initial={{ opacity: 0, y: 30 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        >
          A gentle choice
        </motion.h2>

        <div className="flex gap-[6vw] mt-[4vh]">
          <motion.div
            className="flex flex-col items-center"
            initial={{ opacity: 0, y: 20 }}
            animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            <div
              className="w-[15vw] h-[15vw] rounded-full flex items-center justify-center mb-[2vh]"
              style={{ background: 'rgba(199, 154, 91, 0.1)', border: '2px solid rgba(199, 154, 91, 0.3)' }}
            >
              <span className="text-[2.5vw]" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-primary)', fontWeight: 300 }}>
                Breakup
              </span>
            </div>
            <p className="text-[1.8vw] text-center" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>healing from</p>
            <p className="text-[1.8vw] text-center" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>heartbreak</p>
          </motion.div>

          <motion.div
            className="flex flex-col items-center"
            initial={{ opacity: 0, y: 20 }}
            animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            transition={{ duration: 0.8, delay: 0.4 }}
          >
            <div
              className="w-[15vw] h-[15vw] rounded-full flex items-center justify-center mb-[2vh]"
              style={{ background: 'rgba(199, 154, 91, 0.1)', border: '2px solid rgba(199, 154, 91, 0.3)' }}
            >
              <span className="text-[2.5vw]" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-primary)', fontWeight: 300 }}>
                Loss
              </span>
            </div>
            <p className="text-[1.8vw] text-center" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>navigating</p>
            <p className="text-[1.8vw] text-center" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>bereavement</p>
          </motion.div>
        </div>

        <motion.p
          className="text-[2.2vw] text-center mt-[6vh]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-secondary)', fontStyle: 'italic', fontWeight: 300 }}
          initial={{ opacity: 0 }}
          animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 1, delay: 0.8 }}
        >
          Warm, never clinical
        </motion.p>
      </div>
    </motion.div>
  );
}
