import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Inline helpers (copied from component source so tests are pure unit tests)
// ---------------------------------------------------------------------------

function formatDate(value: string | null, nullLabel = "—"): string {
  if (!value) {
    return nullLabel;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

type RedemptionStatus =
  | "PENDING"
  | "POINTS_DEBITED"
  | "ISSUED"
  | "USED"
  | "EXPIRED"
  | "FAILED"
  | "REFUNDED"
  | "CANCELLED";

function displayStatus(status: RedemptionStatus): string {
  if (status === "ISSUED") return "Available";
  if (status === "USED") return "Used";
  if (status === "EXPIRED") return "Expired";
  if (status === "FAILED") return "Failed";
  if (status === "REFUNDED") return "Refunded — points returned";
  if (status === "CANCELLED") return "Cancelled";
  return "Processing";
}

function buttonLabel(
  redeemingOfferId: string | null,
  offerId: string,
  computedAvailability: { claimable: boolean; label: string },
): string {
  if (redeemingOfferId === offerId) return "Redeeming...";
  if (computedAvailability.claimable) return "Redeem";
  return computedAvailability.label;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatDate", () => {
  test("non-null ISO string returns locale-formatted date", () => {
    const result = formatDate("2025-03-15T00:00:00Z");
    assert.notEqual(result, "—");
    assert.notEqual(result, "Ongoing");
    // Should contain a year number
    assert.match(result, /2025/);
  });

  test("null with default label returns —", () => {
    assert.equal(formatDate(null), "—");
  });

  test('null with "Ongoing" label returns Ongoing', () => {
    assert.equal(formatDate(null, "Ongoing"), "Ongoing");
  });

  test('null with "No expiry" label returns No expiry', () => {
    assert.equal(formatDate(null, "No expiry"), "No expiry");
  });
});

describe("displayStatus", () => {
  test('ISSUED → "Available"', () => {
    assert.equal(displayStatus("ISSUED"), "Available");
  });

  test('USED → "Used"', () => {
    assert.equal(displayStatus("USED"), "Used");
  });

  test('EXPIRED → "Expired"', () => {
    assert.equal(displayStatus("EXPIRED"), "Expired");
  });

  test('FAILED → "Failed"', () => {
    assert.equal(displayStatus("FAILED"), "Failed");
  });

  test('REFUNDED → "Refunded — points returned"', () => {
    assert.equal(displayStatus("REFUNDED"), "Refunded — points returned");
  });

  test('CANCELLED → "Cancelled"', () => {
    assert.equal(displayStatus("CANCELLED"), "Cancelled");
  });

  test('PENDING → "Processing"', () => {
    assert.equal(displayStatus("PENDING"), "Processing");
  });
});

describe("button label logic", () => {
  test("claimable: true → Redeem", () => {
    const result = buttonLabel(null, "offer-1", { claimable: true, label: "Redeem" });
    assert.equal(result, "Redeem");
  });

  test('claimable: false, label: "Not enough points" → Not enough points', () => {
    const result = buttonLabel(null, "offer-1", {
      claimable: false,
      label: "Not enough points",
    });
    assert.equal(result, "Not enough points");
  });

  test('claimable: false, label: "Claim window ended" → Claim window ended', () => {
    const result = buttonLabel(null, "offer-1", {
      claimable: false,
      label: "Claim window ended",
    });
    assert.equal(result, "Claim window ended");
  });

  test('claimable: false, label: "Store disconnected" → Store disconnected', () => {
    const result = buttonLabel(null, "offer-1", {
      claimable: false,
      label: "Store disconnected",
    });
    assert.equal(result, "Store disconnected");
  });
});
