import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { type ColorValue, PlatformColor, StyleSheet, Text, type TextProps, View } from "react-native";

// iOS semantic colors: they follow Dark Mode and Increase Contrast by themselves.
export const C = {
  label: PlatformColor("label"),
  secondaryLabel: PlatformColor("secondaryLabel"),
  background: PlatformColor("systemGroupedBackground"),
  field: PlatformColor("secondarySystemGroupedBackground"),
  fill: PlatformColor("tertiarySystemFill"),
  tint: PlatformColor("systemBlue"),
  red: PlatformColor("systemRed"),
};
// packages/ui/src/tokens.css: Eyes yellow, only as a fill under a black label.
export const YELLOW = "#ffd60a";

// Dynamic Type text styles: the base size grows with the user's text size setting.
const TYPE = StyleSheet.create({
  title2: { fontSize: 22, fontWeight: "700" },
  headline: { fontSize: 17, fontWeight: "600" },
  body: { fontSize: 17 },
  subheadline: { fontSize: 15 },
  footnote: { fontSize: 13 },
});

export function Type({
  ramp = "body",
  color = C.label,
  style,
  ...p
}: TextProps & { ramp?: keyof typeof TYPE; color?: ColorValue }) {
  return <Text dynamicTypeRamp={ramp} {...p} style={[TYPE[ramp], { color }, style]} />;
}

// HIG "content unavailable": a symbol, a title and one line that says what will show here.
export function EmptyState(p: { symbol: SymbolViewProps["name"]; title: string; message: string }) {
  return (
    <View style={s.empty}>
      <SymbolView name={p.symbol} size={56} tintColor={C.secondaryLabel} />
      <Type ramp="title2" accessibilityRole="header" style={s.center}>
        {p.title}
      </Type>
      <Type color={C.secondaryLabel} style={s.center}>
        {p.message}
      </Type>
    </View>
  );
}

const s = StyleSheet.create({
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    gap: 8,
    backgroundColor: C.background,
  },
  center: { textAlign: "center" },
});
