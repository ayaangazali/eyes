import { NativeTabs } from "expo-router/native-tabs";

const TABS = [
  { name: "(home)", label: "Home", sf: "house.fill" },
  { name: "(earn)", label: "Earn", sf: "dollarsign.circle.fill" },
  { name: "(spend)", label: "Spend", sf: "creditcard.fill" },
  { name: "(account)", label: "Account", sf: "person.crop.circle.fill" },
] as const;

// The system tab bar: floating Liquid Glass, SF Symbols, the system tint for the selected tab.
export default function TabsLayout() {
  return (
    <NativeTabs>
      {TABS.map((t) => (
        <NativeTabs.Trigger key={t.name} name={t.name}>
          <NativeTabs.Trigger.Icon sf={t.sf} />
          <NativeTabs.Trigger.Label>{t.label}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}
