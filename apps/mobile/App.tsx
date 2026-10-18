import * as Clipboard from "expo-clipboard";
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  AppState,
  Linking,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import {
  getCode,
  getLast,
  removeCode,
  report,
  saveCode,
  startSharing,
  stopSharing,
  TASK,
} from "./src/background.ts";
import { isCode, type Last, MESSAGES } from "./src/eyes.ts";

// packages/ui/tokens.css
const YELLOW = "#ffd60a";
const LIGHT = { text: "#0d0d0d", text2: "#5d5d5d", bg: "#ffffff", field: "#f3f3f3", danger: "#ba2623" };
const DARK = { text: "#ffffff", text2: "#afafaf", bg: "#181818", field: "#212121", danger: "#fa423e" };

type Perm = "unknown" | "ask" | "denied" | "always";

export default function App() {
  const c = useColorScheme() === "dark" ? DARK : LIGHT;
  const [code, setCode] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [perm, setPerm] = useState<Perm>("unknown");
  const [sharing, setSharing] = useState(false);
  const [last, setLast] = useState<Last | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setCode(await getCode());
    setLast(await getLast());
    setSharing(await Location.hasStartedLocationUpdatesAsync(TASK));
    const fg = await Location.getForegroundPermissionsAsync();
    const bg = await Location.getBackgroundPermissionsAsync();
    if (bg.granted) setPerm("always");
    else if ((fg.granted || fg.canAskAgain) && bg.canAskAgain) setPerm("ask");
    else setPerm("denied");
  }, []);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener("change", (s) => s === "active" && refresh());
    return () => sub.remove();
  }, [refresh]);

  async function allow() {
    const fg = await Location.requestForegroundPermissionsAsync();
    const bg = fg.granted ? await Location.requestBackgroundPermissionsAsync() : null;
    if (!bg?.granted) return setPerm("denied");
    setPerm("always");
    await startSharing();
    setSharing(true);
  }

  async function save() {
    await saveCode(draft.trim());
    setDraft("");
    setCode(draft.trim());
    if (perm === "always") {
      await startSharing();
      setSharing(true);
    }
  }

  async function toggle(on: boolean) {
    await (on ? startSharing() : stopSharing());
    setSharing(on);
  }

  async function sendNow() {
    setBusy(true);
    try {
      const sent = await report(
        await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        true,
      );
      await refresh();
      if (sent) setLast(sent);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await removeCode();
    await refresh();
  }

  const t = { color: c.text };
  const muted = { color: c.text2 };
  const valid = isCode(draft.trim());
  const stopped = last?.result === "stopped";

  let body: React.ReactNode = null;
  if (code === null) {
    body = (
      <>
        <Text style={[s.h1, t]}>Paste your Eyes code</Text>
        {stopped && <Text style={{ color: c.danger }}>{MESSAGES.stopped}</Text>}
        <Text style={muted}>Text AUTO to Eyes. The second text is your code.</Text>
        <TextInput
          style={[s.field, t, { backgroundColor: c.field }]}
          value={draft}
          onChangeText={setDraft}
          placeholder="Your code"
          placeholderTextColor={c.text2}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        {draft.length > 0 && !valid && (
          <Text style={{ color: c.danger }}>A code is 43 letters, digits, - or _.</Text>
        )}
        <Button
          label="Paste"
          onPress={async () => setDraft((await Clipboard.getStringAsync()).trim())}
          c={c}
        />
        <Button label="Save" primary disabled={!valid} onPress={save} c={c} />
      </>
    );
  } else if (code && perm !== "always") {
    body = (
      <>
        <Text style={[s.h1, t]}>Allow location</Text>
        <Text style={t}>
          Eyes texts you paid tasks near you. Your spot is sent when you move, even with the app closed.
        </Text>
        {perm === "denied" ? (
          <>
            <Text style={muted}>Set Location to "Always" in Settings.</Text>
            <Button label="Open Settings" primary onPress={() => Linking.openSettings()} c={c} />
          </>
        ) : (
          <Button label="Allow location" primary onPress={allow} c={c} />
        )}
      </>
    );
  } else if (code) {
    body = (
      <>
        <View style={s.row}>
          <Text style={[s.h1, t, { flex: 1 }]}>Sharing your location</Text>
          <Switch value={sharing} onValueChange={toggle} trackColor={{ true: YELLOW }} />
        </View>
        {last && (
          <>
            <Text style={t}>
              {new Date(last.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}:{" "}
              {MESSAGES[last.result]}
            </Text>
            <Text style={muted}>
              Near {last.lat.toFixed(2)}, {last.lng.toFixed(2)}
            </Text>
          </>
        )}
        <Button label={busy ? "Sending…" : "Send now"} primary disabled={busy} onPress={sendNow} c={c} />
        <Button label="Remove code" onPress={remove} c={c} />
      </>
    );
  }

  return (
    <View style={[s.screen, { backgroundColor: c.bg }]}>
      <StatusBar style="auto" />
      <View style={s.body}>{body}</View>
    </View>
  );
}

function Button(p: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  c: typeof LIGHT;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={p.disabled}
      onPress={p.onPress}
      style={[s.button, { backgroundColor: p.primary ? YELLOW : p.c.field, opacity: p.disabled ? 0.4 : 1 }]}
    >
      <Text style={[s.buttonText, { color: p.primary ? "#0d0d0d" : p.c.text }]}>{p.label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: 24, paddingTop: 88, gap: 14 },
  h1: { fontSize: 24, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center" },
  field: { borderRadius: 12, padding: 14, fontSize: 16 },
  button: { borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  buttonText: { fontSize: 17, fontWeight: "600" },
});
