import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { ReactNode, useState } from "react";
import {
  Image as RNImage,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../utils/supabase";
import AlbumBackground from "./AlbumBackground";

// Shared frame for every public marketplace screen. The header bar is the
// same as the app's home screen (home icon, centred logo, profile menu);
// `plain` gives the landing page the app home's flat white background,
// while inner pages use the album paper texture, mirroring how the app
// treats its home screen versus the inside of a collection.
export default function MarketplaceShell({
  title,
  children,
  plain = false,
}: {
  title: string;
  children: ReactNode;
  plain?: boolean;
}) {
  const router = useRouter();
  const { session } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  function go(path: string) {
    setMenuOpen(false);
    router.push(path as any);
  }

  // Home = the main app landing page (my collections). Sessions are per
  // hostname, so from the marketplace host this hops to the main site.
  function openMemories() {
    setMenuOpen(false);
    if (Platform.OS === "web" && window.location.hostname.startsWith("marketplace.")) {
      window.location.href = `${window.location.protocol}//${window.location.hostname.replace(
        /^marketplace\./,
        "www.",
      )}`;
    } else {
      router.push("/" as any);
    }
  }

  async function signOut() {
    setMenuOpen(false);
    await supabase.auth.signOut();
  }

  const body = (
    <>
      <Stack.Screen options={{ title }} />

      <View style={styles.header}>
        <View style={styles.headerSide}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={openMemories}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Home"
          >
            <Ionicons name="home-outline" size={22} color="#111" />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.headerCenter}
          onPress={() => router.push("/marketplace" as any)}
        >
          <RNImage
            source={require("@/assets/images/logo.png")}
            style={styles.headerLogo}
            resizeMode="contain"
          />
        </TouchableOpacity>

        <View style={[styles.headerSide, { justifyContent: "flex-end" }]}>
          {session ? (
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => setMenuOpen((v) => !v)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="person-circle-outline" size={24} color="#111" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.signInButton}
              onPress={() => go("/login?redirect=marketplace")}
            >
              <Text style={styles.signInText}>Sign in</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {menuOpen && (
        <>
          <TouchableOpacity
            style={styles.menuBackdrop}
            activeOpacity={1}
            onPress={() => setMenuOpen(false)}
          />
          <View style={styles.menu}>
            <TouchableOpacity style={styles.menuItem} onPress={() => go("/marketplace")}>
              <Ionicons name="storefront-outline" size={18} color="#333" />
              <Text style={styles.menuItemText}>Marketplace</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={() => go("/purchases")}>
              <Ionicons name="bag-check-outline" size={18} color="#333" />
              <Text style={styles.menuItemText}>My purchases</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={openMemories}>
              <Ionicons name="images-outline" size={18} color="#333" />
              <Text style={styles.menuItemText}>My memories</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={signOut}>
              <Ionicons name="log-out-outline" size={18} color="#333" />
              <Text style={styles.menuItemText}>Sign out</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.inner}>{children}</View>
      </ScrollView>
    </>
  );

  if (plain) return <View style={styles.plainRoot}>{body}</View>;
  return <AlbumBackground style={styles.root}>{body}</AlbumBackground>;
}

// Polaroid-style white card used for listings, creators and panels.
export const polaroid = StyleSheet.create({
  wrapper: {
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.16,
        shadowRadius: 8,
      },
      android: { elevation: 5 },
      web: { filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.16))" } as any,
    }),
  },
  card: {
    backgroundColor: "#fff",
    padding: 8,
    borderRadius: 2,
    ...Platform.select({
      web: {},
      default: { borderWidth: 1, borderColor: "rgba(0,0,0,0.1)" },
    }),
  },
});

export const marketplaceText = StyleSheet.create({
  heading: { fontFamily: "Caveat_700Bold", fontSize: 40, color: "#222", lineHeight: 44 },
  // Same small uppercase label the app uses above its home-screen sections.
  sectionLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  subheading: { fontFamily: "Caveat_700Bold", fontSize: 24, color: "#222" },
  body: { fontSize: 15, color: "#444", lineHeight: 22 },
  muted: { fontSize: 13, color: "#888" },
  link: { fontSize: 14, color: "#111", fontWeight: "600" },
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  plainRoot: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, paddingBottom: 60 },
  inner: { width: "100%", maxWidth: 900, alignSelf: "center", gap: 14 },

  // Header: mirrors the app home screen's bar.
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 12,
    paddingTop: Platform.OS === "web" ? 16 : 40,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    minHeight: 64,
    zIndex: 20,
  },
  headerSide: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  headerCenter: { alignItems: "center", justifyContent: "center" },
  headerLogo: { height: 56, width: 48 },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  signInButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#111",
  },
  signInText: { color: "#fff", fontSize: 13, fontWeight: "600" },

  // Profile dropdown: same look as the app's.
  menuBackdrop: { ...StyleSheet.absoluteFillObject, zIndex: 998 },
  menu: {
    position: "absolute",
    top: 64,
    right: 16,
    backgroundColor: "#fff",
    borderRadius: 14,
    paddingVertical: 6,
    minWidth: 200,
    zIndex: 999,
    borderWidth: 1,
    borderColor: "#eee",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.15,
        shadowRadius: 16,
      },
      android: { elevation: 12 },
      web: { boxShadow: "0 8px 28px rgba(0,0,0,0.15)" } as any,
    }),
  },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 16 },
  menuItemText: { fontSize: 14, color: "#333", fontWeight: "500" },
  menuDivider: { height: 1, backgroundColor: "#f0f0f0", marginVertical: 2 },
});
