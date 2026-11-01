import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "../contexts/AuthContext";
import { REPORT_REASONS, reportListing } from "../utils/listings";

// "Report" dialog for marketplace content. Reports are emailed to the Mems
// team (contact@mems-app.com) by the report-content function.
export default function ReportModal({
  visible,
  onClose,
  listingId,
  photoIndex = null,
}: {
  visible: boolean;
  onClose: () => void;
  listingId: string;
  // null = the whole listing; otherwise the 0-based preview photo.
  photoIndex?: number | null;
}) {
  const { session } = useAuth();
  const [reason, setReason] = useState<string | null>(null);
  const [details, setDetails] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function close() {
    onClose();
    // Reset after the close animation so the next report starts clean.
    setTimeout(() => {
      setReason(null);
      setDetails("");
      setEmail("");
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
      await reportListing({
        listingId,
        reason,
        details: details.trim(),
        photoIndex,
        email: session ? undefined : email.trim() || undefined,
      });
      setSent(true);
    } catch (e: any) {
      setError(e?.message ?? "Could not send your report.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>
              {photoIndex === null ? "Report this collection" : "Report this photo"}
            </Text>
            <TouchableOpacity onPress={close} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>

          {sent ? (
            <View style={{ gap: 14 }}>
              <Text style={styles.body}>
                Thank you. Your report has been sent to the Mems team and we'll review it.
              </Text>
              <TouchableOpacity style={styles.primary} onPress={close}>
                <Text style={styles.primaryText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled">
                <Text style={styles.label}>What's wrong?</Text>
                {REPORT_REASONS.map((r) => (
                  <TouchableOpacity
                    key={r.value}
                    style={styles.reasonRow}
                    onPress={() => setReason(r.value)}
                  >
                    <View style={[styles.radio, reason === r.value && styles.radioOn]}>
                      {reason === r.value && <View style={styles.radioDot} />}
                    </View>
                    <Text style={styles.reasonText}>{r.label}</Text>
                  </TouchableOpacity>
                ))}

                <Text style={styles.label}>Details (optional)</Text>
                <TextInput
                  style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
                  value={details}
                  onChangeText={setDetails}
                  multiline
                  maxLength={1000}
                  placeholder="Tell us more so we can review it"
                  placeholderTextColor="#999"
                />

                {!session && (
                  <>
                    <Text style={styles.label}>Your email (optional)</Text>
                    <TextInput
                      style={styles.input}
                      value={email}
                      onChangeText={setEmail}
                      autoCapitalize="none"
                      keyboardType="email-address"
                      placeholder="So we can follow up"
                      placeholderTextColor="#999"
                    />
                  </>
                )}
              </ScrollView>

              <View style={{ paddingTop: 4 }}>
                {error && <Text style={styles.error}>{error}</Text>}
                <TouchableOpacity style={styles.primary} onPress={submit} disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.primaryText}>Send report</Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: { backgroundColor: "#fff", borderRadius: 2, padding: 20, width: "100%", maxWidth: 440, maxHeight: "92%" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  title: { fontFamily: "Caveat_700Bold", fontSize: 30, color: "#222" },
  close: { fontSize: 18, color: "#666" },
  body: { fontSize: 15, color: "#444", lineHeight: 22 },
  label: { fontSize: 13, fontWeight: "600", color: "#111", marginTop: 12, marginBottom: 4 },
  reasonRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#999",
    alignItems: "center",
    justifyContent: "center",
  },
  radioOn: { borderColor: "#111" },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#111" },
  reasonText: { fontSize: 15, color: "#222", flex: 1 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#111",
  },
  error: { color: "#c0392b", fontSize: 14, marginTop: 6 },
  primary: {
    backgroundColor: "#111",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 10,
  },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
