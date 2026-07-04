import { NextRequest, NextResponse } from "next/server";

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

  const actionMarkup =
    showOAuthFallback && rawShop
      ? `<a class="button" href="/api/shopify/oauth/start?shop=${encodeURIComponent(rawShop)}">Continue to SQRATCH linking</a>`
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
        background: #050714;
        color: #ffffff;
      }

      main {
        min-height: 100vh;
        padding: 2rem 1.25rem;
      }

      .shell {
        display: flex;
        min-height: calc(100vh - 4rem);
        max-width: 48rem;
        align-items: center;
        margin: 0 auto;
      }

      .card {
        width: 100%;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 2rem;
        background: rgba(17, 23, 34, 0.95);
        box-shadow: 0 25px 80px rgba(0, 0, 0, 0.4);
      }

      .header {
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: linear-gradient(90deg, #111827, #0b1020, #172338);
        padding: 1.5rem 1.75rem;
      }

      .eyebrow {
        margin: 0;
        color: #b7a6e8;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.35em;
      }

      h1 {
        margin: 0.75rem 0 0;
        font-size: clamp(1.875rem, 5vw, 2.25rem);
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
        gap: 1.5rem;
        padding: 1.75rem;
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
        border-radius: 1rem;
        background: rgba(0, 0, 0, 0.2);
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
        color: rgba(255, 255, 255, 0.85);
        font-size: 0.875rem;
      }

      .notice {
        border: 1px solid rgba(183, 166, 232, 0.2);
        border-radius: 1rem;
        background: rgba(183, 166, 232, 0.1);
        padding: 1.25rem;
        color: rgba(255, 255, 255, 0.75);
        font-size: 0.875rem;
        line-height: 1.6;
      }

      .error {
        display: none;
        border: 1px solid rgba(248, 113, 113, 0.2);
        border-radius: 1rem;
        background: rgba(239, 68, 68, 0.1);
        padding: 0.75rem 1rem;
        color: #fecaca;
        font-size: 0.875rem;
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
      }

      .button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="shell">
        <div class="card">
          <div class="header">
            <p class="eyebrow">SQRATCH</p>
            <h1>Shopify app setup</h1>
            <p class="lede">This embedded app is a lightweight setup shell. The full product experience stays in the SQRATCH Brand dashboard.</p>
          </div>

          <div class="content">
            <div class="stats">
              <div class="stat">
                <p class="label">Shopify store</p>
                <p class="value">${rawShop ? "Store detected — open via Shopify Admin" : "Open SQRATCH from your Shopify Admin"}</p>
              </div>
              <div class="stat">
                <p class="label">SQRATCH link</p>
                <p class="value">Complete setup to link your store</p>
              </div>
            </div>

            <div class="notice">Link this Shopify store to a SQRATCH Brand account so Brand Admins can display Shopify products inside SQRATCH experiences. SQRATCH requests product access to display Shopify products inside SQRATCH experiences and discount access to create reward codes when brands enable loyalty rewards.</div>
            <p class="error" id="error-message"></p>
            <div class="actions">${actionMarkup}</div>
          </div>
        </div>
      </section>
    </main>

    <script>
      const distribution = ${escapeJs(distribution)};
      const rawShop = ${escapeJs(rawShop)};

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

      async function handleContinue() {
        const button = document.getElementById("continue-button");
        setError("");
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
            if (!window.shopify) {
              throw new Error("App Bridge is not loaded yet. Please reopen SQRATCH from your Shopify Admin.");
            }

            const sessionToken = await window.shopify.idToken();
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

      document.getElementById("continue-button")?.addEventListener("click", handleContinue);
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}
