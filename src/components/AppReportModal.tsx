import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { invokeFn } from "../utils/listings";

const REASONS = [
  { value: "child_safety", label: "Child safety concern" },
  { value: "sexual_content", label: "Sexual or explicit content" },
  { value: "violence_hate", label: "Violence, hate or harassment" },
  { value: "harassment", label: "Bullying or harassment of me" },
  { value: "privacy", label: "People shown without consent" },
  { value: "spam_scam", label: "Spam or scam" },
  { value: "feedback", label: "General feedback / other" },
];

// In-app report/feedback dialog (mobile app). Sent to contact@mems-app.com by
// the report-app-content function without leaving the app.
export default function AppReportModal({
  visible,
  onClose,
  context,
  ownerId,
  collectionName,
}: {
  visible: boolean;
  onClose: () => void;
  context: "collection" | "photo" | "general";
  ownerId?: string | null;
  collectionName?: string | null;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function close() {
    onClose();
    setTimeout(() => {
      setReason(null);
      setDetails("");
      setError(null);
      setSent(false);
    }, 300);
  }

  async function submit() {
    if (!reason) {
      setError("Please choose a reason.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await invokeFn("report-app-content", {
        context,
        reason,
        details: details.trim(),
        ownerId: ownerId ?? undefined,
        collectionName: collectionName ?? undefined,
      });
      setSent(true);
    } catch (e: any) {
      setError(e?.message ?? "Could not send your report.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    context === "general" ? "Report or send feedback" : context === "photo" ? "Report this photo" : "Report this collection";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={close} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>
          {sent ? (
            <View style={{ gap: 14 }}>
              <Text style={styles.body}>
                Thank you. Your report has been sent to the Picture Board team and we'll review it.
              </Text>
              <TouchableOpacity style={styles.primary} onPress={close}>
                <Text style={styles.primaryText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled">
                <Text style={styles.label}>What's wrong?</Text>
                {REASONS.map((r) => (
                  <TouchableOpacity key={r.value} style={styles.reasonRow} onPress={() => setReason(r.value)}>
                    <View style={[styles.radio, reason === r.value && styles.radioOn]}>
                      {reason === r.value && <View style={styles.radioDot} />}
                    </View>
                    <Text style={styles.reasonText}>{r.label}</Text>
                  </TouchableOpacity>
                ))}
                <Text style={styles.label}>Details {reason === "feedback" ? "" : "(optional)"}</Text>
                <TextInput
                  style={styles.input}
                  value={details}
                  onChangeText={setDetails}
                  multiline
                  maxLength={1500}
                  placeholder="Tell us more so we can review it"
                  placeholderTextColor="#999"
                />
              </ScrollView>
              <View style={{ paddingTop: 8 }}>
                {error && <Text style={styles.error}>{error}</Text>}
                <TouchableOpacity style={styles.primary} onPress={submit} disabled={busy}>
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Send report</Text>}
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 20 },
  card: { backgroundColor: "#fff", borderRadius: 12, padding: 20, maxHeight: "88%" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  title: { fontSize: 18, fontWeight: "700", color: "#111" },
  close: { fontSize: 20, color: "#666" },
  body: { fontSize: 15, color: "#333", lineHeight: 21 },
  label: { fontSize: 13, fontWeight: "600", color: "#555", marginTop: 12, marginBottom: 6 },
  reasonRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: "#999", alignItems: "center", justifyContent: "center" },
  radioOn: { borderColor: "#111" },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#111" },
  reasonText: { fontSize: 15, color: "#222", flex: 1 },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10, fontSize: 15, color: "#111", minHeight: 80, textAlignVertical: "top" },
  error: { color: "#c0392b", fontSize: 14, marginBottom: 8 },
  primary: { backgroundColor: "#111", borderRadius: 999, paddingVertical: 13, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
