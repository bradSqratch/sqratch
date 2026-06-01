import type { LegalDocument } from "@/content/legal/types";

export const termsOfService: LegalDocument = {
  eyebrow: "Legal",
  title: "SQRATCH Terms of Service",
  effectiveDate: "June 1st 2026",
  company: "Sqratch Inc.",
  contact: "support@sqratch.com",
  intro: [
    "These Terms of Service govern access to and use of SQRATCH, including the SQRATCH website, dashboard, Shopify app, and related services.",
    "By accessing or using SQRATCH, you agree to these Terms.",
  ],
  sections: [
    {
      title: "1. About SQRATCH",
      paragraphs: [
        "SQRATCH is a platform that helps approved brands create interactive product experiences, lessons, creator-led content, campaigns, and product discovery flows.",
        "The SQRATCH Shopify app allows approved Brand Admins to connect a Shopify store to a SQRATCH Brand account, display Shopify product information inside SQRATCH experiences, and configure reward offers that generate single-use Shopify discount codes when eligible SQRATCH users redeem points.",
      ],
    },
    {
      title: "2. Eligibility and Account Approval",
      paragraphs: [
        "SQRATCH is intended for approved brand partners, creators, administrators, and authorized users.",
        "Some features may require account approval. SQRATCH may approve, reject, suspend, or revoke access to Brand, Creator, or Admin features at its discretion.",
        "You are responsible for ensuring that all information you provide to SQRATCH is accurate and current.",
      ],
    },
    {
      title: "3. Shopify App Usage",
      paragraphs: [
        "The SQRATCH Shopify app allows merchants to connect their Shopify store to a SQRATCH Brand account.",
        "SQRATCH requests Shopify permissions needed to provide product display and reward discount functionality. These permissions currently include read_products, read_discounts, and write_discounts.",
        "The read_products permission allows SQRATCH to read product information such as product title, image, price, variants, handle, and public product URL. The read_discounts and write_discounts permissions allow SQRATCH to create single-use Shopify discount codes for SQRATCH reward redemptions and read discount-code status for redemption history, usage status, support, and troubleshooting.",
        "SQRATCH does not create, edit, or delete Shopify products. SQRATCH does not process Shopify orders, payments, shipping, fulfillment, returns, taxes, or checkout transactions. Product purchases occur on the merchant's Shopify store and are governed by the merchant's own Shopify store policies.",
      ],
    },
    {
      title: "4. Reward Offers and Discount Codes",
      paragraphs: [
        "Approved Brand Admins may configure reward offers that allow eligible SQRATCH users to redeem SQRATCH points for Shopify discount codes.",
        "Reward offers may include a points cost, discount amount, currency, claim window, code expiration period, redemption limits, minimum subtotal, and product eligibility rules. Reward offers may apply to all eligible Shopify products or only to selected Shopify products.",
        "When a user redeems a reward offer, SQRATCH may generate a unique, single-use Shopify discount code through the connected merchant's Shopify store. The user must copy and paste the discount code at Shopify checkout. Discount codes are not automatically applied by SQRATCH.",
        "Unless otherwise configured, reward discount codes are single-use codes. Anyone with the code may be able to use it once. Merchants are responsible for reviewing reward offer settings before enabling them.",
        "SQRATCH may debit points from the user's SQRATCH account when a reward is redeemed. SQRATCH may show the user redemption history and discount-code status. Shopify discount usage status may not update instantly.",
        "Merchants remain responsible for honoring discounts created through their connected Shopify store and for managing any discount codes in Shopify Admin, including disabling or deleting codes if needed.",
      ],
    },
    {
      title: "5. Brand Responsibilities",
      paragraphs: ["Brands are responsible for:"],
      bullets: [
        "Ensuring they have the right to connect their Shopify store to SQRATCH",
        "Ensuring product information, images, descriptions, and pricing are accurate",
        "Ensuring their SQRATCH experiences, lessons, campaigns, and public content comply with applicable laws and platform rules",
        "Managing their Shopify store, checkout, products, fulfillment, returns, taxes, and customer service",
        "Ensuring that any creators or collaborators they work with have appropriate rights and permissions",
        "Reviewing and configuring reward offer rules, including points cost, discount amount, claim period, expiration period, eligible products, redemption limits, and minimum subtotal",
        "Ensuring reward offers and discount codes comply with applicable laws, advertising rules, consumer protection rules, and Shopify policies",
        "Managing, disabling, or deleting Shopify discount codes in Shopify Admin when necessary",
        "Honoring valid discount codes generated through the connected Shopify store, subject to the merchant's own store policies and applicable law",
      ],
    },
    {
      title: "6. Creator and User Content",
      paragraphs: [
        "SQRATCH may allow Brands, Creators, or users to create, upload, publish, comment on, or interact with content.",
        "You are responsible for the content you submit to SQRATCH. You represent that you have the necessary rights to use and share that content.",
        "You may not submit content that is unlawful, misleading, infringing, abusive, harmful, defamatory, or otherwise violates these Terms.",
        "SQRATCH may remove content or restrict access if we believe it violates these Terms, platform rules, legal obligations, or the rights of others.",
      ],
    },
    {
      title: "7. Acceptable Use",
      paragraphs: ["You agree not to:"],
      bullets: [
        "Use SQRATCH for unlawful, deceptive, or harmful activity",
        "Attempt to gain unauthorized access to SQRATCH systems or accounts",
        "Interfere with platform security or performance",
        "Misrepresent your identity, brand, store, or affiliation",
        "Upload malware, malicious code, or harmful content",
        "Use SQRATCH to infringe intellectual property rights",
        "Abuse Shopify API access or attempt to access data beyond granted permissions",
        "Abuse, manipulate, resell, share, or exploit SQRATCH reward codes in a deceptive or unauthorized way",
        "Attempt to redeem rewards without the required SQRATCH points, campaign unlock, or account eligibility",
        "Create misleading reward offers, fake discounts, or deceptive claims about pricing or product availability",
      ],
    },
    {
      title: "8. Shopify Connection, Disconnect, and Uninstall",
      paragraphs: [
        "A Brand Admin may disconnect Shopify from the SQRATCH dashboard.",
        "A merchant may also uninstall the SQRATCH app from Shopify Admin.",
        "When Shopify is disconnected or the app is uninstalled, SQRATCH clears stored Shopify token access and stops using the token to fetch Shopify product data, create new Shopify discount codes, or check Shopify discount-code status.",
        "Some non-sensitive historical records may be retained for security, audit, troubleshooting, abuse prevention, legal compliance, or platform continuity. Existing Shopify discount codes already created before disconnect or uninstall may remain in the merchant's Shopify Admin unless the merchant disables or deletes them in Shopify.",
      ],
    },
    {
      title: "9. Fees and Payment",
      paragraphs: [
        "The SQRATCH Shopify app is currently offered as a free app.",
        "SQRATCH may introduce paid plans or premium features in the future. If pricing changes, SQRATCH will provide notice and any required payment terms before charging for paid features.",
      ],
    },
    {
      title: "10. Third-Party Services",
      paragraphs: [
        "SQRATCH integrates with third-party services, including Shopify.",
        "Your use of Shopify is governed by Shopify's own terms and policies.",
        "SQRATCH is not responsible for Shopify's platform, checkout, payments, discount application behavior, order fulfillment, returns, taxes, shipping, or third-party services outside SQRATCH's control.",
      ],
    },
    {
      title: "11. Intellectual Property",
      paragraphs: [
        "SQRATCH owns or licenses the platform, software, design, branding, and related intellectual property.",
        "You retain ownership of content you submit, subject to the rights you grant SQRATCH to operate and provide the service.",
        "By submitting content to SQRATCH, you grant SQRATCH a limited, non-exclusive, worldwide license to host, store, display, reproduce, and process that content as needed to provide the service.",
      ],
    },
    {
      title: "12. Confidentiality and Security",
      paragraphs: [
        "You are responsible for maintaining the confidentiality of your account credentials.",
        "You agree to notify SQRATCH promptly if you believe your account has been compromised.",
        "SQRATCH uses reasonable security measures, but no system can be guaranteed to be completely secure.",
      ],
    },
    {
      title: "13. Availability and Changes",
      paragraphs: [
        "SQRATCH may update, modify, suspend, or discontinue features at any time.",
        "SQRATCH may also perform maintenance or experience downtime. We are not liable for interruptions, delays, or unavailability of the service.",
      ],
    },
    {
      title: "14. Disclaimers",
      paragraphs: [
        "SQRATCH is provided on an \"as is\" and \"as available\" basis.",
        "To the maximum extent permitted by law, SQRATCH disclaims warranties of merchantability, fitness for a particular purpose, non-infringement, and uninterrupted or error-free operation.",
      ],
    },
    {
      title: "15. Limitation of Liability",
      paragraphs: [
        "To the maximum extent permitted by law, SQRATCH and its owners, employees, contractors, and service providers will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages.",
        "SQRATCH's total liability for any claim related to the service will not exceed the amount paid by you to SQRATCH for the service during the three months before the claim arose, or one hundred U.S. dollars if no amount was paid.",
        "SQRATCH is not liable for losses, costs, pricing errors, discount misuse, checkout behavior, fulfillment issues, or customer disputes arising from merchant-configured reward offers or Shopify discount codes, except where prohibited by applicable law.",
      ],
    },
    {
      title: "16. Indemnification",
      paragraphs: ["You agree to indemnify and hold harmless SQRATCH from claims, damages, liabilities, costs, and expenses arising from:"],
      bullets: [
        "Your use of SQRATCH",
        "Your content",
        "Your Shopify store or products",
        "Your violation of these Terms",
        "Your violation of law or third-party rights",
      ],
    },
    {
      title: "17. Termination",
      paragraphs: [
        "SQRATCH may suspend or terminate access if you violate these Terms, misuse the platform, create risk for SQRATCH or others, or fail to meet approval requirements.",
        "You may stop using SQRATCH at any time. Shopify merchants may uninstall the SQRATCH Shopify app from Shopify Admin.",
      ],
    },
    {
      title: "18. Governing Law",
      paragraphs: [
        "These Terms are governed by the laws of the Province of Ontario and the federal laws of Canada applicable therein, without regard to conflict of law rules.",
        "Any disputes will be resolved in the courts located in Ontario, Canada, unless applicable law requires otherwise.",
      ],
    },
    {
      title: "19. Changes to These Terms",
      paragraphs: [
        "SQRATCH may update these Terms from time to time. If we make material changes, we will update the effective date and may notify users through the platform or by email.",
        "Continued use of SQRATCH after changes become effective means you accept the updated Terms.",
      ],
    },
    {
      title: "20. Contact",
      paragraphs: [
        "For questions about these Terms, contact:",
        "support@sqratch.com",
        "Sqratch Inc.",
        "280 Albert Street, Suite 706,",
        "Ottawa ON K1P 5P3",
      ],
    },
  ],
};
