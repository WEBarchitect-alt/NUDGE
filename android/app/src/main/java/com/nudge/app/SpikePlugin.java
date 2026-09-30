package com.nudge.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
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

@CapacitorPlugin(name = "SpikePlugin")
public class SpikePlugin extends Plugin {
    private static final String TAG = "SpikePlugin";
    private static final String DIAG_TAG = "NudgeAlarmDebug";
    public static SpikePlugin instance;

    @Override
    public void load() {
        super.load();
        instance = this;
        Log.d(DIAG_TAG, "[10.1] SpikePlugin loaded at " + System.currentTimeMillis() + " (instance assigned)");
    }

    public static SpikePlugin getInstance() {
        return instance;
    }

    private PendingIntent getAlarmPendingIntent(long targetMillis) {
        Intent intent = new Intent(getContext(), AlarmReceiver.class);
        intent.setAction("com.nudge.app.ACTION_SPIKE_ALARM");
        intent.putExtra("EXPECTED_TRIGGER_MILLIS", targetMillis);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(getContext(), 0, intent, flags);
    }

    @PluginMethod
    public void scheduleSpike(com.getcapacitor.PluginCall call) {
        long now = System.currentTimeMillis();
        Long triggerAtMillis = call.getLong("triggerAtMillis");
        Integer delaySeconds = call.getInt("delaySeconds");

        long targetMillis;
        if (triggerAtMillis != null && triggerAtMillis > 0) {
            targetMillis = triggerAtMillis;
        } else if (delaySeconds != null && delaySeconds > 0) {
            targetMillis = now + (delaySeconds * 1000L);
        } else {
            call.reject("Must provide either triggerAtMillis or delaySeconds");
            return;
        }

        long calculatedDelay = targetMillis - now;

        if (targetMillis <= now) {
            Log.w(DIAG_TAG, "[1.0] Rejecting past target: targetMillis=" + targetMillis + " now=" + now);
            call.reject("Target time must be in the future");
            return;
        }

        Context context = getContext();
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);

        if (alarmManager == null) {
            call.reject("AlarmManager unavailable");
            return;
        }

        boolean canScheduleExact = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            canScheduleExact = alarmManager.canScheduleExactAlarms();
        }

        Log.d(DIAG_TAG, "[1.1] SpikePlugin.scheduleSpike: now=" + now 
            + " targetMillis=" + targetMillis 
            + " calculatedDelayMs=" + calculatedDelay 
            + " canScheduleExact=" + canScheduleExact 
            + " API=" + (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? "setExactAndAllowWhileIdle" : "setExact"));

        PendingIntent pendingIntent = getAlarmPendingIntent(targetMillis);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, targetMillis, pendingIntent);
            } else {
                alarmManager.setExact(AlarmManager.RTC_WAKEUP, targetMillis, pendingIntent);
            }
            Log.d(DIAG_TAG, "[1.2] AlarmManager call succeeded for targetMillis=" + targetMillis);
            call.resolve();
        } catch (SecurityException e) {
            Log.e(DIAG_TAG, "[1.3] SecurityException while scheduling exact alarm", e);
            call.reject("Failed to schedule alarm: " + e.getMessage());
        }
    }

    @PluginMethod
    public void cancelSpike(com.getcapacitor.PluginCall call) {
        Context context = getContext();
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
            PendingIntent pendingIntent = getAlarmPendingIntent(0);
            alarmManager.cancel(pendingIntent);
            Log.d(DIAG_TAG, "[SpikePlugin.cancelSpike] at " + System.currentTimeMillis());
        }
        call.resolve();
    }

    @PluginMethod
    public void isInterruptionActive(com.getcapacitor.PluginCall call) {
        boolean active = NudgeRingingService.isInterruptionActive();
        JSObject ret = new JSObject();
        ret.put("active", active);
        call.resolve(ret);
    }

    @PluginMethod
    public void dismissInterruption(com.getcapacitor.PluginCall call) {
        Log.d(DIAG_TAG, "[SpikePlugin.dismissInterruption] at " + System.currentTimeMillis());
        Context context = getContext();
        Intent stopIntent = new Intent(context, NudgeRingingService.class);
        stopIntent.setAction(NudgeRingingService.ACTION_STOP_RINGTONE);
        context.startService(stopIntent);
        call.resolve();
    }

    @PluginMethod
    public void finishSession(com.getcapacitor.PluginCall call) {
        Log.d(DIAG_TAG, "[SpikePlugin.finishSession] at " + System.currentTimeMillis());
        Context context = getContext();
        Intent stopIntent = new Intent(context, NudgeRingingService.class);
        context.stopService(stopIntent);
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    getActivity().setShowWhenLocked(false);
                    getActivity().setTurnScreenOn(false);
                }
            });
        }
        call.resolve();
    }

    public static void notifyInterruptionState(boolean active) {
        long now = System.currentTimeMillis();
        boolean hasInstance = (instance != null);
        Log.d(DIAG_TAG, "[10.0] SpikePlugin.notifyInterruptionState: now=" + now 
            + " active=" + active 
            + " hasInstance=" + hasInstance);

        if (hasInstance) {
            JSObject ret = new JSObject();
            ret.put("active", active);
            instance.notifyListeners("interruptionStateChange", ret);
            Log.d(DIAG_TAG, "[10.2] notifyListeners('interruptionStateChange') called at " + now);
        } else {
            Log.w(DIAG_TAG, "[10.3] WARNING: SpikePlugin.instance is NULL! Cannot notify JS listener.");
        }
    }

    public void notifyStateChange(boolean active) {
        notifyInterruptionState(active);
    }
}