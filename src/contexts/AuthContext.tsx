import { Session } from "@supabase/supabase-js";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "../utils/supabase";

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
};

const AuthContext = createContext<AuthContextValue>({
  session: null,
  loading: true,
});

export function useAuth() {
  return useContext(AuthContext);
}

// ── IMPORTANT — read this before using `session` in a dependency array ──
//
// Supabase constructs a BRAND NEW session object on every single auth
// event, including routine TOKEN_REFRESHED events that happen
// automatically in the background and don't represent any actual change
// from the app's perspective — same user, just a freshly rotated token.
//
// If a screen depends on the `session` OBJECT itself (e.g. `[session]` in
// a useEffect/useCallback dependency array), React sees a new object
// reference on every refresh and treats it as a change — even though
// nothing meaningful changed. This was the exact cause of collections
// visibly disappearing and reloading on every token refresh: the fetch
// effect was re-triggering constantly, flipping `loading` back to true
// and hiding the grid, purely because of object identity churn that had
// nothing to do with the actual data needing to be refetched.
//
// The fix: depend on `session?.user?.id` instead — a plain string that
// only changes on a GENUINE sign-in or sign-out. It stays referentially
// stable (by value, via ===) across any number of token refreshes for
// the same signed-in user, so effects keyed on it only re-run when they
// actually should. This also means components essentially never need
// the full session object for anything other than reading a couple of
// stable fields off `.user` — the access token itself doesn't need to
// flow through React state at all, since supabase.functions.invoke()
// and every other client method reads the current token directly from
// the Supabase client's own internal session management, independent
// of whatever this context is holding.
//
// Rule of thumb for any new screen:
//   ✅ useEffect(() => {...}, [session?.user?.id])
//   ❌ useEffect(() => {...}, [session])
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Single subscription — the only auth call this app makes.
    // onAuthStateChange fires an INITIAL_SESSION event immediately upon
    // subscribing, carrying whatever session Supabase already has loaded
    // from storage — sufficient on its own, no separate getSession()/
    // getUser() calls needed on top of it.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      console.log(
        "[Auth] State change:",
        event,
        newSession ? "session present" : "no session",
      );
      setSession(newSession);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{ session, loading }}>
      {children}
    </AuthContext.Provider>
  );
}
