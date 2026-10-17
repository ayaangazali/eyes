# ADR-024: `location` describes the public place to check, never the user's location

Status: proposed (2026-10-17, T4.33 builder). Description-only change to a frozen schema; no type, default or bound changed.

## Context
Manufact's publishing audit of the keyless sandbox (audit 7cf0b542, 2026-10-17) raised a policy finding: "The quote_task and ask_eyes schemas accept a free-form address and latitude/longitude directly from the model", against the directory rule "Do not request precise user location data". Eyes never asks where the user is: `location` is the public place a worker walks to. The `LocationInput` descriptions said only "Where to look" and "Address or place name, city", which reads like it could be the user's own address. The text is generated into `openapi.json` and `llms-full.txt`, so agents and reviewers read it.

## Decision
- `LocationInput`: "The public place to check: a string "place name, city" or its numbers {"lat": 37.7825, "lng": -122.4078}. Never the user's own location or a home address."
- Its string branch: "A public place as "place name, city" or its street address, e.g. "Blue Bottle Coffee, Mint Plaza, San Francisco". Never a home address."
- `LatLng` keeps its generic lat and lng descriptions, because it is shared with other shapes.

## Consequences
Tool schema snapshot regenerated; `docs/public/openapi.json` and `docs/public/llms-full.txt` regenerated with `pnpm --filter @eyes/cli gen:docs`. Inputs that validated before still validate.
