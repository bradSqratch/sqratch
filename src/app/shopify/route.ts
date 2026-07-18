import { NextRequest, NextResponse } from "next/server";
import { buildShopifyFrameAncestorsCsp } from "@/lib/shopify";

const shopifyApiKey = process.env.SHOPIFY_API_KEY || "";

export const dynamic = "force-dynamic";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJs(value: string) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function firstParam(value: string | null) {
  return value ?? "";
}

export function GET(request: NextRequest) {
  const rawShop = firstParam(request.nextUrl.searchParams.get("shop"));
  const rawDistribution = process.env.SHOPIFY_APP_DISTRIBUTION;

  const distribution: "public" | "custom" =
    rawDistribution === "public" || rawDistribution === "custom"
      ? rawDistribution
      : "custom";

  const showOAuthFallback = distribution === "custom" || !shopifyApiKey;
  const shouldCheckEmbeddedStatus =
    distribution === "public" && Boolean(shopifyApiKey);

  const actionMarkup = shouldCheckEmbeddedStatus
    ? `<button class="button" id="continue-button" type="button">Continue to SQRATCH linking</button><button class="button disconnect-button is-hidden" id="disconnect-button" type="button">Disconnect from SQRATCH</button>`
    : showOAuthFallback && rawShop
      ? `<a class="button" target="_top" rel="noopener" href="/api/shopify/oauth/start?shop=${encodeURIComponent(rawShop)}">Continue to SQRATCH linking</a>`
      : showOAuthFallback
        ? `<button class="button" type="button" disabled>Continue to SQRATCH linking</button>`
        : `<button class="button" id="continue-button" type="button">Continue to SQRATCH linking</button>`;

  const appBridgeHead = shopifyApiKey
    ? `<meta name="shopify-api-key" content="${escapeHtml(shopifyApiKey)}"><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    ${appBridgeHead}
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SQRATCH Shopify</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        min-height: 100vh;
        margin: 0;
        background:
          radial-gradient(1100px 600px at 50% 0%, rgba(99, 102, 241, 0.25), transparent 68%),
          radial-gradient(760px 460px at 8% 24%, rgba(236, 72, 153, 0.1), transparent 62%),
          radial-gradient(780px 520px at 92% 28%, rgba(34, 211, 238, 0.08), transparent 62%),
          #020015;
        color: #ffffff;
      }

      .topbar {
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(2, 0, 21, 0.82);
        box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03);
        backdrop-filter: blur(18px);
      }

      .topbar-inner {
        display: flex;
        width: min(100% - 2.5rem, 72rem);
        min-height: 4.25rem;
        align-items: center;
        margin: 0 auto;
      }

      .wordmark {
        display: inline-flex;
        align-items: center;
        gap: 0.6rem;
        color: #d8d1f5;
        font-size: 0.9rem;
        font-weight: 800;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }

      .wordmark::before {
        width: 0.7rem;
        height: 0.7rem;
        border-radius: 999px;
        background: linear-gradient(135deg, #e9ddff, #9b7cf7);
        box-shadow: 0 0 18px rgba(174, 139, 255, 0.7);
        content: "";
      }

      main {
        min-height: calc(100vh - 4.25rem);
        padding: 3.5rem 1.25rem 4rem;
      }

      .shell {
        width: min(100%, 58rem);
        margin: 0 auto;
      }

      .intro {
        max-width: 48rem;
        margin: 0 auto 2.25rem;
        text-align: center;
      }

      .page-eyebrow,
      .card {
        border: 1px solid rgba(255, 255, 255, 0.1);
      }

      .page-eyebrow {
        display: inline-flex;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
        padding: 0.45rem 0.8rem;
        color: #d7cafa;
        font-size: 0.7rem;
        font-weight: 700;
        letter-spacing: 0.2em;
      }

      .page-title {
        max-width: 43rem;
        margin: 1rem auto 0;
        background: linear-gradient(145deg, #ffffff 22%, rgba(255, 255, 255, 0.56) 112%);
        background-clip: text;
        color: transparent;
        font-size: clamp(2.25rem, 6vw, 3.75rem);
        letter-spacing: -0.045em;
        line-height: 1.02;
        text-wrap: balance;
      }

      .page-copy {
        max-width: 40rem;
        margin: 1rem auto 0;
        color: rgba(255, 255, 255, 0.64);
        font-size: 0.975rem;
        line-height: 1.7;
      }

      .card {
        width: 100%;
        overflow: hidden;
        border-radius: 1.75rem;
        background: rgba(13, 16, 35, 0.86);
        box-shadow: 0 30px 90px rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(20px);
      }

      .card-header {
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: linear-gradient(105deg, rgba(41, 35, 77, 0.7), rgba(14, 18, 40, 0.4), rgba(31, 46, 73, 0.55));
        padding: 1.6rem 1.5rem;
      }

      .eyebrow {
        margin: 0;
        color: #cbbcf5;
        font-size: 0.7rem;
        font-weight: 700;
        letter-spacing: 0.22em;
        text-transform: uppercase;
      }

      .card-title {
        margin: 0.75rem 0 0;
        font-size: clamp(1.2rem, 4vw, 1.7rem);
        letter-spacing: -0.03em;
      }

      .lede {
        max-width: 42rem;
        margin: 0.75rem 0 0;
        color: rgba(255, 255, 255, 0.65);
        font-size: 0.875rem;
        line-height: 1.6;
      }

      .content {
        display: grid;
        gap: 1.35rem;
        padding: 1.5rem;
      }

      .stats {
        display: grid;
        gap: 0.75rem;
      }

      @media (min-width: 640px) {
        .stats {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      .stat {
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 1.1rem;
        background: rgba(0, 0, 0, 0.18);
        padding: 1rem;
      }

      .label {
        margin: 0;
        color: rgba(255, 255, 255, 0.45);
        font-size: 0.75rem;
        letter-spacing: 0.2em;
        text-transform: uppercase;
      }

      .value {
        margin: 0.5rem 0 0;
        color: rgba(255, 255, 255, 0.88);
        font-size: 0.875rem;
        line-height: 1.5;
      }

      .notice {
        border: 1px solid rgba(183, 166, 232, 0.24);
        border-radius: 1.1rem;
        background: linear-gradient(135deg, rgba(157, 126, 245, 0.16), rgba(107, 82, 184, 0.07));
        padding: 1.25rem;
        color: rgba(255, 255, 255, 0.8);
        font-size: 0.875rem;
        line-height: 1.65;
      }

      .error {
        display: none;
        overflow-wrap: anywhere;
        border: 1px solid rgba(251, 113, 133, 0.38);
        border-radius: 1.1rem;
        background: rgba(190, 24, 93, 0.16);
        padding: 0.9rem 1rem;
        color: #ffd1dc;
        font-size: 0.875rem;
        line-height: 1.55;
      }

      .status-message {
        margin: 0;
        border-radius: 1.1rem;
        padding: 0.9rem 1rem;
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.55;
      }

      .status-message-danger {
        border: 1px solid rgba(251, 113, 133, 0.38);
        background: rgba(190, 24, 93, 0.14);
        color: #ffd1dc;
      }

      .status-message-info {
        border: 1px solid rgba(183, 166, 232, 0.24);
        background: rgba(157, 126, 245, 0.1);
        color: rgba(255, 255, 255, 0.78);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
      }

      .button {
        display: inline-flex;
        min-height: 2.5rem;
        align-items: center;
        justify-content: center;
        border: 1px solid #ffffff;
        border-radius: 999px;
        background: #ffffff;
        padding: 0.5rem 1.25rem;
        color: #000000;
        font: inherit;
        font-size: 0.875rem;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
        transition: transform 160ms ease, box-shadow 160ms ease, background 160ms ease;
      }

      .button:hover:not(:disabled) {
        box-shadow: 0 10px 28px rgba(255, 255, 255, 0.18);
        transform: translateY(-1px);
      }

      .button:focus-visible {
        outline: 3px solid rgba(196, 181, 253, 0.9);
        outline-offset: 3px;
      }

      .button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .disconnect-button {
        border-color: rgba(251, 113, 133, 0.58);
        background: rgba(190, 24, 93, 0.12);
        color: #ffd1dc;
      }

      .loader {
        display: inline-flex;
        align-items: center;
        gap: 0.65rem;
        color: rgba(255, 255, 255, 0.68);
        font-size: 0.875rem;
      }

      .loader-spinner {
        width: 1rem;
        height: 1rem;
        border: 2px solid rgba(216, 202, 250, 0.3);
        border-top-color: #d8cafa;
        border-radius: 999px;
        animation: spin 700ms linear infinite;
      }

      .is-hidden {
        display: none !important;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      @media (min-width: 768px) {
        main {
          padding: 4.75rem 2rem 5rem;
        }

        .topbar-inner {
          width: min(100% - 4rem, 72rem);
        }

        .card-header,
        .content {
          padding-left: 2.25rem;
          padding-right: 2.25rem;
        }

        .content {
          gap: 1.5rem;
          padding-bottom: 2.25rem;
          padding-top: 2rem;
        }
      }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="topbar-inner">
        <span class="wordmark" aria-label="SQRATCH">SQRATCH</span>
      </div>
    </header>
    <main>
      <section class="shell">
        <div class="intro">
          <p class="page-eyebrow">Connect Shopify to SQRATCH</p>
          <h1 class="page-title">SQRATCH Shopify App</h1>
          <p class="page-copy">Link your Shopify store to a SQRATCH Brand account to display products across experiences and create reward discount codes.</p>
        </div>
        <div class="card">
          <div class="card-header">
            <p class="eyebrow">Hello</p>
            <h3 class="card-title">Link your Shopify store with SQRATCH</h3>
            <p class="lede">This embedded app is a lightweight setup shell. The full product experience stays in the SQRATCH Brand dashboard.</p>
          </div>

          <div class="content">
            <div class="stats">
              <div class="stat">
                <p class="label">Shopify store</p>
                <p class="value" id="shopify-store-status">${rawShop ? "Shopify store detected" : "Open SQRATCH from your Shopify Admin"}</p>
              </div>
              <div class="stat">
                <p class="label">SQRATCH link</p>
                <p class="value" id="sqratch-link-status">Complete setup to link your store</p>
              </div>
            </div>

            <div class="notice" id="connection-notice">SQRATCH requests product access to display Shopify products inside SQRATCH experiences and discount access to create reward codes when brands enable loyalty rewards.</div>
            <p class="error" id="error-message" role="alert" aria-live="polite"></p>
            <p class="loader${shouldCheckEmbeddedStatus ? "" : " is-hidden"}" id="status-loader" role="status" aria-live="polite" aria-busy="true"><span class="loader-spinner" aria-hidden="true"></span><span id="status-loader-label">Checking Shopify connection…</span></p>
            <p class="status-message status-message-info is-hidden" id="status-message" role="status" aria-live="polite"></p>
            <div class="actions${shouldCheckEmbeddedStatus ? " is-hidden" : ""}" id="connection-actions">${actionMarkup}</div>
          </div>
        </div>
      </section>
    </main>

    <script>
      const distribution = ${escapeJs(distribution)};
      const rawShop = ${escapeJs(rawShop)};
      const shouldCheckEmbeddedStatus = ${shouldCheckEmbeddedStatus};
      const unlinkedNotice = "SQRATCH requests product access to display Shopify products inside SQRATCH experiences and discount access to create reward codes when brands enable loyalty rewards.";

      function isEmbedded() {
        try {
          return window.self !== window.top || Boolean(window.shopify?.environment?.embedded);
        } catch {
          return true;
        }
      }

      function setError(message) {
        const errorElement = document.getElementById("error-message");
        if (!errorElement) return;
        errorElement.textContent = message;
        errorElement.style.display = message ? "block" : "none";
      }

      function setStatusMessage(message, type = "info") {
        const statusMessage = document.getElementById("status-message");
        if (!statusMessage) return;

        statusMessage.textContent = message;
        statusMessage.classList.toggle("is-hidden", !message);
        statusMessage.classList.toggle("status-message-danger", type === "danger");
        statusMessage.classList.toggle("status-message-info", type === "info");
      }

      function setLoading(isLoading, label) {
        const loader = document.getElementById("status-loader");
        const loaderLabel = document.getElementById("status-loader-label");
        const actions = document.getElementById("connection-actions");
        if (loaderLabel && label) loaderLabel.textContent = label;
        if (loader) {
          loader.classList.toggle("is-hidden", !isLoading);
          loader.setAttribute("aria-busy", String(isLoading));
        }
        if (actions) actions.classList.toggle("is-hidden", isLoading);
      }

      function setUnlinkedState() {
        document.getElementById("shopify-store-status").textContent =
          rawShop ? "Shopify store detected" : "Open SQRATCH from your Shopify Admin";
        document.getElementById("sqratch-link-status").textContent =
          "Complete setup to link your store";
        document.getElementById("connection-notice").textContent = unlinkedNotice;
        document.getElementById("continue-button")?.classList.remove("is-hidden");
        document.getElementById("disconnect-button")?.classList.add("is-hidden");
      }

      function setLinkedState(brandName) {
        document.getElementById("shopify-store-status").textContent = "Connected to Shopify";
        document.getElementById("sqratch-link-status").textContent = "Linked to " + brandName;
        document.getElementById("connection-notice").textContent =
          "This Shopify store is connected to the " + brandName + " SQRATCH Brand. Products can be displayed in SQRATCH experiences, and eligible reward offers can generate Shopify discount codes.";
        document.getElementById("continue-button")?.classList.add("is-hidden");
        document.getElementById("disconnect-button")?.classList.remove("is-hidden");
      }

      async function getEmbeddedSessionToken() {
        if (!window.shopify) {
          throw new Error("App Bridge is not loaded yet. Please reopen SQRATCH from your Shopify Admin.");
        }
        return window.shopify.idToken();
      }

      async function checkEmbeddedStatus() {
        if (!shouldCheckEmbeddedStatus) return;

        setLoading(true, "Checking Shopify connection…");
        setStatusMessage("");
        try {
          const sessionToken = await getEmbeddedSessionToken();
          const response = await fetch("/api/shopify/embedded/status", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + sessionToken,
            },
            body: JSON.stringify({}),
          });
          if (!response.ok) throw new Error("status check failed");

          const json = await response.json();
          if (json?.data?.linked && json.data.brandName) {
            setLinkedState(json.data.brandName);
          } else {
            setUnlinkedState();
          }
        } catch {
          setUnlinkedState();
          setStatusMessage("We could not confirm the current connection. You can continue setup.", "info");
        } finally {
          setLoading(false);
        }
      }

      async function handleContinue() {
        const button = document.getElementById("continue-button");
        setError("");
        setStatusMessage("");
        if (button) {
          button.disabled = true;
          button.textContent = "Setting up…";
        }

        try {
          console.log("[SQRATCH Shopify]", {
          distribution,
          rawShopPresent: Boolean(rawShop),
          embedded: isEmbedded(),
          });
          if (distribution === "public" && isEmbedded()) {
            const sessionToken = await getEmbeddedSessionToken();
            const response = await fetch("/api/shopify/embedded/session", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: \`Bearer \${sessionToken}\`,
              },
              body: JSON.stringify({}),
            });

            if (!response.ok) {
              const text = await response.text().catch(() => "");
              throw new Error(\`Session setup failed (\${response.status})\${text ? \`: \${text}\` : ""}. Please try again.\`);
            }

            const json = await response.json();
            const redirectTo =
              json?.data?.redirectTo ??
              (json?.data?.installId
                ? \`/dashboard/brand/shopify/install?install=\${encodeURIComponent(json.data.installId)}\`
                : null);

            if (!redirectTo) {
              throw new Error("Unexpected response from server. Please try again.");
            }

            window.top.location.href = redirectTo;
          } else if (rawShop) {
            window.location.href = \`/api/shopify/oauth/start?shop=\${encodeURIComponent(rawShop)}\`;
          } else {
            setError("No Shopify store context found. Please open SQRATCH from your Shopify Admin.");
          }
        } catch (error) {
          setError(error instanceof Error ? error.message : "An unexpected error occurred.");
        } finally {
          if (button) {
            button.disabled = false;
            button.textContent = "Continue to SQRATCH linking";
          }
        }
      }

      async function handleDisconnect() {
        if (!window.confirm("Disconnect this Shopify store from SQRATCH? You can reconnect it later.")) {
          return;
        }

        const button = document.getElementById("disconnect-button");
        setError("");
        setStatusMessage("");
        setLoading(true, "Disconnecting from SQRATCH…");
        if (button) button.disabled = true;

        try {
          const sessionToken = await getEmbeddedSessionToken();
          const response = await fetch("/api/shopify/embedded/disconnect", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + sessionToken,
            },
            body: JSON.stringify({}),
          });
          if (!response.ok) throw new Error("disconnect failed");

          setUnlinkedState();
          setStatusMessage("Shopify has been disconnected from SQRATCH.", "danger");
        } catch {
          setError("Could not disconnect Shopify. Please try again.");
        } finally {
          if (button) button.disabled = false;
          setLoading(false);
        }
      }

      document.getElementById("continue-button")?.addEventListener("click", handleContinue);
      document.getElementById("disconnect-button")?.addEventListener("click", handleDisconnect);
      void checkEmbeddedStatus();
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": buildShopifyFrameAncestorsCsp(rawShop),
    },
  });
}
