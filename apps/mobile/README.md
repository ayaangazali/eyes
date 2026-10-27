# eyes-mobile

The Eyes iPhone app (Expo, React Native). A worker sets it up with their code, allows location ("Always"), and the app then sends the phone's location in the background to `POST /w/location` on the API server, so dispatch can find nearby workers.

## Entry points

- `index.ts`: registers the background task and the root component.
- `App.tsx`: the Expo Router root for the routes in `app/`.
- `app/(tabs)/_layout.tsx`: the system tab bar (Home, Tasks, Account), the colors, and the empty-state view.
- `app/(tabs)/index.tsx`: the Home tab (setup, permission, sharing status).
- `app/(tabs)/tasks.tsx`, `app/(tabs)/account.tsx`: empty states for now.
- `app/+native-intent.ts`: opens Home for the setup link `eyes://connect#c=<code>`.
- `src/background.ts`: the `eyes-location` background task, keychain storage of the code (`expo-secure-store`), and start and stop of sharing.
- `src/eyes.ts`: the send logic with no Expo imports: setup-link parsing, permission state, `postFix` and the 60 s throttle. `EXPO_PUBLIC_EYES_API` overrides the API origin (default `https://api.eyes.pictures`).

No other package imports this app. The worker web app (`apps/web/worker`) links to it from `/app` and `/install`.

## Why it is outside the pnpm workspace

`pnpm-workspace.yaml` excludes `apps/mobile`, and the root `tsconfig.json` excludes it too:

- It has its own npm lockfile (`package-lock.json`) and installs with `npm ci`.
- It pins TypeScript `~6.0.3`; the root workspace uses TypeScript 7. React Native and DOM globals also clash with the root Node types.
- It releases from a separate repository: `i098/eyes-ios-release` runs `pnpm adhoc:release` on a macOS runner. No CI job in this repository releases the app; see [docs/DEPLOY.md](../../docs/DEPLOY.md#ad-hoc-releases-iphone-app) for how a release starts.

## Test it

```sh
pnpm exec vitest run --project unit apps/mobile   # from the repo root
cd apps/mobile && npm ci && npm run typecheck     # what the mobile-typecheck CI job runs
```

Biome and the root unit tests cover this folder; its own `tsconfig.json` excludes the test files.

See [docs/architecture.md](../../docs/architecture.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md).
