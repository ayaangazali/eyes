# ADR-040: Return the resolved place and reject invalid input text

Status: Accepted
Date: 2026-10-20

## Context

Issues #107 and #104 report ambiguous geocoding and invalid text that receives an ineffective retry hint.
This decision follows the defaults in issue #180.

## Decision

Return `resolved_location` with the stored task's label, latitude, and longitude from `ask_eyes`, including retries.
Allow place names to resolve to another city or country without a separate mismatch refusal.
Keep the existing safety and spending checks.
Reject coordinate strings outside latitude -90..90 or longitude -180..180 before calling the geocoder.
Return `location_not_found` for invalid geocoder output rather than blaming the caller's input.
Validate resolved coordinates against those same bounds.

Use one shared Zod text check for NUL characters and unpaired Unicode surrogates.
Apply it to free-text request fields before safety checks or database writes.
Preserve valid Unicode, including supplementary characters.
REST returns `400 invalid_input` with the field path.
MCP uses its native input-validation error with the field path; the CLI rejects the same inputs before sending a request.
Do not silently clean the request or recommend an unchanged retry.

## Consequences

Clients can inspect the actual task location rather than infer it from their original query.
This does not guarantee that a geocoded place matches the user's intent.
The existing database text cleanup remains as protection for other internal inputs.
No migration is required.
