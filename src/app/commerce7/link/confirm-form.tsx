"use client";

import { useState } from "react";

/**
 * Explicit confirmation UI for linking a Commerce7 tenant to a SQRATCH Brand.
 *
 * Linking always requires a deliberate submit — a single administered Brand is
 * preselected for convenience, but never linked automatically on page load.
 */
export function Commerce7LinkConfirmForm({
  token,
  tenantId,
  brands,
}: {
  token: string;
  tenantId: string;
  brands: Array<{ id: string; name: string }>;
}) {
  const [brandId, setBrandId] = useState(brands[0]?.id ?? "");
  const [status, setStatus] = useState<"idle" | "working" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [connectedBrand, setConnectedBrand] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("working");
    setError(null);

    try {
      const response = await fetch("/api/commerce7/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, brandId }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        brandName?: string;
      } | null;

      if (!response.ok) {
        setError(payload?.error || "Could not connect this store.");
        setStatus("idle");
        return;
      }

      setConnectedBrand(payload?.brandName ?? null);
      setStatus("done");
    } catch {
      setError("Could not reach SQRATCH. Please try again.");
      setStatus("idle");
    }
  }

  if (status === "done") {
    return (
      <div
        style={{
          border: "1px solid #16a34a",
          borderRadius: "10px",
          padding: "16px",
          marginTop: "16px",
        }}
      >
        <h2 style={{ fontSize: "16px", margin: "0 0 6px" }}>Store connected</h2>
        <p style={{ margin: 0, color: "#52525b" }}>
          <strong>{tenantId}</strong> is now connected
          {connectedBrand ? ` to ${connectedBrand}` : ""}. You can close this tab
          and return to Commerce7.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: "16px" }}>
      <label
        htmlFor="commerce7-brand"
        style={{ display: "block", fontWeight: 600, marginBottom: "6px" }}
      >
        {brands.length === 1 ? "SQRATCH brand" : "Choose a SQRATCH brand"}
      </label>
      <select
        id="commerce7-brand"
        value={brandId}
        onChange={(event) => setBrandId(event.target.value)}
        style={{
          width: "100%",
          padding: "10px",
          borderRadius: "8px",
          border: "1px solid #d4d4d8",
          marginBottom: "16px",
        }}
      >
        {brands.map((brand) => (
          <option key={brand.id} value={brand.id}>
            {brand.name}
          </option>
        ))}
      </select>

      {error ? (
        <p style={{ color: "#dc2626", marginTop: 0 }} role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={status === "working" || !brandId}
        style={{
          background: "#111827",
          color: "#ffffff",
          padding: "10px 16px",
          borderRadius: "8px",
          border: "none",
          fontWeight: 600,
          cursor: status === "working" ? "default" : "pointer",
          opacity: status === "working" ? 0.7 : 1,
        }}
      >
        {status === "working" ? "Connecting…" : "Confirm and connect"}
      </button>
    </form>
  );
}
