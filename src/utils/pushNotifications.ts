import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { supabase } from "./supabase";

// ── Push registration (Android app only) ─────────────────────────────────
// Registers this device's Expo push token against the signed-in account so
// the server can send the "create your first collection" nudges (see
// supabase/functions/send-collection-nudge). Web never registers, which is
// what keeps these pushes limited to people with the mobile app. iOS isn't
// shipped yet, so it's skipped too — remove the Android-only check below
// when it is (and add APNs credentials in EAS).
//
// Permission: asked once per account per device, the first time we get
// here after onboarding is done. If they decline we never ask again (the
// OS also stops showing the prompt after repeated denials). If permission
// was already granted, we just silently refresh the token each launch.

const CHANNEL_ID = "default";
const PROMPTED_KEY_PREFIX = "mems-push-prompted:";
const TOKEN_KEY = "mems-push-token";

// One attempt per user per app session — the caller's effect re-runs as
// routes change, this keeps it from re-hitting the network each time.
const attemptedThisSession = new Set<string>();

export async function registerForPushNotifications(
  userId: string,
): Promise<void> {
  const log = (msg: string) => {
    if (__DEV__) console.log(`[push] ${msg}`);
  };

  if (Platform.OS !== "android") return;
  // Emulators are skipped in release builds. In dev builds they're allowed
  // so registration can be tested on an AVD that has Google Play services
  // (a "Google Play" system image) — those can receive FCM pushes.
  if (!Device.isDevice && !__DEV__) return;
  if (attemptedThisSession.has(userId)) {
    log("already attempted this session, skipping");
    return;
  }
  attemptedThisSession.add(userId);
  log(`starting registration (isDevice=${Device.isDevice})`);

  try {
    // On Android 13+ the permission prompt only appears once a
    // notification channel exists.
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Reminders",
      importance: Notifications.AndroidImportance.DEFAULT,
    });

    const promptedKey = PROMPTED_KEY_PREFIX + userId;
    let { status } = await Notifications.getPermissionsAsync();

    log(`permission status: ${status}`);
    if (status !== "granted") {
      const alreadyPrompted = await AsyncStorage.getItem(promptedKey);
      if (alreadyPrompted) {
        log("permission not granted and we already asked once; not asking again");
        return;
      }
      await AsyncStorage.setItem(promptedKey, "1");
      ({ status } = await Notifications.requestPermissionsAsync());
      log(`permission after prompt: ${status}`);
    }
    if (status !== "granted") return;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    if (!projectId) throw new Error("Missing EAS projectId");

    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId,
    });

    const { error } = await supabase.rpc("register_push_token", {
      p_token: token,
      p_platform: "android",
    });
    if (error) throw error;

    log("token registered with server");
    AsyncStorage.setItem(TOKEN_KEY, token).catch(() => {});
  } catch (error: any) {
    // Never let push setup affect the app — the nudge is a nice-to-have.
    // Not retried until the next app launch: the caller's effect re-runs on
    // every route change, and a persistent failure (e.g. a build without
    // Firebase configured) would otherwise hammer the network each time.
    console.warn("registerForPushNotifications error:", error?.message);
  }
}

// Call BEFORE signing out (needs the session to authorise the delete) so a
// signed-out device stops receiving that account's notifications.
export async function unregisterPushToken(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    await supabase.rpc("unregister_push_token", { p_token: token });
    await AsyncStorage.removeItem(TOKEN_KEY);
    attemptedThisSession.clear();
  } catch (error: any) {
    console.warn("unregisterPushToken error:", error?.message);
  }
}
