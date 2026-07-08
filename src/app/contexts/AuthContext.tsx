import { Session } from "@supabase/supabase-js";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "../utils/supabase";

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  // Increments every time a fresh, validated session becomes available —
  // screens can watch this instead of `session` object identity, which
  // can be misleading (Supabase sometimes emits new session objects with
  // unchanged tokens on TOKEN_REFRESHED events)
  sessionVersion: number;
};

const AuthContext = createContext<AuthContextValue>({
  session: null,
  loading: true,
  sessionVersion: 0,
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionVersion, setSessionVersion] = useState(0);
  // Prevents a slow, stale validation response from clobbering a newer,
  // already-settled state — e.g. if getUser() takes a while and the user
  // signs out in the meantime
  const validationTokenRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function initialise() {
      // ── Step 1 — read whatever session is cached locally ──────
      const {
        data: { session: localSession },
      } = await supabase.auth.getSession();

      if (!localSession) {
        if (!cancelled) {
          setSession(null);
          setLoading(false);
        }
        return;
      }

      // ── Step 2 — validate it against Supabase's server ────────
      // getSession() only reads local storage — it does NOT confirm the
      // session is still valid server-side. A locally-cached session can
      // be stale (revoked, deleted account, expired refresh token) while
      // still "looking" valid to getSession(). getUser() makes a real
      // network call and is the only way to know for certain.
      //
      // This directly fixes users landing on the home screen without a
      // genuinely valid session — a stale-but-present local session was
      // previously enough to pass every check in the app.
      const myToken = ++validationTokenRef.current;
      const { data: userData, error: userError } =
        await supabase.auth.getUser();

      if (cancelled || myToken !== validationTokenRef.current) return;

      if (userError || !userData?.user) {
        console.warn(
          "[Auth] Local session failed server validation — signing out:",
          userError?.message,
        );
        await supabase.auth.signOut();
        setSession(null);
        setLoading(false);
        return;
      }

      setSession(localSession);
      setSessionVersion((v) => v + 1);
      setLoading(false);
    }

    initialise();

    // ── Single, app-wide listener for all subsequent auth changes ──
    // Every screen reacts to changes through this ONE subscription via
    // context, rather than each maintaining its own independent state
    // that can drift out of sync with everyone else's.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      console.log(
        "[Auth] State change:",
        event,
        newSession ? "session present" : "no session",
      );
      setSession(newSession);
      setSessionVersion((v) => v + 1);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ session, loading, sessionVersion }}>
      {children}
    </AuthContext.Provider>
  );
}
