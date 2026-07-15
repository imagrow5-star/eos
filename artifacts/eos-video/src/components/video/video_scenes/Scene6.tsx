import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

const BOOKS = [
  'Self-Compassion',
  "Man's Search for Meaning",
  'Vulnerability',
  'Atomic Habits',
];

export function Scene6() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 1800),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.03 }}
      transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(135deg, rgba(27, 25, 34, 1) 0%, rgba(33, 30, 43, 1) 50%, rgba(27, 25, 34, 1) 100%)' }}
      />

      <motion.div
        className="absolute w-[28vw] h-[28vw] rounded-full blur-[100px]"
        style={{ background: 'var(--color-primary)', opacity: 0.1, right: '10%', top: '50%', transform: 'translateY(-50%)' }}
        animate={{ scale: [1, 1.2, 1] }}
        transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative z-10 flex flex-col items-center px-[10vw]">
        <motion.h2
          className="text-[4.5vw] text-center mb-[3vh]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-foreground)', fontWeight: 400 }}
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        >
          Wisdom woven in
        </motion.h2>

        <motion.p
          className="text-[2vw] text-center mb-[5vh] max-w-[65vw]"
          style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-secondary)', fontWeight: 400 }}
          initial={{ opacity: 0 }}
          animate={phase >= 1 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 0.8, delay: 0.3 }}
        >
          Drawing from 9 books on resilience and healing
        </motion.p>

        <div className="flex flex-wrap justify-center gap-[2vw] max-w-[75vw]">
          {BOOKS.map((book, i) => (
            <motion.div
              key={book}
              className="px-[2vw] py-[1.2vh] rounded-lg"
              style={{ background: 'rgba(199, 154, 91, 0.08)', border: '1px solid rgba(199, 154, 91, 0.25)' }}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={phase >= 2 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.5, delay: i * 0.15 }}
            >
              <p className="text-[1.6vw]" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-primary)', fontWeight: 400, fontStyle: 'italic' }}>
                {book}
              </p>
            </motion.div>
          ))}
        </div>

        <motion.p
          className="text-[2.2vw] text-center mt-[5vh]"
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text-secondary)', fontStyle: 'italic', fontWeight: 300 }}
          initial={{ opacity: 0 }}
          animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 1, delay: 0.6 }}
        >
          Without ever sounding like a lecture
        </motion.p>
      </div>
    </motion.div>
  );
}
