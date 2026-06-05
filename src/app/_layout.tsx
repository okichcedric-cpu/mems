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

  useEffect(() => {
    // Handle deep links for mobile subscription callback
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
    // Inject CSS for web to disable image dragging
    if (Platform.OS === "web") {
      const style = document.createElement("style");
      style.textContent = `
        img {
          -webkit-user-drag: none;
          user-drag: none;
          user-select: none;
          -webkit-user-select: none;
          pointer-events: none;
        }
      `;
      document.head.appendChild(style);
      return () => {
        document.head.removeChild(style);
      };
    }
  }, []);

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
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (loading) return;
    if (segments.length === 0) return;
    const inAuthGroup = segments[0] === "login";
    if (!session && !inAuthGroup) router.replace("/login");
    if (session && inAuthGroup) router.replace("/");
  }, [session, segments, loading]);

  if (loading) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View
          style={{ flex: 1, justifyContent: "center", alignItems: "center" }}
        >
          <ActivityIndicator size="large" color="#000" />
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
