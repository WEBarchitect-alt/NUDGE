package com.nudge.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String DIAG_TAG = "NudgeAlarmDebug";

    private final BroadcastReceiver interruptionEndedReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if ("com.nudge.app.ACTION_INTERRUPTION_ENDED".equals(intent.getAction())) {
                Log.d(DIAG_TAG, "[MainActivity] ACTION_INTERRUPTION_ENDED received at " + System.currentTimeMillis());
                dismissFullSession();
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SpikePlugin.class);
        registerPlugin(AudioCapturePlugin.class);
        super.onCreate(savedInstanceState);

        long now = System.currentTimeMillis();
        Intent intent = getIntent();
        boolean hasAlarmExtra = intent != null && intent.getBooleanExtra("TRIGGERED_BY_ALARM", false);
        Log.d(DIAG_TAG, "[8.0] MainActivity.onCreate: now=" + now 
            + " TRIGGERED_BY_ALARM=" + hasAlarmExtra 
            + " intentAction=" + (intent != null ? intent.getAction() : "null"));

        ContextCompat.registerReceiver(
            this,
            interruptionEndedReceiver,
            new IntentFilter("com.nudge.app.ACTION_INTERRUPTION_ENDED"),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        long now = System.currentTimeMillis();
        boolean hasAlarmExtra = intent != null && intent.getBooleanExtra("TRIGGERED_BY_ALARM", false);
        Log.d(DIAG_TAG, "[8.1] MainActivity.onNewIntent: now=" + now 
            + " TRIGGERED_BY_ALARM=" + hasAlarmExtra);
        if (NudgeRingingService.isInterruptionActive()) {
            applyLockScreenFlags();
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        long now = System.currentTimeMillis();
        boolean isInterruptionActive = NudgeRingingService.isInterruptionActive();
        Log.d(DIAG_TAG, "[9.0] MainActivity.onResume: now=" + now 
            + " isInterruptionActive=" + isInterruptionActive);

        if (isInterruptionActive) {
            applyLockScreenFlags();
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(DIAG_TAG, "[MainActivity.onDestroy] at " + System.currentTimeMillis());
        try {
            unregisterReceiver(interruptionEndedReceiver);
        } catch (IllegalArgumentException ignored) {}
    }

    public void applyLockScreenFlags() {
        Log.d(DIAG_TAG, "[MainActivity.applyLockScreenFlags] invoked at " + System.currentTimeMillis());
        runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            } else {
                getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                );
            }
        });
    }

    public void dismissFullSession() {
        Log.d(DIAG_TAG, "[MainActivity.dismissFullSession] invoked at " + System.currentTimeMillis());
        runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(false);
                setTurnScreenOn(false);
            } else {
                getWindow().clearFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                );
            }
        });
    }
}