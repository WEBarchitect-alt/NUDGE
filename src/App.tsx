import { useEffect, useState, useRef } from 'react';
import { db, type Commitment, type UserSettings } from './db';
import { Settings, Plus, Sparkles, Clock, CheckCircle2, AlertCircle, ArrowRight, Mic, MicOff, AlertTriangle, Key, ShieldCheck, XCircle, X, Activity, Play, Pause, Square, Volume2, SquareCheck } from 'lucide-react';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useSpeechRecognition } from './useSpeechRecognition';
import { evaluateCheckIn, type EvaluationResult } from './evaluator';

interface SpikePluginInterface {
  scheduleSpike(options: { triggerAtMillis?: number; delaySeconds?: number }): Promise<void>;
  cancelSpike(): Promise<void>;
  isInterruptionActive(): Promise<{ active: boolean }>;
  dismissInterruption(): Promise<void>;
  finishSession(): Promise<void>;
  addListener(
    eventName: 'interruptionStateChange',
    listenerFunc: (state: { active: boolean }) => void
  ): Promise<PluginListenerHandle>;
}

const SpikePlugin = registerPlugin<SpikePluginInterface>('SpikePlugin');

interface AudioCapturePluginInterface {
  startRecording(): Promise<{ status: string; filePath?: string }>;
  pauseRecording(): Promise<{ status: string }>;
  resumeRecording(): Promise<{ status: string }>;
  stopRecording(): Promise<{
    status: string;
    base64Audio: string;
    mimeType: string;
    durationSeconds: number;
    filePath?: string;
    fileSizeBytes?: number;
  }>;
  playLastRecording(): Promise<{ status: string; filePath?: string }>;
  stopPlayback(): Promise<{ status: string }>;
  addListener(
    eventName: 'audioAmplitude',
    listenerFunc: (data: { amplitude: number }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'playbackStateChange',
    listenerFunc: (data: { status: string }) => void
  ): Promise<PluginListenerHandle>;
}

const AudioCapturePlugin = registerPlugin<AudioCapturePluginInterface>('AudioCapturePlugin');

type AppScreen = 'home' | 'interruption' | 'checkin' | 'evaluation';

function formatTo24HourTime(dateInput: Date | string | number): string {
  const d = new Date(dateInput);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<AppScreen>('home');
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [activeCommitment, setActiveCommitment] = useState<Commitment | null>(null);
  const [loading, setLoading] = useState(true);

  // Settings modal / Key input
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');

  // Create Commitment modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newTopics, setNewTopics] = useState('');
  const [newTargetTime, setNewTargetTime] = useState('');

  // Frozen final verbal defense and evaluation results
  const [finalAnswer, setFinalAnswer] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  // Guards against active:false knocking Check-In back to Home
  const isHandlingCheckInRef = useRef(false);

  // Guard against redundant duplicate alarm scheduling
  const lastScheduledTargetMillisRef = useRef<number | null>(null);

  // ---------------------------------------------------------------------------
  // Stage 1 Native Audio Test Harness State
  // ---------------------------------------------------------------------------
  const [audioTestStatus, setAudioTestStatus] = useState<'idle' | 'recording' | 'paused' | 'stopped'>('idle');
  const [audioAmplitude, setAudioAmplitude] = useState<number>(0);
  const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);
  const [audioTestResult, setAudioTestResult] = useState<{
    durationSeconds: number;
    fileSizeBytes: number;
    mimeType: string;
    filePath?: string;
  } | null>(null);
  const [audioTestError, setAudioTestError] = useState<string | null>(null);
  const audioAmplitudeListenerRef = useRef<PluginListenerHandle | null>(null);
  const playbackListenerRef = useRef<PluginListenerHandle | null>(null);

  const {
    isSupported,
    isListening,
    transcript,
    interimTranscript,
    errorMessage: speechError,
    startListening,
    stopListening,
    resetTranscript,
  } = useSpeechRecognition();

  async function reloadData(forcedActiveId?: number) {
    // 1. One-time cleanup for old hardcoded test commitments
    const legacyRecords = await db.commitments
      .filter((c) => c.title === 'Deep Work: System Design & Voice Bridge')
      .toArray();

    for (const legacy of legacyRecords) {
      if (legacy.id) {
        await db.commitments.delete(legacy.id);
      }
    }

    // 2. Load settings
    const allSettings = await db.settings.toArray();
    if (allSettings.length === 0) {
      const initialSettings: UserSettings = {
        geminiApiKey: '',
        userName: 'Explorer',
        currentStreak: 0,
        totalXp: 0,
      };
      const id = await db.settings.add(initialSettings);
      setSettings({ ...initialSettings, id: Number(id) });
      setApiKeyInput('');
    } else {
      setSettings(allSettings[0]);
      setApiKeyInput(allSettings[0].geminiApiKey || '');
    }

    // 3. Load commitments
    const allCommitments = await db.commitments.orderBy('targetTime').toArray();
    setCommitments(allCommitments);

    // 4. Select active commitment:
    const now = Date.now();
    let pending: Commitment | null = null;

    if (forcedActiveId !== undefined) {
      pending = allCommitments.find((c) => c.id === forcedActiveId) || null;
    } else {
      pending = allCommitments.find(
        (c) => c.status === 'pending' && new Date(c.targetTime).getTime() > now
      ) || null;
    }

    setActiveCommitment(pending);

    // 5. Synchronize native exact alarm for the active commitment
    if (pending) {
      const targetMillis = new Date(pending.targetTime).getTime();
      if (targetMillis > now) {
        if (lastScheduledTargetMillisRef.current !== targetMillis) {
          try {
            await SpikePlugin.scheduleSpike({ triggerAtMillis: targetMillis });
            lastScheduledTargetMillisRef.current = targetMillis;
            console.log('[NudgeAlarmDebug] Synchronized pending commitment alarm for timestamp:', targetMillis);
          } catch (err) {
            console.warn('[NudgeAlarmDebug] Failed to reschedule pending commitment on startup', err);
          }
        }
      } else {
        lastScheduledTargetMillisRef.current = null;
      }
    } else {
      lastScheduledTargetMillisRef.current = null;
    }
  }

  useEffect(() => {
    let listenerHandle: PluginListenerHandle | null = null;

    async function init() {
      await reloadData();

      try {
        const { active } = await SpikePlugin.isInterruptionActive();
        console.log('[NudgeAlarmDebug] Initial SpikePlugin.isInterruptionActive:', active, 'at', Date.now());
        if (active) {
          console.log('[NudgeAlarmDebug] [12.0] Initial active check is true -> setCurrentScreen("interruption") at', Date.now());
          setCurrentScreen('interruption');
        }

        listenerHandle = await SpikePlugin.addListener('interruptionStateChange', (state) => {
          const now = Date.now();
          console.log('[NudgeAlarmDebug] [11.0] JS interruptionStateChange received: active=', state.active, 'at', now);
          if (state.active) {
            isHandlingCheckInRef.current = false;
            console.log('[NudgeAlarmDebug] [12.1] Switching currentScreen to "interruption" at', now);
            setCurrentScreen('interruption');
          } else {
            if (isHandlingCheckInRef.current) {
              return;
            }
            setCurrentScreen((prev) => (prev === 'interruption' ? 'home' : prev));
          }
        });

        playbackListenerRef.current = await AudioCapturePlugin.addListener('playbackStateChange', (data) => {
          if (data.status === 'stopped' || data.status === 'completed' || data.status === 'error') {
            setIsPlayingAudio(false);
          }
        });
      } catch (err) {
        console.warn('[NudgeAlarmDebug] Native plugins not available in web browser mode', err);
      } finally {
        setLoading(false);
      }
    }

    init();

    return () => {
      if (listenerHandle) {
        listenerHandle.remove();
      }
      if (audioAmplitudeListenerRef.current) {
        audioAmplitudeListenerRef.current.remove();
      }
      if (playbackListenerRef.current) {
        playbackListenerRef.current.remove();
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Stage 1 Native Audio Test Handlers
  // ---------------------------------------------------------------------------
  async function handleTestStartRecording() {
    setAudioTestError(null);
    setAudioTestResult(null);
    setIsPlayingAudio(false);
    try {
      if (!audioAmplitudeListenerRef.current) {
        audioAmplitudeListenerRef.current = await AudioCapturePlugin.addListener('audioAmplitude', (data) => {
          setAudioAmplitude(data.amplitude || 0);
        });
      }
      await AudioCapturePlugin.startRecording();
      setAudioTestStatus('recording');
    } catch (err) {
      setAudioTestError((err as Error).message || 'Failed to start recording');
    }
  }

  async function handleTestPauseRecording() {
    setAudioTestError(null);
    try {
      await AudioCapturePlugin.pauseRecording();
      setAudioTestStatus('paused');
    } catch (err) {
      setAudioTestError((err as Error).message || 'Failed to pause recording');
    }
  }

  async function handleTestResumeRecording() {
    setAudioTestError(null);
    try {
      await AudioCapturePlugin.resumeRecording();
      setAudioTestStatus('recording');
    } catch (err) {
      setAudioTestError((err as Error).message || 'Failed to resume recording');
    }
  }

  async function handleTestStopRecording() {
    setAudioTestError(null);
    try {
      const res = await AudioCapturePlugin.stopRecording();
      setAudioTestStatus('stopped');
      setAudioAmplitude(0);
      setAudioTestResult({
        durationSeconds: res.durationSeconds,
        fileSizeBytes: res.fileSizeBytes || 0,
        mimeType: res.mimeType,
        filePath: res.filePath,
      });
      if (audioAmplitudeListenerRef.current) {
        await audioAmplitudeListenerRef.current.remove();
        audioAmplitudeListenerRef.current = null;
      }
    } catch (err) {
      setAudioTestError((err as Error).message || 'Failed to stop recording');
    }
  }

  async function handleTestPlayRecording() {
    setAudioTestError(null);
    try {
      await AudioCapturePlugin.playLastRecording();
      setIsPlayingAudio(true);
    } catch (err) {
      setIsPlayingAudio(false);
      setAudioTestError((err as Error).message || 'Failed to start playback');
    }
  }

  async function handleTestStopPlayback() {
    try {
      await AudioCapturePlugin.stopPlayback();
      setIsPlayingAudio(false);
    } catch (err) {
      setAudioTestError((err as Error).message || 'Failed to stop playback');
    }
  }

  async function handleSaveApiKey() {
    if (!settings?.id) return;
    const cleanKey = apiKeyInput.trim();
    await db.settings.update(settings.id, { geminiApiKey: cleanKey });
    setSettings((prev) => (prev ? { ...prev, geminiApiKey: cleanKey } : prev));
    setShowSettingsModal(false);
  }

  function openCreateModal() {
    const defaultDate = new Date(Date.now() + 60 * 60 * 1000);
    const offset = defaultDate.getTimezoneOffset() * 60000;
    const localISOTime = new Date(defaultDate.getTime() - offset).toISOString().slice(0, 16);

    setNewTitle('');
    setNewTopics('');
    setNewTargetTime(localISOTime);
    setShowCreateModal(true);
  }

  async function handleCreateCommitment(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;

    const parsedTarget = newTargetTime ? new Date(newTargetTime) : new Date(Date.now() + 60 * 60 * 1000);
    const targetMillis = parsedTarget.getTime();

    if (targetMillis <= Date.now()) {
      alert('Target time must be in the future.');
      return;
    }

    const newCommitment: Commitment = {
      title: newTitle.trim(),
      syllabusOrTopics: newTopics.trim(),
      targetTime: parsedTarget,
      status: 'pending',
      createdAt: new Date(),
    };

    const insertedId = await db.commitments.add(newCommitment);
    const createdId = Number(insertedId);

    try {
      await SpikePlugin.scheduleSpike({ triggerAtMillis: targetMillis });
      lastScheduledTargetMillisRef.current = targetMillis;
      console.log('[NudgeAlarmDebug] Exact alarm scheduled for commitment:', createdId, targetMillis);
    } catch (err) {
      console.error('[NudgeAlarmDebug] Failed to schedule native alarm for commitment', err);
      alert('Could not schedule alarm: ' + (err as Error).message);
    }

    await reloadData(createdId);
    setShowCreateModal(false);
  }

  // Handler: "Step Up & Answer"
  async function handleAcceptInterruption() {
    isHandlingCheckInRef.current = true;
    setCurrentScreen('checkin');
    resetTranscript();
    setFinalAnswer(null);
    setEvaluation(null);
    setEvalError(null);

    try {
      await SpikePlugin.dismissInterruption();
    } catch (e) {
      console.warn('dismissInterruption error', e);
    }
  }

  // Handler: "I didn't do it"
  async function handleDeclineInterruption() {
    isHandlingCheckInRef.current = false;

    try {
      await SpikePlugin.cancelSpike();
      lastScheduledTargetMillisRef.current = null;
      await SpikePlugin.finishSession();
    } catch (e) {
      console.warn('finishSession error', e);
    }

    if (activeCommitment && activeCommitment.id) {
      await db.commitments.update(activeCommitment.id, { status: 'failed' });
      setActiveCommitment(null);
      await reloadData();
    }

    resetTranscript();
    setFinalAnswer(null);
    setEvaluation(null);
    setEvalError(null);
    setCurrentScreen('home');
  }

  // Handler: Finish spoken defense -> Trigger Gemini Evaluation
  async function handleFinishCheckIn() {
    const frozenTranscript = stopListening();
    isHandlingCheckInRef.current = false;

    const cleanFinal = frozenTranscript.trim() || transcript.trim();
    setFinalAnswer(cleanFinal);

    try {
      await SpikePlugin.finishSession();
    } catch (e) {
      console.warn('finishSession error', e);
    }

    setCurrentScreen('evaluation');
    setEvaluating(true);
    setEvalError(null);

    const apiKey = settings?.geminiApiKey?.trim() || '';
    if (!apiKey) {
      setEvaluating(false);
      setEvalError('No Gemini API Key found. Please add your key in Settings to evaluate answers.');
      return;
    }

    try {
      const result = await evaluateCheckIn({
        apiKey,
        commitmentTitle: activeCommitment?.title || 'Unspecified Commitment',
        commitmentContext: activeCommitment?.syllabusOrTopics || '',
        spokenAnswer: cleanFinal,
      });
      setEvaluation(result);
    } catch (err) {
      setEvalError((err as Error).message || 'Failed to complete evaluation.');
    } finally {
      setEvaluating(false);
    }
  }

  // Handler: Complete evaluation view and update DB
  async function handleAcknowledgeEvaluation() {
    if (activeCommitment?.id && evaluation) {
      const finalStatus =
        evaluation.completion === 'completed'
          ? 'completed'
          : evaluation.completion === 'partial'
          ? 'pending'
          : 'failed';

      await db.commitments.update(activeCommitment.id, { status: finalStatus });

      if (finalStatus !== 'pending') {
        try {
          await SpikePlugin.cancelSpike();
        } catch (e) {
          console.warn('[NudgeAlarmDebug] cancelSpike error on acknowledgement', e);
        }
        lastScheduledTargetMillisRef.current = null;
      }
    }

    setActiveCommitment(null);
    resetTranscript();
    setFinalAnswer(null);
    setEvaluation(null);
    setEvalError(null);

    await reloadData();
    setCurrentScreen('home');
  }

  // Handler: Cancel check-in
  async function handleCancelCheckIn() {
    stopListening();
    isHandlingCheckInRef.current = false;
    resetTranscript();
    setFinalAnswer(null);
    setEvaluation(null);
    setEvalError(null);

    try {
      await SpikePlugin.finishSession();
    } catch (e) {
      console.warn('finishSession error', e);
    }

    setCurrentScreen('home');
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FAF8F5]">
        <div className="w-6 h-6 border-2 border-[#232220] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ==========================================
  // SCREEN 1: ACTIVE INTERRUPTION SCREEN
  // ==========================================
  if (currentScreen === 'interruption') {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-[#232220] flex justify-center selection:bg-[#EFECE6]">
        <main className="w-full max-w-md px-6 py-12 flex flex-col justify-between min-h-screen">
          
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#EFECE6] text-xs font-medium text-[#73716B]">
              <span className="w-2 h-2 rounded-full bg-[#C87D55] animate-ping" />
              <span>Accountability Interruption</span>
            </div>
            <p className="text-xs uppercase tracking-widest text-[#73716B] font-semibold">
              Time to defend your commitment.
            </p>
          </div>

          <div className="my-auto space-y-6">
            <div className="space-y-3">
              <h1 className="text-3xl sm:text-4xl font-light tracking-tight leading-tight text-[#232220]">
                {activeCommitment ? activeCommitment.title : 'Unspecified Target'}
              </h1>
              {activeCommitment?.syllabusOrTopics && (
                <p className="text-sm text-[#73716B] leading-relaxed">
                  {activeCommitment.syllabusOrTopics}
                </p>
              )}
            </div>

            <div className="pt-2">
              <p className="text-sm font-medium text-[#232220] italic">
                What did you actually accomplish?
              </p>
            </div>
          </div>

          <div className="space-y-4 pt-8 border-t border-[#EFECE6]">
            <button
              onClick={handleAcceptInterruption}
              className="w-full py-4 rounded-full bg-[#232220] text-[#FAF8F5] text-sm font-medium hover:bg-[#3D3B37] active:scale-[0.98] transition-all flex items-center justify-center gap-2 shadow-sm"
            >
              <span>Step Up & Answer</span>
              <ArrowRight size={16} strokeWidth={2} />
            </button>

            <button
              onClick={handleDeclineInterruption}
              className="w-full py-3 rounded-full text-xs font-medium text-[#73716B] hover:text-[#232220] transition-colors"
            >
              I didn't do it
            </button>
          </div>

        </main>
      </div>
    );
  }

  // ==========================================
  // SCREEN 2: REAL VOICE CHECK-IN SCREEN (Web Speech Fallback preserved)
  // ==========================================
  if (currentScreen === 'checkin') {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-[#232220] flex justify-center selection:bg-[#EFECE6]">
        <main className="w-full max-w-md px-6 py-8 flex flex-col justify-between min-h-screen">
          
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wider uppercase text-[#73716B]">
                Check-In
              </span>
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#EFECE6] text-[11px] font-medium text-[#232220]">
                <span className={isListening ? 'w-2 h-2 rounded-full bg-[#C87D55] animate-pulse' : 'w-2 h-2 rounded-full bg-[#73716B]'} />
                <span>{isListening ? 'Listening' : 'Idle'}</span>
              </div>
            </div>

            <div>
              <h1 className="text-2xl font-light tracking-tight text-[#232220]">
                {activeCommitment ? activeCommitment.title : 'Unspecified Target'}
              </h1>
              {activeCommitment?.syllabusOrTopics && (
                <p className="text-xs text-[#73716B] mt-1 leading-relaxed">
                  {activeCommitment.syllabusOrTopics}
                </p>
              )}
            </div>

            <p className="text-xs text-[#73716B] italic">
              Tell me clearly what you actually built, learned, or solved.
            </p>
          </div>

          <div className="my-auto py-6 space-y-4">
            {speechError && (
              <div className="p-3 rounded-lg bg-[#FAF0EB] border border-[#F0D5C7] text-[#C87D55] text-xs flex items-start gap-2">
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                <span>{speechError}</span>
              </div>
            )}

            {!isSupported && (
              <div className="p-4 rounded-xl border border-[#EFECE6] bg-[#F4F1EA] text-center space-y-2">
                <p className="text-xs font-medium text-[#232220]">Speech Recognition Engine Not Available</p>
                <p className="text-[11px] text-[#73716B]">
                  Your WebView does not support the Web Speech API.
                </p>
              </div>
            )}

            <div className="min-h-[160px] max-h-[220px] overflow-y-auto p-4 rounded-2xl bg-white border border-[#EFECE6] shadow-inner text-sm leading-relaxed space-y-2">
              {transcript || interimTranscript ? (
                <p className="text-[#232220]">
                  {transcript}
                  <span className="text-[#73716B] italic">{interimTranscript ? ` ${interimTranscript}` : ''}</span>
                </p>
              ) : (
                <p className="text-[#73716B] text-xs italic">
                  {isListening
                    ? 'Listening... begin explaining your work.'
                    : 'Tap the microphone below to start your verbal defense.'}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-4 pt-6 border-t border-[#EFECE6]">
            <div className="flex items-center justify-center">
              {isListening ? (
                <button
                  onClick={() => stopListening()}
                  className="w-16 h-16 rounded-full bg-[#C87D55] text-white flex items-center justify-center shadow-lg active:scale-95 transition-all animate-pulse"
                  aria-label="Stop Listening"
                >
                  <MicOff size={24} strokeWidth={2} />
                </button>
              ) : (
                <button
                  onClick={startListening}
                  disabled={!isSupported}
                  className="w-16 h-16 rounded-full bg-[#232220] text-[#FAF8F5] flex items-center justify-center shadow-md active:scale-95 transition-all disabled:opacity-40"
                  aria-label="Start Listening"
                >
                  <Mic size={24} strokeWidth={2} />
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleCancelCheckIn}
                className="w-1/2 py-3 rounded-full text-xs font-medium text-[#73716B] hover:text-[#232220] transition-colors"
              >
                Cancel
              </button>

              <button
                onClick={handleFinishCheckIn}
                disabled={!transcript.trim()}
                className="w-1/2 py-3 rounded-full bg-[#232220] text-[#FAF8F5] text-xs font-medium hover:bg-[#3D3B37] transition-all disabled:opacity-30 flex items-center justify-center gap-1.5"
              >
                <span>Finish Answer</span>
                <ArrowRight size={14} />
              </button>
            </div>
          </div>

        </main>
      </div>
    );
  }

  // ==========================================
  // SCREEN 3: EVALUATION RESULT VIEW
  // ==========================================
  if (currentScreen === 'evaluation') {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-[#232220] flex justify-center selection:bg-[#EFECE6]">
        <main className="w-full max-w-md px-6 py-8 flex flex-col justify-between min-h-screen">
          
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wider uppercase text-[#73716B]">
                Accountability Verdict
              </span>
              {evaluation && (
                <span
                  className={`text-[11px] px-2.5 py-0.5 rounded-full font-medium ${
                    evaluation.completion === 'completed'
                      ? 'bg-[#E8F5E9] text-[#2E7D32]'
                      : evaluation.completion === 'partial'
                      ? 'bg-[#FFF3E0] text-[#E65100]'
                      : evaluation.completion === 'unclear'
                      ? 'bg-[#EDE7F6] text-[#512DA8]'
                      : 'bg-[#FFEBEE] text-[#C62828]'
                  }`}
                >
                  {evaluation.completion.replace('_', ' ').toUpperCase()}
                </span>
              )}
            </div>

            <div>
              <h1 className="text-xl font-light tracking-tight text-[#232220]">
                {activeCommitment?.title || 'Target Evaluation'}
              </h1>
              {finalAnswer && (
                <p className="text-xs text-[#73716B] mt-2 italic bg-white p-3 rounded-xl border border-[#EFECE6]">
                  "{finalAnswer}"
                </p>
              )}
            </div>
          </div>

          <div className="my-auto py-6 space-y-4">
            {evaluating && (
              <div className="p-8 text-center space-y-3">
                <div className="w-6 h-6 border-2 border-[#232220] border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-xs text-[#73716B]">Evaluating spoken defense against commitment standards...</p>
              </div>
            )}

            {evalError && (
              <div className="p-4 rounded-xl bg-[#FAF0EB] border border-[#F0D5C7] text-xs space-y-2">
                <div className="flex items-center gap-2 text-[#C87D55] font-medium">
                  <AlertTriangle size={16} />
                  <span>Evaluation Error</span>
                </div>
                <p className="text-[#73716B] leading-relaxed">{evalError}</p>
                <button
                  onClick={() => setShowSettingsModal(true)}
                  className="mt-2 text-xs text-[#232220] underline font-medium"
                >
                  Configure API Key
                </button>
              </div>
            )}

            {evaluation && !evaluating && (
              <div className="space-y-4 text-xs">
                <div className="p-4 rounded-xl bg-white border border-[#EFECE6] space-y-2">
                  <p className="font-semibold text-[#232220]">Assessment</p>
                  <p className="text-[#73716B] leading-relaxed">{evaluation.assessment}</p>
                  <p className="text-[10px] text-[#A8A59E] pt-1">
                    Confidence: {Math.round(evaluation.confidence * 100)}%
                  </p>
                </div>

                {evaluation.evidence.length > 0 && (
                  <div className="p-4 rounded-xl bg-white border border-[#EFECE6] space-y-2">
                    <p className="font-semibold text-[#2E7D32] flex items-center gap-1.5">
                      <ShieldCheck size={14} />
                      <span>Verified Evidence</span>
                    </p>
                    <ul className="list-disc list-inside space-y-1 text-[#73716B]">
                      {evaluation.evidence.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {evaluation.gaps.length > 0 && (
                  <div className="p-4 rounded-xl bg-white border border-[#EFECE6] space-y-2">
                    <p className="font-semibold text-[#C87D55] flex items-center gap-1.5">
                      <XCircle size={14} />
                      <span>Gaps & Ambiguities</span>
                    </p>
                    <ul className="list-disc list-inside space-y-1 text-[#73716B]">
                      {evaluation.gaps.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="p-3.5 rounded-xl bg-[#F4F1EA] border border-[#EFECE6] space-y-1">
                  <p className="font-semibold text-[#232220]">Recommended Next Step</p>
                  <p className="text-[#73716B] leading-relaxed">{evaluation.nextAction}</p>
                </div>
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-[#EFECE6]">
            <button
              onClick={handleAcknowledgeEvaluation}
              disabled={evaluating}
              className="w-full py-3.5 rounded-full bg-[#232220] text-[#FAF8F5] text-xs font-medium hover:bg-[#3D3B37] transition-all disabled:opacity-40"
            >
              Acknowledge & Continue
            </button>
          </div>

        </main>
      </div>
    );
  }

  // ==========================================
  // SCREEN 4: HOME SCREEN
  // ==========================================
  const otherCommitments = commitments.filter((c) => c.id !== activeCommitment?.id);

  return (
    <div className="min-h-screen bg-[#FAF8F5] text-[#232220] flex justify-center selection:bg-[#EFECE6]">
      <main className="w-full max-w-md px-6 py-8 flex flex-col justify-between min-h-screen relative">
        
        <div>
          <header className="flex justify-between items-start mb-10">
            <div>
              <span className="text-[11px] font-semibold tracking-wider uppercase text-[#73716B]">
                {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
              </span>
              <h1 className="text-2xl font-light tracking-tight mt-0.5">
                Nudge<span className="text-[#C87D55] font-normal">.</span>
              </h1>
            </div>

            <div className="flex items-center gap-3">
              {settings && settings.currentStreak > 0 && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#EFECE6] text-xs font-medium text-[#232220]">
                  <span className="text-[#C87D55]">✦</span>
                  <span>{settings.currentStreak}d</span>
                </div>
              )}
              <button 
                className="p-2 rounded-full text-[#73716B] hover:text-[#232220] transition-colors"
                aria-label="Settings"
                onClick={() => setShowSettingsModal(true)}
              >
                <Settings size={18} strokeWidth={1.5} />
              </button>
            </div>
          </header>

          <section className="mb-12">
            {activeCommitment ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-[#C87D55] animate-pulse" />
                  <span className="text-xs font-medium uppercase tracking-widest text-[#73716B]">
                    Primary Promise
                  </span>
                </div>

                <div>
                  <h2 className="text-3xl font-normal tracking-tight leading-snug">
                    {activeCommitment.title}
                  </h2>
                  {activeCommitment?.syllabusOrTopics && (
                    <p className="mt-2 text-sm text-[#73716B] leading-relaxed">
                      {activeCommitment.syllabusOrTopics}
                    </p>
                  )}
                </div>

                <div className="pt-2 flex items-center gap-2 text-xs font-medium text-[#73716B]">
                  <Clock size={14} strokeWidth={1.5} />
                  <span>
                    Due {formatTo24HourTime(activeCommitment.targetTime)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="py-8 space-y-6">
                <div className="relative w-12 h-12">
                  <div className="absolute inset-0 rounded-full border border-[#D5D0C7]" />
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#EFECE6] border border-[#FAF8F5]" />
                  <div className="absolute inset-0 flex items-center justify-center text-[#C87D55]">
                    <Sparkles size={16} strokeWidth={1.5} />
                  </div>
                </div>

                <div className="space-y-2">
                  <h2 className="text-2xl font-light tracking-tight text-[#232220]">
                    No active commitments.
                  </h2>
                  <p className="text-sm text-[#73716B] leading-relaxed max-w-xs">
                    Nudge remains quiet until you set a target. Create a commitment to defend.
                  </p>
                </div>
              </div>
            )}
          </section>

          {otherCommitments.length > 0 && (
            <section className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#73716B]">
                Upcoming & Log
              </h3>
              <div className="divide-y divide-[#EFECE6]">
                {otherCommitments.map((item) => (
                  <div key={item.id} className="py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-normal text-[#232220]">{item.title}</p>
                      <p className="text-xs text-[#73716B]">
                        {new Date(item.targetTime).toLocaleDateString([], { month: 'short', day: 'numeric' })} at{' '}
                        {formatTo24HourTime(item.targetTime)}
                      </p>
                    </div>
                    <div>
                      {item.status === 'completed' && <CheckCircle2 size={16} className="text-[#2E7D32]" />}
                      {item.status === 'failed' && <AlertCircle size={16} className="text-[#C87D55]" />}
                      {item.status === 'pending' && <span className="text-[11px] text-[#73716B] font-mono">Queued</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <footer className="pt-8 pb-4 flex flex-col gap-3 border-t border-[#EFECE6]">
          <div className="flex items-center justify-between gap-4">
            <button 
              className="text-xs text-[#C87D55] font-medium hover:text-[#232220] transition-colors underline-offset-4 underline"
              onClick={async () => {
                if (!activeCommitment) {
                  alert('Please create a commitment first before scheduling a spike test.');
                  return;
                }
                try {
                  await SpikePlugin.scheduleSpike({ delaySeconds: 60 });
                  lastScheduledTargetMillisRef.current = null;
                  alert('Alarm set for 60 seconds! Lock your phone now.');
                } catch (e) {
                  alert('Spike error: ' + JSON.stringify(e));
                }
              }}
            >
              Test 60s Lock-Screen Spike
            </button>

            <button 
              className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#232220] text-[#FAF8F5] text-xs font-medium hover:bg-[#3D3B37] transition-all shadow-sm active:scale-95"
              onClick={openCreateModal}
            >
              <Plus size={15} strokeWidth={2} />
              <span>Create Commitment</span>
            </button>
          </div>
        </footer>

        {/* CREATE COMMITMENT MODAL */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <div className="w-full max-w-sm bg-[#FAF8F5] rounded-3xl p-6 border border-[#EFECE6] shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[#232220]">New Commitment</h2>
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="text-[#73716B] hover:text-[#232220]"
                >
                  <X size={16} />
                </button>
              </div>

              <form onSubmit={handleCreateCommitment} className="space-y-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[#73716B]">Commitment Title</label>
                  <input
                    type="text"
                    required
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g. Study System Design"
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#EFECE6] bg-white text-xs text-[#232220] focus:outline-none focus:border-[#232220]"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[#73716B]">Topics / Expected Outcome</label>
                  <textarea
                    rows={3}
                    value={newTopics}
                    onChange={(e) => setNewTopics(e.target.value)}
                    placeholder="e.g. Load balancing, caching, database scaling, horizontal vs vertical scaling"
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#EFECE6] bg-white text-xs text-[#232220] focus:outline-none focus:border-[#232220] resize-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[#73716B]">Target Time (24h)</label>
                  <input
                    type="datetime-local"
                    step="60"
                    value={newTargetTime}
                    onChange={(e) => setNewTargetTime(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#EFECE6] bg-white text-xs text-[#232220] focus:outline-none focus:border-[#232220]"
                  />
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    className="w-full py-2.5 rounded-full bg-[#232220] text-[#FAF8F5] text-xs font-medium hover:bg-[#3D3B37] transition-all shadow-sm"
                  >
                    Set Commitment
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* SETTINGS MODAL */}
        {showSettingsModal && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <div className="w-full max-w-sm bg-[#FAF8F5] rounded-3xl p-6 border border-[#EFECE6] shadow-xl space-y-5 max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Key size={16} className="text-[#C87D55]" />
                  <h2 className="text-sm font-semibold text-[#232220]">Settings</h2>
                </div>
                <button
                  onClick={() => setShowSettingsModal(false)}
                  className="text-[#73716B] text-xs hover:text-[#232220]"
                >
                  Close
                </button>
              </div>

              <div className="space-y-2">
                <label className="text-xs text-[#73716B]">Gemini API Key</label>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#EFECE6] bg-white text-xs text-[#232220] focus:outline-none focus:border-[#232220]"
                />
                <p className="text-[10px] text-[#73716B]">
                  Your key is stored locally in IndexedDB and never sent to any custom backend.
                </p>
                <button
                  onClick={handleSaveApiKey}
                  className="w-full py-2.5 rounded-full bg-[#232220] text-[#FAF8F5] text-xs font-medium hover:bg-[#3D3B37] transition-all"
                >
                  Save Settings
                </button>
              </div>

              {/* ------------------------------------------------------------------ */}
              {/* STAGE 1: NATIVE AUDIO TEST HARNESS */}
              {/* ------------------------------------------------------------------ */}
              <div className="pt-3 border-t border-[#EFECE6] space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#232220]">
                    <Activity size={14} className="text-[#C87D55]" />
                    <span>Native Audio Test</span>
                  </div>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                      audioTestStatus === 'recording'
                        ? 'bg-[#E8F5E9] text-[#2E7D32] animate-pulse'
                        : audioTestStatus === 'paused'
                        ? 'bg-[#FFF3E0] text-[#E65100]'
                        : isPlayingAudio
                        ? 'bg-[#E3F2FD] text-[#1565C0] animate-pulse'
                        : audioTestStatus === 'stopped'
                        ? 'bg-[#EFECE6] text-[#232220]'
                        : 'bg-[#F4F1EA] text-[#73716B]'
                    }`}
                  >
                    {isPlayingAudio ? 'PLAYING' : audioTestStatus.toUpperCase()}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[11px] text-[#73716B] bg-white px-3 py-2 rounded-xl border border-[#EFECE6]">
                  <span>Live Amplitude</span>
                  <div className="flex items-center gap-2">
                    <div className="w-20 bg-[#EFECE6] h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-[#C87D55] h-full transition-all duration-100"
                        style={{ width: `${Math.min(100, Math.round((audioAmplitude / 32767) * 100))}%` }}
                      />
                    </div>
                    <span className="font-mono text-[10px] w-8 text-right">{audioAmplitude}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={handleTestStartRecording}
                    disabled={audioTestStatus === 'recording' || isPlayingAudio}
                    className="py-2 px-3 rounded-xl bg-[#232220] text-[#FAF8F5] text-[11px] font-medium flex items-center justify-center gap-1.5 disabled:opacity-40"
                  >
                    <Play size={12} />
                    <span>Start</span>
                  </button>

                  <button
                    onClick={handleTestStopRecording}
                    disabled={(audioTestStatus !== 'recording' && audioTestStatus !== 'paused') || isPlayingAudio}
                    className="py-2 px-3 rounded-xl bg-[#232220] text-[#FAF8F5] text-[11px] font-medium flex items-center justify-center gap-1.5 disabled:opacity-40"
                  >
                    <Square size={12} />
                    <span>Stop</span>
                  </button>

                  <button
                    onClick={handleTestPauseRecording}
                    disabled={audioTestStatus !== 'recording' || isPlayingAudio}
                    className="py-2 px-3 rounded-xl bg-[#EFECE6] text-[#232220] text-[11px] font-medium flex items-center justify-center gap-1.5 disabled:opacity-40"
                  >
                    <Pause size={12} />
                    <span>Pause</span>
                  </button>

                  <button
                    onClick={handleTestResumeRecording}
                    disabled={audioTestStatus !== 'paused' || isPlayingAudio}
                    className="py-2 px-3 rounded-xl bg-[#EFECE6] text-[#232220] text-[11px] font-medium flex items-center justify-center gap-1.5 disabled:opacity-40"
                  >
                    <Play size={12} />
                    <span>Resume</span>
                  </button>
                </div>

                {/* Developer Playback Controls */}
                <div className="pt-2">
                  {!isPlayingAudio ? (
                    <button
                      onClick={handleTestPlayRecording}
                      disabled={!audioTestResult?.filePath || audioTestStatus === 'recording' || audioTestStatus === 'paused'}
                      className="w-full py-2 px-3 rounded-xl bg-[#FAF8F5] border border-[#232220] text-[#232220] text-[11px] font-medium flex items-center justify-center gap-1.5 disabled:opacity-30 active:scale-[0.98] transition-all"
                    >
                      <Volume2 size={13} className="text-[#C87D55]" />
                      <span>Play Last Recording</span>
                    </button>
                  ) : (
                    <button
                      onClick={handleTestStopPlayback}
                      className="w-full py-2 px-3 rounded-xl bg-[#C87D55] text-white text-[11px] font-medium flex items-center justify-center gap-1.5 active:scale-[0.98] transition-all"
                    >
                      <SquareCheck size={13} />
                      <span>Stop Playback</span>
                    </button>
                  )}
                </div>

                {audioTestError && (
                  <div className="p-2.5 rounded-xl bg-[#FAF0EB] border border-[#F0D5C7] text-[#C87D55] text-[11px] flex items-start gap-1.5">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                    <span>{audioTestError}</span>
                  </div>
                )}

                {audioTestResult && (
                  <div className="p-3 rounded-xl bg-white border border-[#EFECE6] space-y-1 text-[11px]">
                    <p className="font-semibold text-[#2E7D32]">Recording Result (Success)</p>
                    <div className="text-[#73716B] space-y-0.5 font-mono text-[10px]">
                      <p>durationSeconds: <span className="text-[#232220] font-semibold">{audioTestResult.durationSeconds}s</span></p>
                      <p>fileSizeBytes: <span className="text-[#232220] font-semibold">{audioTestResult.fileSizeBytes} B</span> ({Math.round(audioTestResult.fileSizeBytes / 1024)} KB)</p>
                      <p>mimeType: <span className="text-[#232220] font-semibold">{audioTestResult.mimeType}</span></p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}