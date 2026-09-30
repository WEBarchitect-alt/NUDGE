package com.nudge.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.content.ContextCompat;

public class AlarmReceiver extends BroadcastReceiver {
    private static final String DIAG_TAG = "NudgeAlarmDebug";

    @Override
    public void onReceive(Context context, Intent intent) {
        long now = System.currentTimeMillis();
        long expectedTrigger = intent != null ? intent.getLongExtra("EXPECTED_TRIGGER_MILLIS", -1) : -1;
        long delta = expectedTrigger > 0 ? (now - expectedTrigger) : -1;

        Log.d(DIAG_TAG, "[2.0] AlarmReceiver.onReceive triggered: now=" + now 
            + " expectedTrigger=" + expectedTrigger 
            + " deltaMs=" + delta 
            + " action=" + (intent != null ? intent.getAction() : "null"));

        Intent serviceIntent = new Intent(context, NudgeRingingService.class);
        if (intent != null && intent.getAction() != null) {
            serviceIntent.setAction(intent.getAction());
        }
        serviceIntent.putExtra("EXPECTED_TRIGGER_MILLIS", expectedTrigger);
        serviceIntent.putExtra("RECEIVER_RECEIVED_TIME", now);

        Log.d(DIAG_TAG, "[3.0] AlarmReceiver: immediately before ContextCompat.startForegroundService at " + System.currentTimeMillis());

        try {
            ContextCompat.startForegroundService(context, serviceIntent);
            Log.d(DIAG_TAG, "[3.1] AlarmReceiver: startForegroundService call succeeded at " + System.currentTimeMillis());
        } catch (Exception e) {
            Log.e(DIAG_TAG, "[3.2] AlarmReceiver: FAILED to startForegroundService", e);
        }
    }
}