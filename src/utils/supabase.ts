import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const ExpoSecureStoreAdapter = {
  getItem: (key: string) => {
    if (Platform.OS === "web") {
      if (typeof localStorage === "undefined") return Promise.resolve(null);
      return Promise.resolve(localStorage.getItem(key));
    }
    return SecureStore.getItemAsync(key);
  },
  setItem: (key: string, value: string) => {
    if (Platform.OS === "web") {
      if (typeof localStorage === "undefined") return Promise.resolve();
      localStorage.setItem(key, value);
      return Promise.resolve();
    }
    return SecureStore.setItemAsync(key, value);
  },
  removeItem: (key: string) => {
    if (Platform.OS === "web") {
      if (typeof localStorage === "undefined") return Promise.resolve();
      localStorage.removeItem(key);
      return Promise.resolve();
    }
    return SecureStore.deleteItemAsync(key);
  },
};

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

function createSupabaseClient(): SupabaseClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      flowType: "pkce",
      storage: ExpoSecureStoreAdapter,
      autoRefreshToken: true,
      persistSession: true,
      // Required for web — this is what lets Supabase automatically catch
      // the OAuth redirect back from Google on the web login flow (which
      // does a full-page redirect rather than the native in-app browser
      // flow) and exchange the PKCE code for a session. Native handles
      // its own redirect separately via the mems:// deep link listener
      // in app/_layout.tsx, where this setting has no effect since
      // there's no `window` on native.
      detectSessionInUrl: true,
    },
  });
}

// ── Fast-Refresh-safe singleton ──────────────────────────────────
// Without this, Metro's Fast Refresh re-evaluates this module on every
// relevant file save during development, calling createClient() again
// each time. Each new client instance runs its OWN autoRefreshToken
// timer against the SAME underlying stored session — when one client
// refreshes and writes the new token to storage, every other still-alive
// instance detects that write and treats it as a reason to refresh
// again too, cascading into dozens of rapid TOKEN_REFRESHED events
// until the session gets exhausted and is force signed-out.
//
// Caching the instance on `globalThis` guarantees Fast Refresh reuses
// the exact same client rather than creating a new one. This has no
// effect on production builds, where the module only ever evaluates
// once regardless — it specifically targets the dev-mode symptom.
declare global {
  // eslint-disable-next-line no-var
  var __supabaseClient: SupabaseClient | undefined;
}

export const supabase: SupabaseClient =
  globalThis.__supabaseClient ?? createSupabaseClient();

if (!globalThis.__supabaseClient) {
  globalThis.__supabaseClient = supabase;
}