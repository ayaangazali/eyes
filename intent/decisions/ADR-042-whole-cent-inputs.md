# ADR-042: Reject sub-cent money inputs

## Decision

Reject bounty and owner policy amounts that contain fractions of one cent before converting them to integer cents.
Use `EyesError("invalid_input")` to return the documented HTTP 400 response.
Preserve the input value and its type when validation succeeds.
Keep `usdToCents` rounding unchanged for existing balance and display uses.

## Consequences

Caller amounts no longer silently round at these input boundaries.
Number inputs remain compatible with `usdToCents`; existing string callers retain strings.
The contributor's tests retain coverage for whole cents, invalid strings, and sub-cent amounts.
A regression test checks the error code and HTTP status.
