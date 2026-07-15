import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 900),
      setTimeout(() => setPhase(3), 1600),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0, x: '3vw' }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: '-3vw' }}
      transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(circle at 70% 30%, rgba(43, 39, 53, 1) 0%, rgba(27, 25, 34, 1) 70%)' }}
      />

      <motion.div
        className="absolute w-[30vw] h-[30vw] rounded-full blur-[110px]"
        style={{ background: 'var(--color-primary)', opacity: 0.09, left: '20%', bottom: '20%' }}
        animate={{ x: [0, 30, 0] }}
        transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative z-10 flex flex-col items-center px-[8vw]">
        <motion.h2
          className="text-[5vw] text-center mb-[5vh]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-foreground)', fontWeight: 400 }}
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        >
          Track your journey
        </motion.h2>

        <div className="flex gap-[4vw] mb-[5vh]">
          {[
            { value: '14', label: 'day streak' },
            { value: '67%', label: 'growth' },
            { value: '32', label: 'reflections' },
          ].map((stat, i) => (
            <motion.div
              key={stat.label}
              className="flex flex-col items-center p-[2vw] rounded-xl"
              style={{ background: 'rgba(43, 39, 53, 0.6)', border: '1px solid rgba(199, 154, 91, 0.2)' }}
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.6, delay: 0.1 + i * 0.15 }}
            >
              <p className="text-[4vw] mb-[1vh]" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-primary)', fontWeight: 500 }}>
                {stat.value}
              </p>
              <p className="text-[1.5vw]" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)' }}>
                {stat.label}
              </p>
            </motion.div>
          ))}
        </div>

        <motion.p
          className="text-[2.2vw] text-center max-w-[70vw]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-secondary)', fontStyle: 'italic', fontWeight: 300 }}
          initial={{ opacity: 0 }}
          animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 1, delay: 0.6 }}
        >
          See how far you've come
        </motion.p>
      </div>
    </motion.div>
  );
}
