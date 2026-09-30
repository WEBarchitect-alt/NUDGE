package com.nudge.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

public class NudgeRingingService extends Service {
    private static final String TAG = "NudgeRingingService";
    private static final String DIAG_TAG = "NudgeAlarmDebug";
    private static final String CHANNEL_ID = "nudge_interruption_channel";
    private static final int NOTIFICATION_ID = 9001;

    public static final String ACTION_STOP_RINGTONE = "com.nudge.app.ACTION_STOP_RINGTONE";

    private static boolean isRingingActive = false;
    private MediaPlayer mediaPlayer;

    public static boolean isInterruptionActive() {
        return isRingingActive;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(DIAG_TAG, "[4.0] NudgeRingingService.onCreate at " + System.currentTimeMillis());
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        long now = System.currentTimeMillis();
        String action = intent != null ? intent.getAction() : "null";
        Log.d(DIAG_TAG, "[4.1] NudgeRingingService.onStartCommand: now=" + now 
            + " action=" + action 
            + " currentInterruptionActive=" + isRingingActive);

        if (ACTION_STOP_RINGTONE.equals(action)) {
            Log.d(DIAG_TAG, "[4.2] Handling ACTION_STOP_RINGTONE at " + now);
            stopRingtoneOnly();
            return START_NOT_STICKY;
        }

        isRingingActive = true;

        Log.d(DIAG_TAG, "[7.0] Preparing full-screen PendingIntent for MainActivity at " + System.currentTimeMillis());
        Intent fullScreenIntent = new Intent(this, MainActivity.class);
        fullScreenIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        fullScreenIntent.putExtra("TRIGGERED_BY_ALARM", true);
        fullScreenIntent.putExtra("SERVICE_START_TIME", now);

        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent fullScreenPendingIntent = PendingIntent.getActivity(this, 1, fullScreenIntent, pendingFlags);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("Nudge Accountability")
            .setContentText("Commitment time reached. Defend your work.")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setAutoCancel(true)
            .build();

        Log.d(DIAG_TAG, "[5.0] Immediately before startForeground() at " + System.currentTimeMillis());
        try {
            startForeground(NOTIFICATION_ID, notification);
            Log.d(DIAG_TAG, "[6.0] Immediately after startForeground() at " + System.currentTimeMillis());
        } catch (Exception e) {
            Log.e(DIAG_TAG, "[5.1] ERROR in startForeground()", e);
        }

        startRingtone();

        Log.d(DIAG_TAG, "[10.0-prep] Calling SpikePlugin.notifyInterruptionState(true) from service at " + System.currentTimeMillis());
        SpikePlugin.notifyInterruptionState(true);

        return START_NOT_STICKY;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Accountability Interruption",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Critical interruption alarms for Nudge commitments");
            channel.enableLights(true);
            channel.enableVibration(true);
            channel.setBypassDnd(true);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void startRingtone() {
        if (mediaPlayer != null) return;
        try {
            Uri alert = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (alert == null) {
                alert = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            }
            mediaPlayer = new MediaPlayer();
            mediaPlayer.setDataSource(this, alert);
            mediaPlayer.setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            );
            mediaPlayer.setLooping(true);
            mediaPlayer.prepare();
            mediaPlayer.start();
            Log.d(DIAG_TAG, "[Ringtone] MediaPlayer started at " + System.currentTimeMillis());
        } catch (Exception e) {
            Log.e(DIAG_TAG, "[Ringtone] Error starting ringtone", e);
        }
    }

    private void stopRingtoneOnly() {
        if (mediaPlayer != null) {
            try {
                if (mediaPlayer.isPlaying()) {
                    mediaPlayer.stop();
                }
                mediaPlayer.release();
            } catch (Exception ignored) {}
            mediaPlayer = null;
            Log.d(DIAG_TAG, "[Ringtone] MediaPlayer stopped/released at " + System.currentTimeMillis());
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(DIAG_TAG, "[Service.onDestroy] at " + System.currentTimeMillis());
        stopRingtoneOnly();
        isRingingActive = false;
        SpikePlugin.notifyInterruptionState(false);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}