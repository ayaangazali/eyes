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
import { codeFromUrl, isCode, type Last, MESSAGES, type Perm, permOf } from "./src/eyes.ts";

// packages/ui/tokens.css
const YELLOW = "#ffd60a";
const LIGHT = { text: "#0d0d0d", text2: "#5d5d5d", bg: "#ffffff", field: "#f3f3f3", danger: "#ba2623" };
const DARK = { text: "#ffffff", text2: "#afafaf", bg: "#181818", field: "#212121", danger: "#fa423e" };

export default function App() {
  const c = useColorScheme() === "dark" ? DARK : LIGHT;
  const [code, setCode] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [perm, setPerm] = useState<Perm | "unknown">("unknown");
  const [sharing, setSharing] = useState(false);
  const [last, setLast] = useState<Last | null>(null);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async () => {
    setCode(await getCode());
    setLast(await getLast());
    setSharing(await Location.hasStartedLocationUpdatesAsync(TASK));
    setPerm(
      permOf(await Location.getForegroundPermissionsAsync(), await Location.getBackgroundPermissionsAsync()),
    );
  }, []);

  // One automatic send (60 s throttle applies) whenever sharing is on and the app is in front.
  // Sharing on implies a code and "Always" permission: start is only called with both.
  const sendAuto = useCallback(async () => {
    if (!(await Location.hasStartedLocationUpdatesAsync(TASK))) return;
    try {
      await report(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    } catch {
      return; // no fix right now; background updates keep trying
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    refresh().then(sendAuto);
    const sub = AppState.addEventListener("change", (s) => s === "active" && refresh().then(sendAuto));
    return () => sub.remove();
  }, [refresh, sendAuto]);

  async function allow() {
    const fg = await Location.requestForegroundPermissionsAsync();
    const bg = fg.granted ? await Location.requestBackgroundPermissionsAsync() : null;
    if (!bg?.granted) return setPerm(fg.granted ? "while_using" : "denied");
    setPerm("always");
    await startSharing();
    setSharing(true);
    await sendAuto();
  }

  const save = useCallback(
    async (next: string) => {
      await saveCode(next);
      setDraft("");
      if ((await Location.getBackgroundPermissionsAsync()).granted) await startSharing();
      await refresh();
      await sendAuto();
    },
    [refresh, sendAuto],
  );

  useEffect(() => {
    const open = async (url?: string | null) => {
      const next = url && codeFromUrl(url);
      if (!next) return;
      await save(next);
      setConnected(true);
    };
    Linking.getInitialURL().then(open);
    const sub = Linking.addEventListener("url", (e) => open(e.url));
    return () => sub.remove();
  }, [save]);

  async function toggle(on: boolean) {
    await (on ? startSharing() : stopSharing());
    setSharing(on);
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
        <Text style={muted}>Text APP to Eyes to get your link. Or paste a code here.</Text>
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
        <Button label="Save" primary disabled={!valid} onPress={() => save(draft.trim())} c={c} />
      </>
    );
  } else if (code && perm !== "always") {
    body = (
      <>
        {connected && <Text style={muted}>Connected</Text>}
        <Text style={[s.h1, t]}>Allow location</Text>
        <Text style={t}>
          Eyes texts you paid tasks near you. Your spot is sent when you move, even with the app closed.
        </Text>
        {perm === "ask" || perm === "unknown" ? (
          <Button label="Allow location" primary onPress={allow} c={c} />
        ) : (
          <>
            <Text style={muted}>
              {perm === "while_using"
                ? "Choose Always in Settings so Eyes works when the app is closed."
                : 'Set Location to "Always" in Settings.'}
            </Text>
            <Button label="Open Settings" primary onPress={() => Linking.openSettings()} c={c} />
          </>
        )}
      </>
    );
  } else if (code) {
    body = (
      <>
        {connected && <Text style={muted}>Connected</Text>}
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
        {sharing && (
          <>
            <Text style={[s.allSet, t]}>
              All set. You can leave the app now. It keeps sharing your location in the background.
            </Text>
            <Text style={[s.small, muted]}>
              Don't swipe Eyes away in the app switcher: iOS stops it until you open it again.
            </Text>
          </>
        )}
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
  allSet: { fontSize: 17, fontWeight: "600", marginTop: 8 },
  small: { fontSize: 13 },
});
