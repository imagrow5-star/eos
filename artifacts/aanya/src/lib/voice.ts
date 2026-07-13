import { useState, useEffect, useRef } from "react";

export function useSpeechRecognition(onResult: (text: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const [recognition, setRecognition] = useState<any>(null);

  // Keep latest onResult in a ref so the effect only runs once
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    // @ts-ignore
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const reco = new SpeechRecognition();
    reco.continuous = false;
    reco.interimResults = false;
    reco.lang = "en-IN";

    reco.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      onResultRef.current(transcript);
    };

    reco.onerror = () => {
      setIsListening(false);
    };

    reco.onend = () => {
      setIsListening(false);
    };

    setRecognition(reco);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run only once — onResult is accessed via ref

  const startListening = () => {
    if (recognition) {
      try {
        recognition.start();
        setIsListening(true);
      } catch {
        // recognition may already be running
      }
    }
  };

  const stopListening = () => {
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
      setIsListening(false);
    }
  };

  return { isListening, startListening, stopListening, supported: !!recognition };
}

export function speakText(text: string, onEnd?: () => void) {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-IN";
    utterance.rate = 0.9;
    utterance.pitch = 1.0;
    if (onEnd) utterance.onend = onEnd;
    window.speechSynthesis.speak(utterance);
  } else if (onEnd) {
    onEnd();
  }
}
