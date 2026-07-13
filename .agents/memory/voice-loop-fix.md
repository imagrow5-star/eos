---
name: Voice infinite loop fix — useSpeechRecognition
description: useSpeechRecognition must use a ref for the onResult callback to avoid infinite re-renders
---

## The bug
The `onResult` callback passed to `useSpeechRecognition` is a new function reference on every render. If it's included in the `useEffect` dependency array, the effect runs every render → `setRecognition(reco)` → re-render → infinite loop. This manifests as "Maximum update depth exceeded" in the browser console.

## The fix (in `lib/voice.ts`)
```typescript
const onResultRef = useRef(onResult);
useEffect(() => { onResultRef.current = onResult; }); // no deps — runs every render to stay fresh

useEffect(() => {
  // set up recognition, use onResultRef.current inside handlers
}, []); // empty deps — only runs once
```

**Why:** The ref pattern keeps the callback fresh without causing the effect to re-run.

**How to apply:** Any hook that accepts a callback and uses it inside a useEffect must either wrap the callback in useCallback at the call site OR use a ref inside the hook. Prefer the ref pattern inside the hook so callers don't need to remember useCallback.
