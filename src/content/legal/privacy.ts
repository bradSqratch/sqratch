import type {
  LegalBlock,
  LegalDocument,
  LegalSection,
} from "@/content/legal/types";

const paragraph = (text: string): LegalBlock => ({ type: "paragraph", text });
const subheading = (text: string): LegalBlock => ({
  type: "subheading",
  text,
});
const bullets = (items: string[], code = false): LegalBlock => ({
  type: "bullets",
  items,
  code,
});
const contact = (lines: string[]): LegalBlock => ({ type: "contact", lines });

const sections: LegalSection[] = [
  {
    title: "1. Our Privacy Position",
    blocks: [
      paragraph("SQRATCH is built around privacy-respecting product engagement."),
      paragraph(
        "We are not a surveillance advertising company. We are not a data brokerage company. We do not exist to collect, resell, exploit, or target people using personal data."
      ),
      paragraph(
        "SQRATCH connects real-world products with useful digital experiences, product education, rewards, and commerce pathways. Our approach is based on data minimization, least-privilege access, and trust between brands and their audiences."
      ),
      paragraph(
        "When a merchant installs the SQRATCH Shopify app, SQRATCH requests only the Shopify permissions needed for product display, reward discounts, and prospective conversion attribution."
      ),
      paragraph(
        "The Shopify permissions currently requested by SQRATCH include:"
      ),
      bullets(["read_products", "read_orders", "read_themes", "read_discounts", "write_discounts"], true),
      paragraph(
        "SQRATCH does not request permission to create, edit, or delete Shopify products."
      ),
      paragraph(
        "SQRATCH requests Shopify order access only for conversion attribution. It deliberately does not persist Shopify customer name, email, phone, billing address, shipping address, payment details, or checkout data."
      ),
      paragraph(
        "SQRATCH does not sell merchant data, product data, scan data, reward data, redemption data, account data, or end-user data."
      ),
      paragraph(
        "SQRATCH does not use merchant data, Shopify product data, scan data, reward data, redemption data, or end-user data for surveillance advertising, behavioural advertising, third-party ad targeting, data brokerage, resale, or unrelated commercial monetization."
      ),
      paragraph(
        "SQRATCH does not use merchant data, Shopify product data, reward data, redemption data, or end-user data to train third-party artificial intelligence models."
      ),
      paragraph(
        "This Privacy Policy explains how SQRATCH collects, uses, stores, shares, and protects information when merchants install the SQRATCH Shopify app or use the SQRATCH platform."
      ),
    ],
  },
  {
    title: "2. Information We Collect",
    blocks: [
      paragraph(
        "When a merchant installs or connects the SQRATCH Shopify app, or when an approved brand partner uses the SQRATCH platform, we may collect and process the following information, depending on how the merchant or brand configures and uses SQRATCH:"
      ),
      subheading("Shopify Store Information"),
      paragraph("SQRATCH may collect:"),
      bullets([
        "Shopify shop domain",
        "Shopify store identifier",
        "Shopify app installation status",
        "Shopify connection status",
        "Shopify Admin API access token, stored in encrypted form",
      ]),
      subheading("Shopify Product Information"),
      paragraph(
        "SQRATCH may collect and display product information available through the Shopify permissions approved by the merchant, including:"
      ),
      bullets([
        "Product titles",
        "Product images",
        "Product prices",
        "Product variants",
        "Product handles",
        "Public product URLs",
        "Product identifiers needed to connect Shopify products to SQRATCH experiences, lessons, campaigns, and rewards",
      ]),
      paragraph(
        "SQRATCH does not request permission to create, edit, or delete Shopify products."
      ),
      subheading("Shopify Order and Conversion Information"),
      paragraph(
        "If a merchant grants order access and enables SQRATCH conversion tracking, SQRATCH receives signed Shopify order and refund notifications and records only the commercial fields needed to report which SQRATCH product clicks led to a purchase, including:"
      ),
      bullets([
        "Shopify order identifier and order number",
        "Currency and order amounts (subtotal, discounts, shipping amount, tax, total, refunded total, and net of refunds)",
        "Order financial status and fulfilment status",
        "Order cancellation time and cancellation reason",
        "Shopify order creation and last-updated timestamps",
        "Order line items: product and variant identifiers, product title, SKU, quantity, and line amounts",
        "A record that a signed Shopify notification was received and processed (delivery identifier, topic, processing status, and a one-way digest of the verified message)",
        "A link to the SQRATCH product click that produced the order, matched only by an opaque single-use click token",
      ]),
      paragraph(
        "Shopify order notifications can contain customer name, email address, phone number, billing address, shipping address, and checkout details. SQRATCH deliberately does not read, store, log, or use any of those fields, and there is no column anywhere in SQRATCH that can hold one."
      ),
      paragraph(
        "SQRATCH does not request permission to create, edit, cancel, or fulfil Shopify orders, and does not request broader historical order access."
      ),
      subheading("SQRATCH Account Information"),
      paragraph(
        "SQRATCH may collect account information for approved users of the SQRATCH platform, including:"
      ),
      bullets([
        "Name",
        "Email address",
        "Role",
        "Brand account association",
        "Account approval status",
        "Administrative permissions within SQRATCH",
      ]),
      subheading("Platform Usage and Operational Information"),
      paragraph(
        "SQRATCH may collect limited platform usage and operational information needed to operate, secure, support, and improve the service, including:"
      ),
      bullets([
        "Dashboard activity",
        "Product syncing activity",
        "Campaign configuration activity",
        "Lesson and experience management activity",
        "Reward configuration activity",
        "Login, authentication, and account activity",
        "Error logs",
        "Security logs",
        "Troubleshooting records",
      ]),
      paragraph(
        "This information is used to operate the SQRATCH platform. It is not used for surveillance advertising, behavioural advertising, third-party ad targeting, data brokerage, or resale."
      ),
      subheading("Shopify Discount and Reward Information"),
      paragraph(
        "If a merchant or approved Brand Admin enables SQRATCH rewards, SQRATCH may collect and process information related to reward offers and Shopify discount codes, including:"
      ),
      bullets([
        "Shopify discount code identifiers",
        "Generated discount code values",
        "Discount amounts",
        "Applicable products",
        "Usage limits",
        "Expiration dates",
        "Usage status",
        "Shopify discount status",
      ]),
      subheading("SQRATCH Reward Offer Information"),
      paragraph(
        "SQRATCH may collect information about reward offers configured by approved Brand Admins, including:"
      ),
      bullets([
        "Points cost",
        "Discount amount",
        "Currency",
        "Claim window",
        "Redemption limits",
        "Selected products",
        "Active or inactive status",
        "Reward configuration settings",
      ]),
      subheading("SQRATCH Reward Redemption Information"),
      paragraph(
        "When an eligible SQRATCH user redeems a reward offer, SQRATCH may collect redemption information, including:"
      ),
      bullets([
        "The SQRATCH user or account that redeemed the reward",
        "Redeemed points",
        "Generated discount code",
        "Redemption status",
        "Issue date",
        "Expiration date",
        "Shopify discount status",
      ]),
    ],
  },
  {
    title: "3. Information We Do Not Collect Through Shopify",
    blocks: [
      paragraph(
        "SQRATCH requests Shopify order access only to measure conversion attribution from SQRATCH commerce clicks. Everything SQRATCH does record from an order is listed under “Shopify Order and Conversion Information” above; everything below is what SQRATCH does not collect."
      ),
      paragraph("SQRATCH does not request the Shopify customer permission and does not store Shopify customer records."),
      paragraph("SQRATCH does not store payment information, and never receives card or bank details."),
      paragraph("SQRATCH does not store checkout data."),
      paragraph("SQRATCH does not store billing addresses, shipping addresses, email addresses, or phone numbers."),
      paragraph(
        "SQRATCH stores a single order-level fulfilment status value for reporting. It does not store fulfilment, shipment, tracking, or logistics records, and it cannot create or change a fulfilment."
      ),
      paragraph(
        "Shopify classifies the order permission SQRATCH requests as protected customer data access. SQRATCH does not store or use the protected customer fields those order notifications can contain, and does not request the broader all-orders permission."
      ),
      paragraph(
        "SQRATCH does not process Shopify payments, shipping, or checkout transactions, does not create, modify, cancel, or fulfil orders, and does not process customer records. It records only the minimum order and refund information needed for conversion attribution."
      ),
      paragraph(
        "Product purchases are completed on the merchant’s Shopify store. SQRATCH may display a public Shopify product link or help generate a reward discount code, but the actual commerce transaction occurs on Shopify, not inside SQRATCH."
      ),
      paragraph(
        "SQRATCH does not use Shopify customer-specific discount targeting in its current reward flow. Reward discount codes generated by SQRATCH are single-use codes that may be used once by anyone who has the code."
      ),
    ],
  },
  {
    title: "4. How We Use Information",
    blocks: [
      paragraph(
        "SQRATCH uses collected information only for the purposes described in this Privacy Policy."
      ),
      paragraph("We use information to:"),
      bullets([
        "Connect a Shopify store to a SQRATCH Brand account",
        "Confirm Shopify app installation and connection status",
        "Fetch and display Shopify product information inside SQRATCH",
        "Allow approved Brand Admins and Creators to link Shopify products to SQRATCH experiences, lessons, campaigns, and product discovery areas",
        "Display public Shopify product links so users can visit the merchant’s Shopify storefront",
        "Allow approved Brand Admins to configure reward offers that users can claim with SQRATCH points",
        "Generate single-use Shopify discount codes when eligible SQRATCH users redeem reward offers",
        "Restrict discount codes to selected Shopify products or all eligible products, depending on the Brand Admin’s reward configuration",
        "Check discount code status and usage information for reward history, fraud prevention, support, and troubleshooting",
        "Maintain platform security",
        "Prevent abuse",
        "Provide customer support",
        "Troubleshoot errors",
        "Improve platform reliability",
        "Comply with Shopify platform requirements and applicable privacy, legal, and regulatory obligations",
      ]),
      paragraph(
        "SQRATCH does not use collected information for unrelated advertising, resale, data brokerage, third-party ad targeting, surveillance advertising, or behavioural advertising."
      ),
    ],
  },
  {
    title: "5. Shopify Access Tokens",
    blocks: [
      paragraph(
        "When a merchant connects Shopify to SQRATCH, Shopify provides an access token that allows SQRATCH to use the Shopify permissions approved by the merchant during installation."
      ),
      paragraph("SQRATCH stores this token in encrypted form."),
      paragraph(
        "The token is used only to perform actions permitted by the approved Shopify scopes, including:"
      ),
      bullets([
        "Fetching Shopify product information",
        "Creating single-use reward discount codes",
        "Reading discount-code status for the connected Shopify store",
        "Maintaining the Shopify connection",
      ]),
      paragraph(
        "SQRATCH does not use Shopify access tokens to create, edit, or delete products."
      ),
      paragraph(
        "SQRATCH does not share Shopify access tokens with merchants, creators, users, advertisers, data brokers, or unauthorized third parties."
      ),
      paragraph(
        "Access to systems that store or use Shopify access tokens is restricted to authorized technical personnel and service systems with a legitimate operational need."
      ),
      paragraph(
        "If a merchant disconnects Shopify from SQRATCH or uninstalls the SQRATCH app from Shopify, SQRATCH clears the stored Shopify access token and marks the Shopify connection as disconnected or uninstalled."
      ),
      paragraph(
        "After disconnection or uninstall, SQRATCH will no longer use the Shopify access token to fetch product data, create new Shopify discount codes, or check Shopify discount-code status."
      ),
    ],
  },
  {
    title: "6. Product and Discount Data",
    blocks: [
      paragraph(
        "SQRATCH may store or display Shopify product information such as product names, images, prices, variants, handles, and public product URLs."
      ),
      paragraph(
        "This product data is used to help brands connect Shopify products to SQRATCH experiences, lessons, campaigns, reward offers, and product discovery areas."
      ),
      paragraph(
        "SQRATCH may also create and store information about Shopify discount codes generated through SQRATCH rewards, including:"
      ),
      bullets([
        "Generated code",
        "Discount amount",
        "Applicable products",
        "Usage limits",
        "Expiration date",
        "Shopify discount identifiers",
        "Redemption status",
        "Usage status",
      ]),
      paragraph(
        "Existing discount codes already created in Shopify may remain in the merchant’s Shopify Admin unless the merchant disables or deletes them in Shopify."
      ),
      paragraph(
        "SQRATCH does not process the resulting purchase transaction. Product purchases, checkout, payments, taxes, shipping, fulfillment, returns, and customer service remain the responsibility of the merchant and are completed through the merchant’s Shopify store."
      ),
    ],
  },
  {
    title: "7. Account Approval and Brand Access",
    blocks: [
      paragraph("SQRATCH is built for approved brand partners."),
      paragraph(
        "Merchants, brands, creators, or other users may need approval before accessing the full SQRATCH platform."
      ),
      paragraph(
        "If a user applies for Brand access or platform access, SQRATCH may collect information needed to review and approve the account, including business contact information, brand information, role information, and account eligibility information."
      ),
      paragraph(
        "This information is used only to manage account access, platform permissions, brand relationships, security, support, and compliance."
      ),
    ],
  },
  {
    title: "8. Data Sharing",
    blocks: [
      paragraph("SQRATCH does not sell personal data."),
      paragraph("SQRATCH does not sell merchant data."),
      paragraph("SQRATCH does not sell Shopify product data."),
      paragraph("SQRATCH does not sell scan data."),
      paragraph("SQRATCH does not sell reward data."),
      paragraph("SQRATCH does not sell redemption data."),
      paragraph("SQRATCH does not sell account data."),
      paragraph("SQRATCH does not sell end-user data."),
      paragraph(
        "SQRATCH may share limited information with trusted service providers that help operate, secure, and deliver the SQRATCH platform. These may include providers for:"
      ),
      bullets([
        "Hosting",
        "Cloud infrastructure",
        "Database services",
        "Authentication",
        "Internal product analytics",
        "Error monitoring",
        "Email delivery",
        "Security",
        "Customer support",
      ]),
      paragraph(
        "These service providers are used only to support the operation, security, reliability, and delivery of SQRATCH services."
      ),
      paragraph(
        "Service providers are not permitted to use SQRATCH data for their own advertising, data brokerage, independent commercial resale, or unrelated commercial purposes."
      ),
      paragraph(
        "SQRATCH may also disclose information where required by law, legal process, court order, regulator request, or where reasonably necessary to protect the rights, safety, security, and integrity of SQRATCH, merchants, users, service providers, or the public."
      ),
    ],
  },
  {
    title: "9. Data Retention",
    blocks: [
      paragraph(
        "SQRATCH keeps information only as long as reasonably necessary for the purposes described in this Privacy Policy, unless a longer retention period is required or permitted for legal, security, audit, abuse-prevention, accounting, dispute-resolution, or operational purposes."
      ),
      paragraph(
        "SQRATCH may retain Shopify connection data, product-related data, reward offer records, discount-code records, and redemption records for as long as needed to:"
      ),
      bullets([
        "Provide the service",
        "Support connected Brand accounts",
        "Maintain reward and redemption history",
        "Troubleshoot issues",
        "Prevent abuse or fraud",
        "Maintain platform security",
        "Resolve disputes",
        "Comply with legal obligations",
        "Maintain audit records",
        "Preserve platform continuity",
      ]),
      paragraph(
        "When a merchant uninstalls the Shopify app, SQRATCH clears the stored Shopify access token and marks the store connection as uninstalled."
      ),
      paragraph(
        "Some non-sensitive records, such as connection history, product links, reward offer history, and redemption records, may be retained where necessary for audit, troubleshooting, abuse prevention, legal compliance, accounting, dispute resolution, security, or platform continuity."
      ),
      paragraph(
        "Existing discount codes already created in Shopify may remain in the merchant’s Shopify Admin unless the merchant disables or deletes them in Shopify."
      ),
      paragraph(
        "Merchants may request deletion of retained records by contacting support@sqratch.com, subject to legal, security, audit, abuse-prevention, accounting, dispute-resolution, and operational retention requirements."
      ),
    ],
  },
  {
    title: "10. Shopify Privacy Webhooks",
    blocks: [
      paragraph(
        "SQRATCH responds to Shopify’s required privacy and compliance webhooks, including:"
      ),
      bullets([
        "Customer data request",
        "Customer data redaction",
        "Shop data redaction",
      ]),
      paragraph(
        "SQRATCH deliberately does not persist Shopify customer records, checkout data, payment information, or shipping addresses. Order conversion records contain only the minimum merchant-order and attribution information needed for reporting."
      ),
      paragraph(
        "If SQRATCH receives a valid privacy request from Shopify, SQRATCH will verify and process the request in accordance with Shopify requirements and applicable law."
      ),
      paragraph(
        "Where required, SQRATCH will delete, redact, return, or otherwise process relevant information associated with the request."
      ),
    ],
  },
  {
    title: "11. Security",
    blocks: [
      paragraph(
        "SQRATCH uses reasonable administrative, technical, and organizational safeguards designed to protect information."
      ),
      paragraph("These safeguards may include:"),
      bullets([
        "Encrypted Shopify access-token storage",
        "Encryption in transit",
        "Access controls",
        "Role-based permissions",
        "Authentication",
        "Secure infrastructure practices",
        "Logging",
        "Monitoring",
        "Error tracking",
        "Limited internal access based on operational need",
        "Service-provider controls",
      ]),
      paragraph(
        "No system is completely secure, and SQRATCH cannot guarantee absolute security. However, SQRATCH is designed to limit unnecessary data access, reduce data exposure, and protect the information needed to operate the platform."
      ),
      paragraph(
        "If SQRATCH becomes aware of a privacy or security incident involving personal information, SQRATCH will assess the incident and provide notices where required by applicable law."
      ),
    ],
  },
  {
    title: "12. Merchant Controls",
    blocks: [
      paragraph("Merchants can disconnect Shopify from the SQRATCH dashboard."),
      paragraph(
        "Merchants can also uninstall the SQRATCH app from Shopify Admin."
      ),
      paragraph(
        "Disconnecting or uninstalling the app prevents SQRATCH from continuing to use the Shopify access token to:"
      ),
      bullets([
        "Fetch Shopify product data",
        "Create new Shopify discount codes",
        "Check Shopify discount-code status",
      ]),
      paragraph(
        "When a merchant disconnects Shopify or uninstalls the app, SQRATCH clears the stored Shopify access token and marks the Shopify connection as disconnected or uninstalled."
      ),
      paragraph(
        "Existing discount codes already created in Shopify may remain in the merchant’s Shopify Admin unless the merchant disables or deletes them in Shopify."
      ),
      paragraph(
        "Merchants may contact support@sqratch.com to request assistance with account access, data deletion, connection status, or privacy questions."
      ),
    ],
  },
  {
    title: "13. Individual Privacy Rights and Data Requests",
    blocks: [
      paragraph(
        "Depending on where a merchant, user, or individual is located, they may have privacy rights under applicable law. These rights may include the right to request access to personal information, correction of personal information, deletion of personal information, or information about how personal information is used or disclosed."
      ),
      paragraph("Privacy questions and data requests can be sent to:"),
      contact(["support@sqratch.com"]),
      paragraph(
        "SQRATCH will review and respond to valid privacy requests in accordance with applicable law."
      ),
      paragraph(
        "For requests related to Shopify customer records, payments, checkout, shipping, addresses, or fulfilment, individuals should contact the merchant directly. SQRATCH does not hold that information: the only order data SQRATCH stores is the commercial order and refund information listed in “Shopify Order and Conversion Information” above."
      ),
    ],
  },
  {
    title: "14. Children’s Privacy",
    blocks: [
      paragraph(
        "The SQRATCH Shopify app is intended for merchants, brands, creators, administrators, and other authorized business users."
      ),
      paragraph(
        "SQRATCH does not knowingly collect personal information from children under 13 through the Shopify app."
      ),
      paragraph(
        "If SQRATCH becomes aware that it has collected personal information from a child under 13 without appropriate consent, SQRATCH will take reasonable steps to delete that information."
      ),
    ],
  },
  {
    title: "15. International Processing",
    blocks: [
      paragraph(
        "SQRATCH is based in Canada, but we may process information in Canada, the United States, or other locations where our service providers operate."
      ),
      paragraph(
        "Where information is processed outside a user’s country, province, or region of residence, it may be subject to the laws of that jurisdiction."
      ),
      paragraph(
        "SQRATCH uses contractual, technical, and organizational safeguards designed to protect information regardless of where it is processed."
      ),
    ],
  },
  {
    title: "16. Changes to This Privacy Policy",
    blocks: [
      paragraph("SQRATCH may update this Privacy Policy from time to time."),
      paragraph(
        "If we make material changes, we will update the effective date and may notify users through the platform, by email, or by other reasonable means."
      ),
      paragraph(
        "Continued use of the SQRATCH Shopify app or SQRATCH platform after an updated Privacy Policy becomes effective means the updated policy applies from that effective date onward."
      ),
    ],
  },
  {
    title: "17. Contact Us",
    blocks: [
      paragraph(
        "For privacy questions, data requests, Shopify app questions, or security-related concerns, contact:"
      ),
      contact([
        "support@sqratch.com",
        "Sqratch Inc.",
        "280 Albert Street, Suite 706",
        "Ottawa, ON K1P 5P3",
        "Canada",
      ]),
    ],
  },
];

export const privacyPolicy: LegalDocument = {
  eyebrow: "Legal",
  title: "SQRATCH Privacy Policy",
  effectiveDate: "June 1, 2026",
  company: "Sqratch Inc.",
  contact: "support@sqratch.com",
  intro: [],
  sections,
};
