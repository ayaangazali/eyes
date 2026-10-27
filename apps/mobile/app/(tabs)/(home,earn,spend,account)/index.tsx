import * as Clipboard from "expo-clipboard";
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Pressable, ScrollView, StyleSheet, TextInput } from "react-native";
import {
  getCode,
  getLast,
  isPaused,
  pause,
  report,
  saveCode,
  startSharing,
  TASK,
} from "../../../src/background.ts";
import { codeFromUrl, isCode, type Last, MESSAGES, type State, settle } from "../../../src/eyes.ts";
import { C, Type, YELLOW } from "../../../src/ui.tsx";

export default function Home() {
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

  const valid = isCode(draft.trim());

  let body: React.ReactNode = null;
  if (state.view === "code") {
    body = (
      <>
        <Type ramp="headline" accessibilityRole="header">
          Paste your Eyes code
        </Type>
        {last?.result === "stopped" && <Type color={C.red}>{MESSAGES.stopped}</Type>}
        <Type color={C.secondaryLabel}>Text APP to Eyes to get your link. Or paste a code here.</Type>
        <TextInput
          style={s.field}
          value={draft}
          onChangeText={setDraft}
          placeholder="Your code"
          placeholderTextColor={C.secondaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        {draft.length > 0 && !valid && <Type color={C.red}>A code is 43 letters, digits, - or _.</Type>}
        <Button label="Paste" onPress={async () => setDraft((await Clipboard.getStringAsync()).trim())} />
        <Button
          label="Save"
          primary
          disabled={!valid}
          onPress={async () => {
            await saveCode(draft.trim());
            setDraft("");
            await run();
          }}
        />
      </>
    );
  } else if (state.view === "ask" || state.view === "denied") {
    body = (
      <>
        <Type ramp="headline" accessibilityRole="header">
          Allow location
        </Type>
        <Type>Eyes texts you paid tasks near you. It needs your location to find them.</Type>
        {state.view === "ask" ? (
          // HIG: a pre-prompt button must not look like the system Allow button.
          <Button label="Continue" primary onPress={run} />
        ) : (
          <>
            <Type color={C.secondaryLabel}>In Settings, tap Location, then choose "Always".</Type>
            <Button label="Open Settings" primary onPress={() => Linking.openSettings()} />
          </>
        )}
      </>
    );
  } else if (state.view === "paused") {
    body = (
      <>
        <Type ramp="headline" accessibilityRole="header">
          Sharing is off
        </Type>
        <Type color={C.secondaryLabel}>Eyes won't text you tasks near you until you share again.</Type>
        <Button
          label="Share again"
          primary
          onPress={async () => {
            await pause(false);
            await run();
          }}
        />
      </>
    );
  } else if (state.view === "sharing") {
    body = (
      <>
        <Type ramp="headline" accessibilityRole="header">
          Sharing
        </Type>
        {last && (
          <Type color={C.secondaryLabel}>
            {new Date(last.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}:{" "}
            {MESSAGES[last.result]}, near {last.lat.toFixed(2)}, {last.lng.toFixed(2)}
          </Type>
        )}
        <Type ramp="headline">All set. You can leave the app now.</Type>
        {!state.always && (
          <Type accessibilityRole="link" onPress={() => Linking.openSettings()}>
            For sharing while Eyes is closed, set Location to "Always" in <Type color={C.tint}>Settings</Type>
            .
          </Type>
        )}
        <Type ramp="footnote" color={C.secondaryLabel}>
          Don't swipe Eyes away in the app switcher: iOS stops it until you open it again.
        </Type>
        <Type
          color={C.tint}
          accessibilityRole="button"
          onPress={async () => {
            await pause(true);
            await run();
          }}
        >
          Stop sharing
        </Type>
      </>
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={s.screen} contentContainerStyle={s.body}>
      <StatusBar style="auto" />
      {body}
    </ScrollView>
  );
}

// A 52 pt capsule: Eyes yellow under a black label for the primary action, system gray for the rest.
function Button(p: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: p.disabled }}
      disabled={p.disabled}
      onPress={p.onPress}
      style={[s.button, { backgroundColor: p.primary ? YELLOW : C.fill, opacity: p.disabled ? 0.4 : 1 }]}
    >
      <Type ramp="headline" color={p.primary ? "#000000" : C.label}>
        {p.label}
      </Type>
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  body: { padding: 20, gap: 12 },
  field: {
    borderRadius: 12,
    padding: 14,
    minHeight: 52,
    fontSize: 17,
    color: C.label,
    backgroundColor: C.field,
  },
  button: {
    borderRadius: 999,
    minHeight: 52,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
