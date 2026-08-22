// A real date picker for a collection's "memory date" — replaces the old
// free-text DD/MM/YYYY TextInput trio (see src/utils/memoryDate.ts's
// buildIsoDateFromParts, still exported but no longer called from the UI)
// with an actual calendar widget on every platform, so it's structurally
// impossible to type something like "31/02/2024" in the first place.
//
// - Web: a plain HTML <input type="date"> — the browser renders its own
//   native date picker and refuses to produce an invalid date at all.
// - iOS: @react-native-community/datetimepicker in "compact" display,
//   which renders Apple's own small inline control (tap to open a wheel
//   picker) — no show/hide state needed, unlike Android below.
// - Android: the same library, but Android has no inline display mode —
//   it's an imperative dialog, so this wraps it in a tappable field that
//   opens/closes it.
//
// Requires a native rebuild (`expo prebuild`) the first time it's added,
// since @react-native-community/datetimepicker ships a native module —
// this is the trade-off memoryDate.ts's old comment explicitly avoided by
// staying dependency-free, and it's the intentional choice being made here.
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { useState } from "react";
import { Platform, StyleSheet, Text, TouchableOpacity } from "react-native";
import {
  getMemoryDateInfo,
  isoDateToJsDate,
  jsDateToIsoDate,
} from "../utils/memoryDate";

type Props = {
  // Plain "YYYY-MM-DD", or null when no date has been chosen yet.
  value: string | null;
  onChange: (iso: string | null) => void;
  placeholder?: string;
  // "When did this happen" rarely makes sense as a future date — pass
  // null to allow any date if that's ever not true for a caller.
  maximumDate?: Date | null;
};

export default function MemoryDatePicker({
  value,
  onChange,
  placeholder = "Select a date",
  maximumDate = new Date(),
}: Props) {
  const [showAndroidPicker, setShowAndroidPicker] = useState(false);

  const displayText = value
    ? (getMemoryDateInfo(value)?.full ?? placeholder)
    : placeholder;
  const dateForPicker = (value ? isoDateToJsDate(value) : null) ?? new Date();

  if (Platform.OS === "web") {
    // Raw DOM element — react-native-web renders this directly in the web
    // bundle. It never executes on native (this whole branch is skipped
    // there at runtime), so it's safe despite not being a React Native
    // host component.
    return (
      <input
        type="date"
        value={value ?? ""}
        max={maximumDate ? jsDateToIsoDate(maximumDate) : undefined}
        onChange={(e: any) => onChange(e.target.value ? e.target.value : null)}
        style={webInputStyle}
      />
    );
  }

  if (Platform.OS === "ios") {
    return (
      <DateTimePicker
        value={dateForPicker}
        mode="date"
        display="compact"
        themeVariant="light"
        maximumDate={maximumDate ?? undefined}
        onChange={(_event: DateTimePickerEvent, selectedDate?: Date) => {
          if (selectedDate) onChange(jsDateToIsoDate(selectedDate));
        }}
      />
    );
  }

  // Android — no inline display mode, so this is a tappable field that
  // opens the OS's own date dialog on press.
  return (
    <>
      <TouchableOpacity
        style={styles.field}
        onPress={() => setShowAndroidPicker(true)}
        activeOpacity={0.7}
      >
        <Text style={[styles.fieldText, !value && styles.placeholderText]}>
          {displayText}
        </Text>
        <Ionicons name="calendar-outline" size={18} color="#999" />
      </TouchableOpacity>
      {showAndroidPicker && (
        <DateTimePicker
          value={dateForPicker}
          mode="date"
          display="default"
          maximumDate={maximumDate ?? undefined}
          onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
            setShowAndroidPicker(false);
            if (event.type === "set" && selectedDate) {
              onChange(jsDateToIsoDate(selectedDate));
            }
          }}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 14,
  },
  fieldText: { fontSize: 16, color: "#111" },
  placeholderText: { color: "#999" },
});

// Browsers render their own chrome for <input type="date"> (including the
// calendar-icon affordance), so this only needs to get the box itself
// looking consistent with the rest of the app's form fields.
//
// `width: "100%"` alone isn't enough on mobile browsers: a native
// <input type="date"> has its own intrinsic minimum content width (the
// day/month/year segments plus the calendar-icon affordance), and as a
// flex item its default `min-width` is `auto` — meaning the browser lets
// it keep that intrinsic width rather than shrink to fit, which is
// exactly what made it spill past the edge of the screen on narrow
// mobile viewports even though its parent was already full-width.
// `minWidth: 0` overrides that default so it actually respects `width`,
// and `maxWidth: "100%"` is a hard ceiling as a second line of defence.
const webInputStyle: any = {
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 14,
  fontSize: 16,
  color: "#111",
  fontFamily: "inherit",
  width: "100%",
  minWidth: 0,
  maxWidth: "100%",
  boxSizing: "border-box",
  display: "block",
};
