import { Stack } from "expo-router";
import { C } from "../../../src/ui.tsx";

// Each tab gets its own native stack, so later screens push inside the tab with the system back button.
const ROOTS: Record<string, { route: string; title: string }> = {
  "(home)": { route: "index", title: "Home" },
  "(earn)": { route: "earn", title: "Earn" },
  "(spend)": { route: "spend", title: "Spend" },
  "(account)": { route: "account", title: "Account" },
};

export const unstable_settings = {
  initialRouteName: "index",
  earn: { initialRouteName: "earn" },
  spend: { initialRouteName: "spend" },
  account: { initialRouteName: "account" },
};

export default function TabStack({ segment }: { segment: string }) {
  const root = ROOTS[segment] ?? { route: "index", title: "Home" };
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerStyle: { backgroundColor: C.background },
      }}
    >
      <Stack.Screen name={root.route} options={{ title: root.title }} />
    </Stack>
  );
}
