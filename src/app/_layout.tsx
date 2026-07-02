import { Session } from "@supabase/supabase-js";
import * as Linking from "expo-linking";
import { Slot, useRouter, useSegments } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { supabase } from "../utils/supabase";

export default function RootLayout() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const segments = useSegments();

  // Handle deep links for mobile subscription callback
  useEffect(() => {
    if (Platform.OS !== "web") {
      const subscription = Linking.addEventListener("url", ({ url }) => {
        if (url.includes("subscription-callback")) {
          router.replace("/");
        }
      });
      return () => subscription.remove();
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.title = "Mems";
    }
  }, []);

  // Warm up edge functions on app start — prevents cold start delay for users
  useEffect(() => {
    if (session) {
      supabase.functions.invoke("check-subscription").catch(() => {});
    }
  }, [session]);

  // Inject global CSS on web
  useEffect(() => {
    if (Platform.OS === "web") {
      const style = document.createElement("style");
      style.textContent = `
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; }
        img {
          -webkit-user-drag: none;
          user-drag: none;
          user-select: none;
          -webkit-user-select: none;
        }
      `;
      document.head.appendChild(style);
      return () => {
        document.head.removeChild(style);
      };
    }
  }, []);

  // Listen for auth state changes
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setLoading(false);

      if (Platform.OS === "web" && typeof window !== "undefined") {
        const url = window.location.href;
        if (url.includes("access_token") || url.includes("refresh_token")) {
          window.history.replaceState(
            {},
            document.title,
            window.location.pathname,
          );
        }
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Handle routing based on session
  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === "login";
    const inPublicGroup =
      segments[0] === "terms" ||
      segments[0] === "privacy" ||
      segments[0] === "about" ||
      segments[0] === "subscription" ||
      segments[0] === "subscription-callback" ||
      segments[0] === "delete-account" ||
      segments[0] === "child-safety";

    if (!session && !inAuthGroup && !inPublicGroup) {
      // Not logged in and not on a public page — go to login
      router.replace("/login");
    } else if (session && inAuthGroup) {
      // Logged in but on login page — go to home
      router.replace("/");
    }
  }, [session, segments, loading]);

  // Show spinner while checking session
  if (loading) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: "#fff",
          }}
        >
          <ActivityIndicator size="large" color="#111" />
        </View>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Slot />
    </GestureHandlerRootView>
  );
}
