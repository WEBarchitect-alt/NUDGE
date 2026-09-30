import { useState, useEffect, useRef, useCallback } from 'react';

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: ((this: SpeechRecognitionInstance, ev: Event) => void) | null;
  onresult: ((this: SpeechRecognitionInstance, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognitionInstance, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognitionInstance, ev: Event) => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: {
      new (): SpeechRecognitionInstance;
    };
    webkitSpeechRecognition?: {
      new (): SpeechRecognitionInstance;
    };
  }
}

export interface UseSpeechRecognitionReturn {
  isSupported: boolean;
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  errorMessage: string | null;
  startListening: () => void;
  stopListening: () => string;
  resetTranscript: () => void;
}

export function useSpeechRecognition(): UseSpeechRecognitionReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const shouldListenRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionCounterRef = useRef(0);

  // 1. Permanent history from completed recognition sessions
  const committedHistoryRef = useRef('');

  // 2. Authoritative cumulative final text of the CURRENT active session
  const sessionCumulativeFinalRef = useRef('');

  const SpeechRecognitionConstructor =
    typeof window !== 'undefined'
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : undefined;

  const isSupported = Boolean(SpeechRecognitionConstructor);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const commitCurrentSession = useCallback(() => {
    const sessionText = sessionCumulativeFinalRef.current.trim();
    const historyBefore = committedHistoryRef.current;

    if (sessionText) {
      committedHistoryRef.current = historyBefore
        ? `${historyBefore} ${sessionText}`
        : sessionText;
    }

    sessionCumulativeFinalRef.current = '';
    setTranscript(committedHistoryRef.current);
    setInterimTranscript('');
  }, []);

  useEffect(() => {
    if (!SpeechRecognitionConstructor) {
      setErrorMessage('Speech recognition is not supported in this environment.');
      return;
    }

    try {
      const recognition = new SpeechRecognitionConstructor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        sessionCounterRef.current += 1;
        const sid = sessionCounterRef.current;

        sessionCumulativeFinalRef.current = '';

        console.log(`[NudgeSpeech][START] session=${sid} shouldListen=${shouldListenRef.current}`);

        setIsListening(true);
        setErrorMessage(null);
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const sid = sessionCounterRef.current;

        const resultsArray: string[] = [];
        let latestFinalText = '';
        let currentInterim = '';

        for (let idx = 0; idx < event.results.length; idx++) {
          const item = event.results[idx];
          const text = item[0]?.transcript?.trim() || '';
          resultsArray.push(`${idx}:{final=${item.isFinal},text=${JSON.stringify(text)}}`);

          if (item.isFinal) {
            latestFinalText = text;
          } else {
            currentInterim = text;
          }
        }

        if (latestFinalText) {
          sessionCumulativeFinalRef.current = latestFinalText;
        }

        const currentSessionFinal = sessionCumulativeFinalRef.current;
        const liveProjection = committedHistoryRef.current
          ? (currentSessionFinal ? `${committedHistoryRef.current} ${currentSessionFinal}` : committedHistoryRef.current)
          : currentSessionFinal;

        const logMsg =
          `[NudgeSpeech][RAW] session=${sid} ` +
          `resultIndex=${event.resultIndex} ` +
          `resultsLength=${event.results.length} ` +
          `results=[${resultsArray.join(', ')}] ` +
          `sessionCumulative=${JSON.stringify(currentSessionFinal)} ` +
          `history=${JSON.stringify(committedHistoryRef.current)}`;

        console.log(logMsg);

        setTranscript(liveProjection);
        setInterimTranscript(currentInterim);
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        const sid = sessionCounterRef.current;
        console.warn(`[NudgeSpeech][ERROR] session=${sid} error=${event.error} message=${event.message || ''}`);

        if (event.error === 'no-speech') {
          return;
        }
        if (event.error === 'not-allowed') {
          setErrorMessage('Microphone permission was denied.');
          setIsListening(false);
          shouldListenRef.current = false;
          clearRestartTimer();
        } else {
          setErrorMessage(`Recognition issue: ${event.error}`);
        }
      };

      recognition.onend = () => {
        const sid = sessionCounterRef.current;

        const finalSessionSnapshot = JSON.stringify(sessionCumulativeFinalRef.current);
        const historySnapshot = JSON.stringify(committedHistoryRef.current);

        console.log(
          `[NudgeSpeech][END] session=${sid} ` +
          `shouldListen=${shouldListenRef.current} ` +
          `sessionFinal=${finalSessionSnapshot} ` +
          `history=${historySnapshot}`
        );

        commitCurrentSession();
        clearRestartTimer();

        if (shouldListenRef.current) {
          setIsListening(true);
          restartTimerRef.current = setTimeout(() => {
            if (shouldListenRef.current && recognitionRef.current) {
              try {
                recognitionRef.current.start();
                console.log(`[NudgeSpeech][RESTART] Auto-restarting after pause from session #${sid}`);
              } catch (e) {
                console.warn('[NudgeSpeech][RESTART_RETRY_SKIPPED]', e);
              }
            }
          }, 700);
        } else {
          setIsListening(false);
        }
      };

      recognitionRef.current = recognition;
    } catch (e) {
      setErrorMessage('Failed to initialize speech recognition.');
    }

    return () => {
      shouldListenRef.current = false;
      clearRestartTimer();
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch (ignored) {}
      }
    };
  }, [SpeechRecognitionConstructor, commitCurrentSession, clearRestartTimer]);

  const startListening = useCallback(() => {
    setErrorMessage(null);
    clearRestartTimer();
    if (!recognitionRef.current) {
      setErrorMessage('Speech recognition unavailable.');
      return;
    }

    shouldListenRef.current = true;
    setIsListening(true);
    try {
      recognitionRef.current.start();
    } catch (e) {
      console.warn('[NudgeSpeech][START_ALREADY_ACTIVE]');
    }
  }, [clearRestartTimer]);

  const stopListening = useCallback((): string => {
    // 1. Permanently disable listening and pending restarts
    shouldListenRef.current = false;
    clearRestartTimer();

    // 2. Compute final frozen transcript synchronously
    const sessionText = sessionCumulativeFinalRef.current.trim();
    const historyBefore = committedHistoryRef.current.trim();
    const frozen = historyBefore
      ? (sessionText ? `${historyBefore} ${sessionText}` : historyBefore)
      : sessionText;

    // 3. Commit into history and clear session buffer immediately
    committedHistoryRef.current = frozen;
    sessionCumulativeFinalRef.current = '';

    // 4. Stop native recognition instance safely
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (ignored) {}
    }

    setIsListening(false);
    setInterimTranscript('');
    setTranscript(frozen);

    return frozen;
  }, [clearRestartTimer]);

  const resetTranscript = useCallback(() => {
    clearRestartTimer();
    committedHistoryRef.current = '';
    sessionCumulativeFinalRef.current = '';
    setTranscript('');
    setInterimTranscript('');
    setErrorMessage(null);
  }, [clearRestartTimer]);

  return {
    isSupported,
    isListening,
    transcript,
    interimTranscript,
    errorMessage,
    startListening,
    stopListening,
    resetTranscript,
  };
}