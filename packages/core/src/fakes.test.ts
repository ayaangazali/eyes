import { describe, expect, it } from "vitest";
import { FAKE_PLACES, FAKE_STRIPE_SIGNATURE, fakeGeo, fakePayments } from "./fakes.ts";

describe("fakePayments.parseWebhook", () => {
  it("parses a body signed with the fake signature and refuses any other", async () => {
    const payments = fakePayments();
    const event = { type: "checkout.session.completed", data: { session_id: "cs_fake_1" } };
    await expect(payments.parseWebhook(JSON.stringify(event), FAKE_STRIPE_SIGNATURE)).resolves.toEqual(event);
    await expect(payments.parseWebhook(JSON.stringify(event), "forged")).rejects.toThrow(
      "invalid webhook signature",
    );
  });
});

describe("fakePayments.reverseTransfer", () => {
  it("returns the same reversal for a repeated idempotency key, and fails with the set Stripe code", async () => {
    const payments = fakePayments();
    const reverse = (key: string) =>
      payments.reverseTransfer({ transfer_id: "tr_1", amount_cents: 300, idempotency_key: key });
    await expect(reverse("a")).resolves.toEqual({ reversal_id: "trr_fake_1" });
    await expect(reverse("b")).resolves.toEqual({ reversal_id: "trr_fake_2" });
    await expect(reverse("a")).resolves.toEqual({ reversal_id: "trr_fake_1" });
    expect(payments.reversals.map((r) => r.idempotency_key)).toEqual(["a", "b"]);
    payments.failReversals("insufficient_funds");
    await expect(reverse("c")).rejects.toMatchObject({ code: "insufficient_funds" });
  });
});

describe("fakeGeo.geocode", () => {
  it("reads raw coordinates, known places case-insensitively, extra places, and null otherwise", async () => {
    const geo = fakeGeo({ "my spot": { lat: 1, lng: 2, label: "My spot" } });
    await expect(geo.geocode(" 37.5, -122.25 ")).resolves.toEqual({
      lat: 37.5,
      lng: -122.25,
      label: "37.5, -122.25",
    });
    const [name = "", place] = Object.entries(FAKE_PLACES)[0] ?? [];
    await expect(geo.geocode(`  ${name.toUpperCase()} `)).resolves.toEqual(place);
    await expect(geo.geocode("My Spot")).resolves.toEqual({ lat: 1, lng: 2, label: "My spot" });
    await expect(geo.geocode("nowhere at all")).resolves.toBeNull();
  });
});
