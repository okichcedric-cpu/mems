import { Alert, Platform } from "react-native";

type AlertButton = {
  text: string;
  onPress?: () => void;
  style?: "default" | "cancel" | "destructive";
};

// ── Cross-platform alert ────────────────────────────────────────────────
// react-native-web's Alert.alert() is a complete no-op:
//   node_modules/react-native-web/.../exports/Alert/index.js
//     class Alert { static alert() {} }
// It doesn't throw, doesn't warn, doesn't fall back to anything — it just
// silently does nothing. Every plain Alert.alert(...) call in this app
// was therefore invisible on web, including mobile browsers. That's what
// made a real, correctly-detected error (a plan limit, a duplicate name,
// an upload failure, whatever) look like "I tapped Create and literally
// nothing happened" — the code was doing exactly what it was told to,
// the notification just never rendered.
//
// This wraps Alert.alert with a web fallback (window.alert / confirm) so
// the same call site works on every platform without every screen having
// to remember the `Platform.OS === "web" ? window.alert(...) :
// Alert.alert(...)` branch individually (a few older screens do this
// inline already — this centralizes that pattern instead of repeating it).
export function showAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
): void {
  if (Platform.OS !== "web") {
    Alert.alert(title, message, buttons);
    return;
  }

  const fullText = message ? `${title}\n\n${message}` : title;

  if (!buttons || buttons.length === 0) {
    window.alert(fullText);
    return;
  }

  if (buttons.length === 1) {
    window.alert(fullText);
    buttons[0].onPress?.();
    return;
  }

  // More than one button — window.confirm only offers a yes/no choice,
  // so this maps whichever button is marked "cancel" to Cancel, and the
  // other one to OK/proceed. That covers every multi-button alert this
  // app actually shows (a dismiss vs. a single specific action, e.g.
  // "OK" vs. "View Plans") without trying to replicate arbitrary
  // N-button native alerts in a browser.
  const cancelButton = buttons.find((b) => b.style === "cancel");
  const actionButton = buttons.find((b) => b !== cancelButton) ?? buttons[0];
  const confirmed = window.confirm(fullText);
  if (confirmed) {
    actionButton?.onPress?.();
  } else {
    cancelButton?.onPress?.();
  }
}
