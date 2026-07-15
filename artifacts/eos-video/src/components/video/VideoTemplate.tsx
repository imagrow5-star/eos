import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video';

import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';
import { Scene6 } from './video_scenes/Scene6';
import { Scene7 } from './video_scenes/Scene7';
import { Scene8 } from './video_scenes/Scene8';

export const SCENE_DURATIONS: Record<string, number> = {
  premise:  5000,  // Grief and heartbreak
  paths:    4500,  // Two paths — breakup vs bereavement
  companion: 5500, // Companion conversation
  voice:    4000,  // Voice call mode
  journey:  4500,  // Journey tracking
  wisdom:   4000,  // Book wisdom
  safe:     4500,  // Crisis support & privacy
  close:    6000,  // E O S — a new dawn
};

const SCENE_COMPONENTS: Record<string, React.ComponentType> = {
  premise:  Scene1,
  paths:    Scene2,
  companion: Scene3,
  voice:    Scene4,
  journey:  Scene5,
  wisdom:   Scene6,
  safe:     Scene7,
  close:    Scene8,
};

export default function VideoTemplate({
  durations = SCENE_DURATIONS,
  loop = true,
  onSceneChange,
}: {
  durations?: Record<string, number>;
  loop?: boolean;
  onSceneChange?: (sceneKey: string) => void;
} = {}) {
  const { currentScene, currentSceneKey } = useVideoPlayer({ durations, loop });

  useEffect(() => {
    onSceneChange?.(currentSceneKey);
  }, [currentSceneKey, onSceneChange]);

  // Strip _r1/_r2 suffixes used by scene-lock looping
  const baseSceneKey = currentSceneKey.replace(/_r[12]$/, '') as keyof typeof SCENE_DURATIONS;
  const sceneIndex = Object.keys(SCENE_DURATIONS).indexOf(baseSceneKey);
  const SceneComponent = SCENE_COMPONENTS[baseSceneKey];

  // Persistent background glow that travels across scenes
  const glowPositions = [
    { x: '50%', y: '20%', opacity: 0.08 },
    { x: '15%', y: '40%', opacity: 0.10 },
    { x: '80%', y: '30%', opacity: 0.09 },
    { x: '50%', y: '50%', opacity: 0.08 },
    { x: '25%', y: '65%', opacity: 0.10 },
    { x: '70%', y: '45%', opacity: 0.09 },
    { x: '40%', y: '55%', opacity: 0.08 },
    { x: '50%', y: '30%', opacity: 0.12 },
  ];
  const glow = glowPositions[Math.max(0, Math.min(sceneIndex, glowPositions.length - 1))];

  return (
    <div
      className="relative w-full h-screen overflow-hidden"
      style={{ backgroundColor: 'var(--color-bg-base)' }}
    >
      {/* Persistent ambient glow — drifts across scenes */}
      <motion.div
        className="absolute w-[50vw] h-[50vw] rounded-full blur-[150px] pointer-events-none"
        style={{ background: 'var(--color-primary)' }}
        animate={{ left: glow.x, top: glow.y, opacity: glow.opacity }}
        transition={{ duration: 1.8, ease: [0.16, 1, 0.3, 1] }}
      />

      <AnimatePresence mode="popLayout">
        {SceneComponent && <SceneComponent key={currentSceneKey} />}
      </AnimatePresence>
    </div>
  );
}
