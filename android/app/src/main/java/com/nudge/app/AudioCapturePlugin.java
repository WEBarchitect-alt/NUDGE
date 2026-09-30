package com.nudge.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

@CapacitorPlugin(name = "AudioCapturePlugin")
public class AudioCapturePlugin extends Plugin {
    private static final String TAG = "AudioCapturePlugin";

    private MediaRecorder mediaRecorder = null;
    private File currentOutputFile = null;
    private boolean isRecording = false;
    private boolean isPaused = false;
    private long recordingStartTime = 0;
    private long totalPausedDuration = 0;
    private long pauseStartTime = 0;

    // Temporary developer test playback
    private MediaPlayer mediaPlayer = null;
    private boolean isPlaying = false;

    private final Handler amplitudeHandler = new Handler(Looper.getMainLooper());
    private final Runnable amplitudeRunnable = new Runnable() {
        @Override
        public void run() {
            if (isRecording && !isPaused && mediaRecorder != null) {
                try {
                    int maxAmplitude = mediaRecorder.getMaxAmplitude();
                    JSObject ret = new JSObject();
                    ret.put("amplitude", maxAmplitude);
                    notifyListeners("audioAmplitude", ret);
                } catch (Exception e) {
                    Log.w(TAG, "Error polling amplitude", e);
                }
                amplitudeHandler.postDelayed(this, 100);
            }
        }
    };

    @PluginMethod
    public void startRecording(com.getcapacitor.PluginCall call) {
        stopPlaybackInternal();

        if (isRecording) {
            call.reject("Recording is already in progress.");
            return;
        }

        Context context = getContext();
        try {
            File cacheDir = context.getCacheDir();
            currentOutputFile = new File(cacheDir, "nudge_checkin_" + System.currentTimeMillis() + ".m4a");

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                mediaRecorder = new MediaRecorder(context);
            } else {
                mediaRecorder = new MediaRecorder();
            }

            mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            mediaRecorder.setAudioChannels(1);
            mediaRecorder.setAudioEncodingBitRate(32000);
            mediaRecorder.setOutputFile(currentOutputFile.getAbsolutePath());

            mediaRecorder.prepare();
            mediaRecorder.start();

            isRecording = true;
            isPaused = false;
            recordingStartTime = System.currentTimeMillis();
            totalPausedDuration = 0;
            pauseStartTime = 0;

            amplitudeHandler.removeCallbacks(amplitudeRunnable);
            amplitudeHandler.post(amplitudeRunnable);

            Log.d(TAG, "Native audio recording started at: " + currentOutputFile.getAbsolutePath());
            JSObject res = new JSObject();
            res.put("status", "recording");
            res.put("filePath", currentOutputFile.getAbsolutePath());
            call.resolve(res);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start MediaRecorder", e);
            releaseRecorderQuietly();
            call.reject("Failed to start recording: " + e.getMessage());
        }
    }

    @PluginMethod
    public void pauseRecording(com.getcapacitor.PluginCall call) {
        if (!isRecording || isPaused || mediaRecorder == null) {
            call.reject("Cannot pause: not actively recording.");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                mediaRecorder.pause();
                isPaused = true;
                pauseStartTime = System.currentTimeMillis();
                amplitudeHandler.removeCallbacks(amplitudeRunnable);

                Log.d(TAG, "Native audio recording paused.");
                JSObject res = new JSObject();
                res.put("status", "paused");
                call.resolve(res);
            } catch (Exception e) {
                Log.e(TAG, "Failed to pause MediaRecorder", e);
                call.reject("Failed to pause recording: " + e.getMessage());
            }
        } else {
            call.reject("Pausing audio is not supported on this Android version.");
        }
    }

    @PluginMethod
    public void resumeRecording(com.getcapacitor.PluginCall call) {
        if (!isRecording || !isPaused || mediaRecorder == null) {
            call.reject("Cannot resume: recording is not paused.");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                mediaRecorder.resume();
                isPaused = false;
                if (pauseStartTime > 0) {
                    totalPausedDuration += (System.currentTimeMillis() - pauseStartTime);
                    pauseStartTime = 0;
                }

                amplitudeHandler.post(amplitudeRunnable);

                Log.d(TAG, "Native audio recording resumed.");
                JSObject res = new JSObject();
                res.put("status", "recording");
                call.resolve(res);
            } catch (Exception e) {
                Log.e(TAG, "Failed to resume MediaRecorder", e);
                call.reject("Failed to resume recording: " + e.getMessage());
            }
        } else {
            call.reject("Resuming audio is not supported on this Android version.");
        }
    }

    @PluginMethod
    public void stopRecording(com.getcapacitor.PluginCall call) {
        amplitudeHandler.removeCallbacks(amplitudeRunnable);

        if (!isRecording || mediaRecorder == null || currentOutputFile == null) {
            releaseRecorderQuietly();
            JSObject res = new JSObject();
            res.put("status", "idle");
            res.put("base64Audio", "");
            res.put("mimeType", "audio/m4a");
            res.put("durationSeconds", 0);
            call.resolve(res);
            return;
        }

        long endTime = System.currentTimeMillis();

        long pausedDuration = totalPausedDuration;
        if (isPaused && pauseStartTime > 0) {
            pausedDuration += (endTime - pauseStartTime);
        }

        long activeDurationMs = (endTime - recordingStartTime) - pausedDuration;
        if (activeDurationMs < 0) activeDurationMs = 0;
        int durationSeconds = (int) Math.round(activeDurationMs / 1000.0);

        try {
            mediaRecorder.stop();
        } catch (Exception e) {
            Log.w(TAG, "MediaRecorder stop failed (possibly too short recording)", e);
        } finally {
            releaseRecorderQuietly();
        }

        if (!currentOutputFile.exists() || currentOutputFile.length() == 0) {
            call.reject("Recording failed or output file is empty.");
            return;
        }

        try {
            byte[] fileBytes = readFileToByteArray(currentOutputFile);
            String base64Audio = Base64.encodeToString(fileBytes, Base64.NO_WRAP);

            JSObject res = new JSObject();
            res.put("status", "stopped");
            res.put("base64Audio", base64Audio);
            res.put("mimeType", "audio/m4a");
            res.put("durationSeconds", durationSeconds);
            res.put("filePath", currentOutputFile.getAbsolutePath());
            res.put("fileSizeBytes", currentOutputFile.length());

            Log.d(TAG, "Native audio recording stopped successfully. Size: " + currentOutputFile.length() + " bytes, duration: " + durationSeconds + "s");
            call.resolve(res);
        } catch (IOException e) {
            Log.e(TAG, "Failed to read audio file bytes", e);
            call.reject("Failed to read audio file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void playLastRecording(com.getcapacitor.PluginCall call) {
        if (isRecording) {
            call.reject("Cannot play while recording is active.");
            return;
        }

        if (currentOutputFile == null || !currentOutputFile.exists() || currentOutputFile.length() == 0) {
            call.reject("No recorded audio file available for playback.");
            return;
        }

        stopPlaybackInternal();

        try {
            mediaPlayer = new MediaPlayer();
            mediaPlayer.setAudioAttributes(
                new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build()
            );
            mediaPlayer.setDataSource(currentOutputFile.getAbsolutePath());
            mediaPlayer.setOnCompletionListener(mp -> {
                stopPlaybackInternal();
                JSObject ret = new JSObject();
                ret.put("status", "completed");
                notifyListeners("playbackStateChange", ret);
            });
            mediaPlayer.setOnErrorListener((mp, what, extra) -> {
                Log.e(TAG, "MediaPlayer error: what=" + what + ", extra=" + extra);
                stopPlaybackInternal();
                JSObject ret = new JSObject();
                ret.put("status", "error");
                notifyListeners("playbackStateChange", ret);
                return true;
            });
            mediaPlayer.prepare();
            mediaPlayer.start();
            isPlaying = true;

            JSObject res = new JSObject();
            res.put("status", "playing");
            res.put("filePath", currentOutputFile.getAbsolutePath());
            call.resolve(res);
        } catch (Exception e) {
            Log.e(TAG, "Failed to play recorded file", e);
            stopPlaybackInternal();
            call.reject("Failed to play audio: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopPlayback(com.getcapacitor.PluginCall call) {
        stopPlaybackInternal();
        JSObject res = new JSObject();
        res.put("status", "stopped");
        call.resolve(res);
    }

    private void stopPlaybackInternal() {
        if (mediaPlayer != null) {
            try {
                if (mediaPlayer.isPlaying()) {
                    mediaPlayer.stop();
                }
            } catch (Exception ignored) {}
            try {
                mediaPlayer.reset();
            } catch (Exception ignored) {}
            try {
                mediaPlayer.release();
            } catch (Exception ignored) {}
            mediaPlayer = null;
        }
        if (isPlaying) {
            isPlaying = false;
            JSObject ret = new JSObject();
            ret.put("status", "stopped");
            notifyListeners("playbackStateChange", ret);
        }
    }

    private void releaseRecorderQuietly() {
        amplitudeHandler.removeCallbacks(amplitudeRunnable);
        if (mediaRecorder != null) {
            try {
                mediaRecorder.reset();
            } catch (Exception ignored) {}
            try {
                mediaRecorder.release();
            } catch (Exception ignored) {}
            mediaRecorder = null;
        }
        isRecording = false;
        isPaused = false;
        recordingStartTime = 0;
        totalPausedDuration = 0;
        pauseStartTime = 0;
    }

    private byte[] readFileToByteArray(File file) throws IOException {
        FileInputStream fis = new FileInputStream(file);
        byte[] data = new byte[(int) file.length()];
        int totalBytesRead = 0;
        while (totalBytesRead < data.length) {
            int bytesRead = fis.read(data, totalBytesRead, data.length - totalBytesRead);
            if (bytesRead == -1) break;
            totalBytesRead += bytesRead;
        }
        fis.close();
        return data;
    }
}