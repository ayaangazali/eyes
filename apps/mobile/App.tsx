/// <reference types="expo/types" />
import { ExpoRoot } from "expo-router";

// Expo Router's root, rendered from here so index.ts registers the background task before any screen loads.
const routes = require.context("./app");

export default function App() {
  return <ExpoRoot context={routes} />;
}
