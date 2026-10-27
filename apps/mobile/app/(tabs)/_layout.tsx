import { NativeTabs } from "expo-router/native-tabs";
import { StyleSheet, Text, useColorScheme, View } from "react-native";

// packages/ui/src/tokens.css
export const YELLOW = "#ffd60a";
const LIGHT = { text: "#0d0d0d", text2: "#5d5d5d", bg: "#ffffff", field: "#f3f3f3", danger: "#ba2623" };
const DARK = { text: "#ffffff", text2: "#afafaf", bg: "#181818", field: "#212121", danger: "#fa423e" };
export type Colors = typeof LIGHT;

export function useColors(): Colors {
  return useColorScheme() === "dark" ? DARK : LIGHT;
}

const TABS = [
  { name: "index", label: "Home", sf: { default: "house", selected: "house.fill" } },
  { name: "tasks", label: "Tasks", sf: { default: "checklist", selected: "checklist" } },
  {
    name: "account",
    label: "Account",
    sf: { default: "person.crop.circle", selected: "person.crop.circle.fill" },
  },
] as const;

// The system tab bar (UITabBarController) with SF Symbols, as Apple's Human Interface Guidelines describe.
export default function TabsLayout() {
  const c = useColors();
  return (
    <NativeTabs tintColor={c.text}>
      {TABS.map((t) => (
        <NativeTabs.Trigger key={t.name} name={t.name}>
          <NativeTabs.Trigger.Icon sf={t.sf} />
          <NativeTabs.Trigger.Label>{t.label}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}

// An empty tab: a centered title and one line that says what will show here (HIG "content unavailable").
export function EmptyState(p: { title: string; message: string }) {
  const c = useColors();
  return (
    <View style={[s.screen, { backgroundColor: c.bg }]}>
      <Text accessibilityRole="header" style={[s.title, { color: c.text }]}>
        {p.title}
      </Text>
      <Text style={[s.message, { color: c.text2 }]}>{p.message}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
  title: { fontSize: 22, fontWeight: "600", textAlign: "center" },
  message: { fontSize: 17, textAlign: "center" },
});
