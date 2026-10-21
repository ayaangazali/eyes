import * as Clipboard from "expo-clipboard";
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { getCode, getLast, isPaused, pause, report, saveCode, startSharing, TASK } from "./src/background.ts";
import { codeFromUrl, isCode, type Last, MESSAGES, type State, settle } from "./src/eyes.ts";

// packages/ui/src/tokens.css
const YELLOW = "#ffd60a";
const LIGHT = { text: "#0d0d0d", text2: "#5d5d5d", bg: "#ffffff", field: "#f3f3f3", danger: "#ba2623" };
const DARK = { text: "#ffffff", text2: "#afafaf", bg: "#181818", field: "#212121", danger: "#fa423e" };

export default function App() {
  const c = useColorScheme() === "dark" ? DARK : LIGHT;
  const [state, setState] = useState<State>({ view: "loading" });
  const [draft, setDraft] = useState("");
  const [last, setLast] = useState<Last | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const askedAlways = useRef(false);

  // Every entry point (launch, deep link, back from Settings, buttons) runs the same settle pass.
  // Permission dialogs flip AppState, so overlapping calls queue one rerun instead of stacking.
  const run = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        await settle(
          {
            code: getCode,
            paused: isPaused,
            fg: Location.getForegroundPermissionsAsync,
            askFg: Location.requestForegroundPermissionsAsync,
            bg: Location.getBackgroundPermissionsAsync,
            askBg: () => {
              askedAlways.current = true;
              return Location.requestBackgroundPermissionsAsync();
            },
            sharing: () => Location.hasStartedLocationUpdatesAsync(TASK),
            start: startSharing,
            sendNow: async () => {
              try {
                await report(
                  await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
                );
              } catch {
                // no fix right now; background updates keep trying
              }
            },
            show: setState,
          },
          !askedAlways.current,
        );
        setLast(await getLast());
      } while (again.current);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    const open = async (url?: string | null) => {
      const next = url && codeFromUrl(url);
      try {
        if (next) await saveCode(next);
      } finally {
        await run(); // a failed save falls back to the paste screen, never a blank one
      }
    };
    Linking.getInitialURL().then(open);
    const link = Linking.addEventListener("url", (e) => open(e.url));
    const app = AppState.addEventListener("change", (s) => s === "active" && run());
    return () => {
      link.remove();
      app.remove();
    };
  }, [run]);

  const t = { color: c.text };
  const muted = { color: c.text2 };
  const valid = isCode(draft.trim());

  let body: React.ReactNode = null;
  if (state.view === "code") {
    body = (
      <>
        <Text style={[s.h1, t]}>Paste your Eyes code</Text>
        {last?.result === "stopped" && <Text style={{ color: c.danger }}>{MESSAGES.stopped}</Text>}
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
        <Button
          label="Save"
          primary
          disabled={!valid}
          onPress={async () => {
            await saveCode(draft.trim());
            setDraft("");
            await run();
          }}
          c={c}
        />
      </>
    );
  } else if (state.view === "ask" || state.view === "denied") {
    body = (
      <>
        <Text style={[s.h1, t]}>Allow location</Text>
        <Text style={t}>Eyes texts you paid tasks near you. It needs your location to find them.</Text>
        {state.view === "ask" ? (
          <Button label="Allow location" primary onPress={run} c={c} />
        ) : (
          <>
            <Text style={muted}>In Settings, tap Location, then choose "Always".</Text>
            <Button label="Open Settings" primary onPress={() => Linking.openSettings()} c={c} />
          </>
        )}
      </>
    );
  } else if (state.view === "paused") {
    body = (
      <>
        <Text style={[s.h1, t]}>Sharing is off</Text>
        <Text style={muted}>Eyes won't text you tasks near you until you share again.</Text>
        <Button
          label="Share again"
          primary
          onPress={async () => {
            await pause(false);
            await run();
          }}
          c={c}
        />
      </>
    );
  } else if (state.view === "sharing") {
    body = (
      <>
        <Text style={[s.h1, t]}>Sharing</Text>
        {last && (
          <Text style={muted}>
            {new Date(last.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}:{" "}
            {MESSAGES[last.result]}, near {last.lat.toFixed(2)}, {last.lng.toFixed(2)}
          </Text>
        )}
        <Text style={[s.allSet, t]}>All set. You can leave the app now.</Text>
        {!state.always && (
          <Text style={t} accessibilityRole="link" onPress={() => Linking.openSettings()}>
            For sharing while Eyes is closed, set Location to "Always" in <Text style={s.link}>Settings</Text>
            .
          </Text>
        )}
        <Text style={[s.small, muted]}>
          Don't swipe Eyes away in the app switcher: iOS stops it until you open it again.
        </Text>
        <Text
          style={[s.small, muted, s.link]}
          accessibilityRole="button"
          onPress={async () => {
            await pause(true);
            await run();
          }}
        >
          Stop sharing
        </Text>
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
  field: { borderRadius: 12, padding: 14, fontSize: 16 },
  button: { borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  buttonText: { fontSize: 17, fontWeight: "600" },
  allSet: { fontSize: 17, fontWeight: "600", marginTop: 8 },
  small: { fontSize: 13 },
  link: { textDecorationLine: "underline" },
});
