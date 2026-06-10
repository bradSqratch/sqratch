import type {
  LegalBlock,
  LegalDocument,
  LegalSection,
} from "@/content/legal/types";

const paragraph = (text: string): LegalBlock => ({ type: "paragraph", text });
const bullets = (items: string[], code = false): LegalBlock => ({
  type: "bullets",
  items,
  code,
});
const contact = (lines: string[]): LegalBlock => ({ type: "contact", lines });

const sections: LegalSection[] = [
  {
    title: "1. About SQRATCH",
    blocks: [
      paragraph(
        "SQRATCH is a privacy-respecting product engagement platform that helps approved brands create interactive product experiences, lessons, creator-led content, campaigns, rewards, and product discovery flows.",
      ),
      paragraph(
        "The SQRATCH Shopify app allows approved Brand Admins to connect a Shopify store to a SQRATCH Brand account, display Shopify product information inside SQRATCH experiences, and configure reward offers that may generate single-use Shopify discount codes when eligible SQRATCH users redeem SQRATCH points.",
      ),
      paragraph(
        "SQRATCH is a software platform. SQRATCH is not the seller, merchant of record, payment processor, checkout provider, shipping provider, fulfillment provider, tax provider, return provider, customer service provider, or guarantor of any product, reward, discount, offer, transaction, claim, campaign, or content provided by a Brand, merchant, Creator, or third party.",
      ),
      paragraph(
        "Product purchases, checkout, payments, shipping, fulfillment, taxes, returns, refunds, warranties, and customer service are handled by the merchant through the merchant’s Shopify store or other third-party systems.",
      ),
    ],
  },
  {
    title: "2. Definitions",
    blocks: [
      paragraph("For purposes of these Terms:"),
      {
        type: "definitions",
        items: [
          {
            term: "“SQRATCH,” “we,” “us,” and “our”",
            description:
              "mean Sqratch Inc. and its platform, software, Shopify app, website, dashboard, and related services.",
          },
          {
            term: "“Service”",
            description:
              "means SQRATCH’s website, dashboard, Shopify app, platform, software, product experiences, lessons, creator tools, campaigns, rewards, product discovery features, and related services.",
          },
          {
            term: "“Shopify App”",
            description:
              "means the SQRATCH application installed or connected through Shopify.",
          },
          {
            term: "“Brand”",
            description:
              "means a business, merchant, product company, organization, or approved partner that uses SQRATCH to create or manage campaigns, product experiences, rewards, or content.",
          },
          {
            term: "“Merchant”",
            description:
              "means a Shopify store owner, operator, or authorized representative that connects a Shopify store to SQRATCH.",
          },
          {
            term: "“Brand Admin”",
            description:
              "means an authorized user who manages a Brand account, Shopify connection, campaigns, product connections, rewards, users, Creators, or related settings in SQRATCH.",
          },
          {
            term: "“Creator”",
            description:
              "means a person or organization that creates, uploads, publishes, appears in, or contributes content through SQRATCH.",
          },
          {
            term: "“User”",
            description:
              "means any person who accesses or uses SQRATCH, including Brand Admins, Creators, merchants, administrators, collaborators, and end users.",
          },
          {
            term: "“End User”",
            description:
              "means a person who views, scans, unlocks, participates in, earns points through, or redeems rewards through a SQRATCH experience.",
          },
          {
            term: "“Content”",
            description:
              "means videos, images, text, lessons, comments, product information, campaign materials, names, logos, trademarks, likenesses, voices, audio, visuals, descriptions, claims, files, data, links, and other materials submitted, uploaded, published, displayed, or made available through SQRATCH.",
          },
          {
            term: "“Experience”",
            description:
              "means a digital experience, lesson, unlock, product page, educational flow, creator-led content flow, campaign flow, reward flow, or product discovery flow created or made available through SQRATCH.",
          },
          {
            term: "“Campaign”",
            description:
              "means a Brand-created or SQRATCH-enabled initiative involving product experiences, QR codes, scratch-to-reveal activations, content, rewards, points, product discovery, or related functionality.",
          },
          {
            term: "“Reward Offer”",
            description:
              "means an offer configured by a Brand Admin that allows eligible users to redeem SQRATCH points for a discount code, benefit, access, product-related offer, or other reward.",
          },
          {
            term: "“Points”",
            description:
              "means promotional, loyalty, engagement, or platform credits that may be earned, displayed, adjusted, or redeemed through SQRATCH, subject to these Terms.",
          },
          {
            term: "“Discount Code”",
            description:
              "means a Shopify discount code or other promotional code generated, displayed, connected, or managed through SQRATCH reward functionality.",
          },
          {
            term: "“Connected Shopify Store”",
            description:
              "means a Shopify store connected to a SQRATCH Brand account through the SQRATCH Shopify app.",
          },
        ],
      },
    ],
  },
  {
    title: "3. Eligibility and Account Approval",
    blocks: [
      paragraph(
        "SQRATCH is intended for approved brand partners, merchants, creators, administrators, collaborators, and authorized users.",
      ),
      paragraph(
        "Some features may require account approval. SQRATCH may approve, reject, suspend, limit, or revoke access to Brand, Creator, Admin, Shopify app, campaign, reward, or platform features at its discretion.",
      ),
      paragraph(
        "You are responsible for ensuring that all information you provide to SQRATCH is accurate, complete, current, and not misleading.",
      ),
      paragraph("You may not use SQRATCH if:"),
      bullets([
        "you are not authorized to accept these Terms;",
        "you are prohibited from using the Service under applicable law;",
        "your account was previously suspended or terminated by SQRATCH;",
        "you are using SQRATCH on behalf of a Brand, merchant, or organization without authority;",
        "your use would violate applicable law, Shopify requirements, third-party rights, or these Terms.",
      ]),
      paragraph(
        "Approval to use SQRATCH does not create a partnership, joint venture, franchise, agency, employment, fiduciary, or exclusive relationship between you and SQRATCH.",
      ),
    ],
  },
  {
    title: "4. Shopify App Usage",
    blocks: [
      paragraph(
        "The SQRATCH Shopify app allows merchants to connect their Shopify store to a SQRATCH Brand account.",
      ),
      paragraph(
        "SQRATCH requests Shopify permissions needed to provide product display and reward discount functionality. These permissions currently include:",
      ),
      bullets(["read_products", "read_discounts", "write_discounts"], true),
      paragraph(
        "The read_products permission allows SQRATCH to read product information such as product title, image, price, variants, handle, and public product URL.",
      ),
      paragraph(
        "The read_discounts and write_discounts permissions allow SQRATCH to create single-use Shopify discount codes for SQRATCH reward redemptions and read discount-code status for redemption history, usage status, support, fraud prevention, and troubleshooting.",
      ),
      paragraph(
        "SQRATCH does not request permission to create, edit, or delete Shopify products.",
      ),
      paragraph(
        "SQRATCH does not process Shopify orders, payments, shipping, fulfillment, returns, taxes, or checkout transactions.",
      ),
      paragraph(
        "Product purchases occur on the merchant’s Shopify store and are governed by the merchant’s own Shopify store policies, checkout flow, payment processor, shipping rules, return policies, tax settings, terms, and privacy practices.",
      ),
      paragraph(
        "Shopify functionality depends on Shopify’s platform, APIs, app permissions, merchant configuration, discount functionality, checkout behaviour, access scopes, rate limits, app review processes, and third-party systems. SQRATCH is not responsible for Shopify outages, Shopify API changes, Shopify access-scope changes, Shopify app review decisions, Shopify checkout behaviour, Shopify discount behaviour, Shopify Admin configuration, theme conflicts, app conflicts, payment processor behaviour, or other third-party systems outside SQRATCH’s control.",
      ),
      paragraph(
        "If a merchant removes required permissions, disconnects Shopify, uninstalls the app, modifies Shopify settings, disables discounts, changes products, deletes products, changes product eligibility, changes checkout settings, or otherwise changes the Connected Shopify Store, some SQRATCH features may stop working or may not work as expected.",
      ),
    ],
  },
  {
    title: "5. SQRATCH Points",
    paragraphs: [
      "SQRATCH points are promotional, loyalty, engagement, or platform credits only.",
      "Points have no cash value.",
      "Points are not legal tender.",
      "Points are not stored value.",
      "Points are not gift cards.",
      "Points are not securities.",
      "Points are not property.",
      "Points do not create any deposit, banking, fiduciary, trust, custodial, employment, wage, investment, or ownership relationship.",
      "Points may not be sold, transferred, assigned, brokered, exchanged, pledged, inherited, or redeemed for cash unless expressly permitted by SQRATCH in writing.",
      "SQRATCH may create, modify, adjust, suspend, reverse, revoke, expire, cancel, or terminate points, point balances, point rules, earning rules, redemption rules, reward eligibility, or point-related features at any time, subject to applicable law.",
      "SQRATCH may correct point balances or reward records if we believe there has been an error, fraud, abuse, technical issue, unauthorized activity, multiple-account misuse, campaign manipulation, QR manipulation, code manipulation, system failure, or other misuse.",
      "A displayed point balance does not guarantee that points may be redeemed for any particular reward, discount, product, experience, access, or benefit.",
    ],
  },
  {
    title: "6. Reward Offers and Discount Codes",
    paragraphs: [
      "Approved Brand Admins may configure Reward Offers that allow eligible SQRATCH users to redeem SQRATCH points for Shopify discount codes or other benefits.",
      "Reward Offers may include a points cost, discount amount, currency, claim window, code expiration period, redemption limits, minimum subtotal, product eligibility rules, usage limits, campaign eligibility, and other configuration settings.",
      "Reward Offers may apply to all eligible Shopify products or only to selected Shopify products, depending on the Brand Admin’s configuration.",
      "When a user redeems a Reward Offer, SQRATCH may generate a unique, single-use Shopify discount code through the Connected Shopify Store. The user must copy and paste the discount code at Shopify checkout unless otherwise supported by the merchant’s Shopify configuration. Discount codes are not automatically applied by SQRATCH.",
      "Unless otherwise configured, reward discount codes are single-use codes. Anyone with the code may be able to use it once. SQRATCH is not responsible for discount codes that are copied, shared, lost, stolen, misused, resold, posted publicly, or used by someone other than the intended recipient.",
      "Merchants and Brand Admins are responsible for reviewing reward settings before enabling Reward Offers, including points cost, discount amount, eligible products, minimum subtotal, redemption limits, expiration dates, usage limits, stacking behaviour, and claim windows.",
      "Merchants remain responsible for honoring valid discount codes generated through their Connected Shopify Store, subject to the merchant’s own store policies, Shopify configuration, consumer protection obligations, and applicable law.",
      "Merchants are solely responsible for the commercial, financial, tax, pricing, margin, accounting, promotional, consumer protection, advertising, and legal consequences of Reward Offers and discount codes configured through their Connected Shopify Store.",
      "SQRATCH does not guarantee that any reward, product, discount, benefit, access, or experience will remain available.",
      "A Reward Offer, discount code, or redemption may fail, expire, be unavailable, or be cancelled due to merchant configuration, product availability, Shopify behaviour, technical issues, legal requirements, fraud prevention, abuse prevention, campaign settings, account eligibility, or other factors.",
      "Shopify discount usage status, redemption status, reward status, and related dashboard information may not update instantly and may be delayed, incomplete, or affected by Shopify systems, merchant settings, network issues, user behaviour, or technical limitations.",
      "Existing Shopify discount codes created before disconnect, uninstall, termination, suspension, or campaign changes may remain in the merchant’s Shopify Admin unless the merchant disables or deletes them in Shopify.",
    ],
  },
  {
    title: "7. Reward Integrity and Abuse Prevention",
    blocks: [
      paragraph(
        "You may not abuse, manipulate, exploit, resell, automate, scrape, broker, share, or misuse SQRATCH points, Reward Offers, discount codes, unlocks, campaigns, QR codes, scratch-to-reveal mechanisms, referrals, account eligibility, or platform features.",
      ),
      paragraph("Prohibited reward-related activity includes:"),
      bullets([
        "creating or using multiple accounts to manipulate points or rewards;",
        "using bots, scripts, automation, farms, fake accounts, or artificial traffic;",
        "manipulating scans, unlocks, QR codes, scratch codes, campaign access, or engagement events;",
        "attempting to redeem rewards without required points, eligibility, unlocks, or account permissions;",
        "exploiting bugs, errors, vulnerabilities, delays, or configuration mistakes;",
        "reselling, brokering, posting, or distributing discount codes without authorization;",
        "using discount codes in a deceptive, unlawful, or unauthorized way;",
        "interfering with SQRATCH fraud prevention, security, or eligibility systems;",
        "making false claims about rewards, points, discounts, prices, product availability, or campaign eligibility.",
      ]),
      paragraph(
        "SQRATCH may suspend, reverse, cancel, withhold, adjust, expire, or revoke points, Reward Offers, discount codes, redemptions, campaign access, account privileges, or platform access if SQRATCH believes, in its reasonable discretion, that there has been fraud, abuse, manipulation, technical error, unauthorized access, automated activity, multiple-account abuse, code sharing, resale, circumvention, or other misuse of the Service.",
      ),
      paragraph(
        "SQRATCH may also limit, suspend, or terminate accounts or campaigns that create legal, operational, reputational, platform, security, fraud, consumer protection, or abuse risk.",
      ),
    ],
  },
  {
    title: "8. Brand and Merchant Responsibilities",
    blocks: [
      paragraph("Brands, merchants, and Brand Admins are responsible for:"),
      bullets([
        "ensuring they have the right and authority to connect their Shopify store to SQRATCH;",
        "ensuring product information, images, descriptions, pricing, availability, claims, and public product URLs are accurate and not misleading;",
        "managing their Shopify store, checkout, products, payments, taxes, fulfillment, shipping, returns, refunds, warranties, and customer service;",
        "ensuring their SQRATCH experiences, lessons, campaigns, creator content, product discovery flows, Reward Offers, and public content comply with applicable laws, regulations, industry rules, platform rules, Shopify policies, consumer protection rules, advertising rules, privacy laws, and third-party rights;",
        "ensuring that any Creators, collaborators, agencies, employees, contractors, athletes, influencers, ambassadors, or contributors they work with have appropriate rights, permissions, releases, consents, contracts, and authority;",
        "reviewing and configuring Reward Offer rules, including points cost, discount amount, claim period, expiration period, eligible products, redemption limits, usage limits, discount stacking, and minimum subtotal;",
        "ensuring Reward Offers and discount codes comply with applicable laws, advertising rules, consumer protection rules, tax rules, promotional rules, and Shopify policies;",
        "managing, disabling, or deleting Shopify discount codes in Shopify Admin when necessary;",
        "honoring valid discount codes generated through the Connected Shopify Store, subject to the merchant’s own store policies and applicable law;",
        "responding to customer service issues, product questions, returns, refunds, warranty claims, fulfillment disputes, tax questions, and payment disputes;",
        "providing any legally required disclosures, warnings, age gates, eligibility restrictions, contest rules, promotion terms, product warnings, health warnings, regulated-product notices, influencer disclosures, or consumer disclosures.",
      ]),
      paragraph(
        "SQRATCH is not responsible for a Brand’s products, product claims, product quality, product safety, product availability, pricing, discounts, promotions, taxes, customer service, fulfillment, shipping, returns, refunds, regulated-product compliance, creator relationships, or consumer disputes.",
      ),
    ],
  },
  {
    title: "9. Regulated Products, Restricted Content, and Product Claims",
    blocks: [
      paragraph(
        "Brands are solely responsible for ensuring that their products, campaigns, experiences, lessons, Creator content, product claims, Reward Offers, discount codes, and use of SQRATCH comply with all applicable laws, regulations, industry rules, platform rules, age restrictions, advertising standards, consumer protection laws, and product-specific requirements.",
      ),
      paragraph("This includes, where applicable, rules related to:"),
      bullets([
        "cannabis;",
        "alcohol;",
        "tobacco or nicotine;",
        "supplements;",
        "natural health products;",
        "food and beverage products;",
        "pharmaceuticals;",
        "medical devices;",
        "cosmetics;",
        "financial products;",
        "age-restricted products;",
        "contests, sweepstakes, and promotions;",
        "health claims;",
        "therapeutic claims;",
        "performance claims;",
        "environmental claims;",
        "financial claims;",
        "influencer marketing;",
        "endorsements;",
        "testimonials;",
        "product warnings;",
        "youth-directed advertising;",
        "regional restrictions.",
      ]),
      paragraph(
        "Brands may not use SQRATCH to publish or distribute unlawful, misleading, unsubstantiated, deceptive, harmful, unsafe, infringing, defamatory, abusive, exploitative, or non-compliant content.",
      ),
      paragraph(
        "SQRATCH may reject, remove, restrict, suspend, disable, geofence, age-gate, or require changes to any Brand account, campaign, Reward Offer, product connection, experience, lesson, Creator content, or use of the platform if SQRATCH believes it may violate law, platform rules, third-party rights, these Terms, Shopify requirements, public safety, consumer protection standards, or SQRATCH’s reputation or operational integrity.",
      ),
      paragraph(
        "SQRATCH’s review, approval, support, or publication of a Brand, campaign, product, experience, Creator, reward, or content does not mean SQRATCH has verified legal compliance, product claims, regulatory status, rights ownership, product safety, advertising compliance, or truthfulness.",
      ),
    ],
  },
  {
    title: "10. Creator and User Content",
    blocks: [
      paragraph(
        "SQRATCH may allow Brands, Creators, or users to create, upload, publish, display, comment on, link to, distribute, or interact with Content.",
      ),
      paragraph(
        "You are responsible for all Content you submit, upload, publish, display, link, provide, or make available through SQRATCH.",
      ),
      paragraph("You represent and warrant that:"),
      bullets([
        "you own or have all necessary rights, licenses, permissions, releases, and consents to use and share the Content;",
        "the Content does not violate any law, regulation, contract, platform rule, third-party right, intellectual property right, privacy right, publicity right, image right, moral right, confidentiality obligation, or these Terms;",
        "the Content is not unlawful, misleading, deceptive, infringing, defamatory, abusive, harmful, exploitative, unsafe, or otherwise inappropriate;",
        "any product claims, endorsements, testimonials, or promotional statements in the Content are truthful, substantiated, compliant, and not misleading;",
        "any required influencer, sponsorship, endorsement, paid relationship, affiliate, or material connection disclosures are properly provided.",
      ]),
      paragraph("You may not submit Content that:"),
      bullets([
        "infringes intellectual property rights;",
        "misuses another person’s name, image, likeness, voice, identity, or personal information;",
        "includes music, video, images, logos, trademarks, artwork, or other protected materials without permission;",
        "contains malware, malicious code, or harmful material;",
        "is unlawful, threatening, abusive, defamatory, obscene, hateful, discriminatory, misleading, deceptive, or harmful;",
        "violates regulated-product rules, age restrictions, advertising laws, or consumer protection obligations;",
        "encourages fraud, abuse, unsafe conduct, or illegal activity.",
      ]),
      paragraph(
        "SQRATCH may remove, restrict, disable, modify access to, or refuse to display any Content if we believe it violates these Terms, platform rules, legal obligations, Shopify requirements, third-party rights, public safety, consumer protection standards, or SQRATCH’s operational or reputational integrity.",
      ),
    ],
  },
  {
    title: "11. Content License",
    paragraphs: [
      "You retain ownership of Content you submit to SQRATCH, subject to the rights you grant SQRATCH under these Terms.",
      "By submitting, uploading, publishing, linking, or otherwise making Content available through SQRATCH, you grant SQRATCH a limited, non-exclusive, worldwide, royalty-free license to host, store, reproduce, display, transmit, distribute, process, format, modify for technical purposes, create previews or thumbnails, make available, and otherwise use that Content as reasonably necessary to operate, provide, secure, support, promote, and improve the Service.",
      "This license includes the right to display Content in SQRATCH experiences, lessons, campaigns, dashboards, product discovery areas, reward flows, platform interfaces, user-facing experiences, administrative tools, support tools, and technical systems.",
      "To the extent permitted by applicable law, you waive, or agree not to assert, any moral rights or similar rights that would prevent SQRATCH from technically formatting, resizing, displaying, excerpting, adapting for platform functionality, or otherwise using the Content as permitted by these Terms.",
      "SQRATCH may preserve copies of Content where reasonably necessary for backup, legal compliance, audit, dispute resolution, security, abuse prevention, troubleshooting, or platform continuity.",
      "SQRATCH’s use of Brand names, logos, trademarks, or campaign materials for public marketing, case studies, press, investor materials, or promotional purposes may be subject to separate approval, unless such use is already reasonably necessary to provide the Service or display the Brand’s own SQRATCH experiences.",
    ],
  },
  {
    title: "12. Intellectual Property",
    blocks: [
      paragraph(
        "SQRATCH owns or licenses the platform, software, design, branding, trademarks, logos, interface, workflows, systems, documentation, technology, code, product architecture, and related intellectual property.",
      ),
      paragraph(
        "Except for rights expressly granted under these Terms, no rights are transferred to you.",
      ),
      paragraph("You may not:"),
      bullets([
        "copy, modify, reverse engineer, decompile, disassemble, or attempt to derive source code from SQRATCH;",
        "create derivative works based on SQRATCH;",
        "remove proprietary notices;",
        "use SQRATCH branding without permission;",
        "access SQRATCH to build a competing product or service;",
        "scrape, extract, or harvest data except as expressly permitted;",
        "bypass technical restrictions, access controls, or security measures.",
      ]),
      paragraph(
        "If you provide suggestions, feedback, ideas, feature requests, comments, improvements, or recommendations to SQRATCH, you grant SQRATCH the right to use them without restriction or compensation to you.",
      ),
    ],
  },
  {
    title: "13. Acceptable Use",
    blocks: [
      paragraph("You agree not to:"),
      bullets([
        "use SQRATCH for unlawful, deceptive, harmful, abusive, exploitative, or fraudulent activity;",
        "attempt to gain unauthorized access to SQRATCH systems, accounts, data, tokens, APIs, or infrastructure;",
        "interfere with platform security, integrity, availability, or performance;",
        "misrepresent your identity, brand, store, affiliation, authority, eligibility, or relationship with SQRATCH;",
        "upload malware, malicious code, harmful content, or unauthorized tracking technology;",
        "use SQRATCH to infringe intellectual property, privacy, publicity, confidentiality, or other third-party rights;",
        "abuse Shopify API access or attempt to access data beyond granted permissions;",
        "scrape, crawl, harvest, copy, or extract data without authorization;",
        "reverse engineer or attempt to discover non-public platform functionality;",
        "load test, stress test, or security test SQRATCH without written permission;",
        "abuse, manipulate, resell, share, broker, or exploit SQRATCH reward codes, points, campaigns, unlocks, or discounts in a deceptive or unauthorized way;",
        "attempt to redeem rewards without the required SQRATCH points, campaign unlock, account eligibility, or permissions;",
        "create misleading Reward Offers, fake discounts, deceptive claims, false scarcity, false pricing, or misleading claims about product availability;",
        "bypass or interfere with age gates, eligibility rules, geofencing, access controls, campaign rules, or reward restrictions;",
        "use SQRATCH to collect personal information without lawful notice, consent, authority, or compliance;",
        "use SQRATCH in a way that creates legal, regulatory, platform, operational, reputational, security, or consumer protection risk for SQRATCH or others.",
      ]),
    ],
  },
  {
    title: "14. Shopify Connection, Disconnect, and Uninstall",
    paragraphs: [
      "A Brand Admin may disconnect Shopify from the SQRATCH dashboard.",
      "A merchant may also uninstall the SQRATCH app from Shopify Admin.",
      "When Shopify is disconnected or the app is uninstalled, SQRATCH clears the stored Shopify access token and stops using the token to fetch Shopify product data, create new Shopify discount codes, or check Shopify discount-code status.",
      "Some non-sensitive historical records may be retained for security, audit, troubleshooting, abuse prevention, legal compliance, accounting, dispute resolution, analytics continuity, or platform continuity, as described in the SQRATCH Privacy Policy.",
      "Existing Shopify discount codes already created before disconnect or uninstall may remain in the merchant’s Shopify Admin unless the merchant disables or deletes them in Shopify.",
      "Disconnecting or uninstalling SQRATCH may affect active campaigns, product experiences, reward offers, point redemptions, discount status, product displays, analytics, and other Shopify-connected functionality.",
      "SQRATCH is not responsible for losses, disputes, customer service issues, pricing issues, discount issues, or campaign issues caused by disconnecting Shopify, uninstalling the app, removing permissions, changing Shopify settings, disabling discounts, deleting products, or modifying merchant configurations.",
    ],
  },
  {
    title: "15. Privacy and Data",
    paragraphs: [
      "SQRATCH’s collection, use, storage, sharing, and protection of information is governed by the SQRATCH Privacy Policy.",
      "SQRATCH is designed around data minimization, least-privilege access, and privacy-respecting product engagement.",
      "SQRATCH is not designed as a surveillance advertising platform, data brokerage platform, or behavioural advertising network.",
      "SQRATCH does not request access to Shopify orders, Shopify customer records, payment information, checkout data, shipping addresses, fulfillment information, or protected customer data through the Shopify app.",
      "SQRATCH does not sell merchant data, product data, scan data, reward data, redemption data, account data, or end-user data.",
      "SQRATCH does not use merchant data, Shopify product data, reward data, redemption data, or end-user data to train third-party artificial intelligence models.",
      "For privacy questions or data requests, contact support@sqratch.com.",
    ],
  },
  {
    title: "16. Fees and Payment",
    paragraphs: [
      "The SQRATCH Shopify app is currently offered as a free app.",
      "SQRATCH may introduce paid plans, premium features, usage-based fees, subscriptions, implementation fees, service fees, or other paid offerings in the future.",
      "If pricing changes or paid features are introduced, SQRATCH will provide notice and any required payment terms before charging for paid features.",
      "Paid features, if introduced, will be subject to the pricing, billing, renewal, cancellation, refund, tax, and payment terms presented at the time of purchase or agreed in a separate written agreement.",
      "You are responsible for all applicable taxes, duties, levies, and governmental charges associated with paid use of SQRATCH, except taxes based on SQRATCH’s income.",
      "SQRATCH may suspend or limit access to paid features for non-payment, failed payment, chargeback, billing disputes, or violation of applicable payment terms.",
      "Unless otherwise stated in writing, fees are non-refundable except where required by law.",
    ],
  },
  {
    title: "17. Third-Party Services",
    paragraphs: [
      "SQRATCH integrates with third-party services, including Shopify.",
      "Your use of Shopify is governed by Shopify’s own terms, policies, app permissions, checkout systems, payment systems, discount systems, APIs, and platform rules.",
      "SQRATCH is not responsible for Shopify’s platform, checkout, payments, discount application behaviour, order fulfillment, returns, taxes, shipping, app review decisions, API availability, rate limits, access-scope changes, outages, merchant configuration, theme conflicts, third-party app conflicts, or third-party services outside SQRATCH’s control.",
      "SQRATCH may also use third-party service providers for hosting, cloud infrastructure, database services, authentication, email delivery, analytics, error monitoring, support, payments, security, and other operational purposes.",
      "SQRATCH is not responsible for third-party services except to the extent required by applicable law.",
    ],
  },
  {
    title: "18. Confidentiality and Account Security",
    paragraphs: [
      "You are responsible for maintaining the confidentiality of your account credentials and for all activity under your account.",
      "You agree to notify SQRATCH promptly if you believe your account has been compromised or used without authorization.",
      "You are responsible for access granted to your employees, contractors, collaborators, Creators, agencies, administrators, and other users invited to or associated with your Brand account.",
      "Non-public SQRATCH information, including dashboards, analytics, campaign data, unreleased features, pricing, product roadmaps, technical information, platform workflows, security information, and Brand-specific configuration data, may be confidential.",
      "You may not disclose non-public SQRATCH information to third parties except as authorized by SQRATCH or as required by law.",
      "SQRATCH uses reasonable security measures, but no system can be guaranteed to be completely secure.",
    ],
  },
  {
    title: "19. Availability, Analytics, and Platform Changes",
    paragraphs: [
      "SQRATCH may update, modify, suspend, limit, replace, or discontinue features at any time.",
      "SQRATCH may perform maintenance or experience downtime, delays, outages, errors, or interruptions.",
      "SQRATCH does not guarantee uninterrupted, error-free, real-time, or permanently available operation unless expressly agreed in a separate written agreement.",
      "Any analytics, scan counts, engagement metrics, points balances, reward status, discount status, product sync status, campaign reporting, or dashboard information provided by SQRATCH may be delayed, estimated, incomplete, or affected by technical limitations, user behaviour, Shopify status, network conditions, fraud prevention, privacy settings, merchant configuration, third-party systems, or platform changes.",
      "SQRATCH does not guarantee that analytics, scans, points, reward status, discount status, or dashboard information will be accurate, complete, error-free, or real-time.",
    ],
  },
  {
    title: "20. Beta, Pilot, and Experimental Features",
    paragraphs: [
      "SQRATCH may offer beta, pilot, experimental, early-access, alpha, prototype, or preview features.",
      "These features may be incomplete, unstable, limited, changed, suspended, discontinued, or subject to additional terms.",
      "SQRATCH does not guarantee that beta, pilot, experimental, early-access, alpha, prototype, or preview features will become generally available.",
      "You use beta, pilot, experimental, early-access, alpha, prototype, or preview features at your own risk.",
    ],
  },
  {
    title: "21. Content Complaints and Takedown Requests",
    paragraphs: [
      "If you believe Content on SQRATCH violates your rights or these Terms, you may contact support@sqratch.com with enough information for SQRATCH to review the claim.",
      "SQRATCH may remove, disable, restrict, or preserve Content while reviewing a complaint.",
      "SQRATCH may request additional information before taking action.",
      "SQRATCH’s decision to remove, restrict, retain, or restore Content does not mean SQRATCH has made a legal determination about ownership, infringement, compliance, or liability.",
    ],
  },
  {
    title: "22. Disclaimers",
    blocks: [
      paragraph("SQRATCH is provided on an “as is” and “as available” basis."),
      paragraph(
        "To the maximum extent permitted by law, SQRATCH disclaims all warranties, representations, and conditions, whether express, implied, statutory, or otherwise, including warranties of merchantability, fitness for a particular purpose, title, non-infringement, uninterrupted operation, error-free operation, accuracy, availability, reliability, security, or suitability for any specific use.",
      ),
      paragraph("SQRATCH does not warrant that:"),
      bullets([
        "the Service will be uninterrupted, secure, timely, or error-free;",
        "defects will be corrected;",
        "analytics or dashboard data will be accurate or real-time;",
        "points, rewards, discount codes, or Shopify status information will be accurate or instantly updated;",
        "any campaign, reward, product, discount, experience, or benefit will remain available;",
        "SQRATCH will meet your business, legal, regulatory, marketing, sales, compliance, or technical requirements;",
        "Shopify or any third-party service will continue to support required functionality.",
      ]),
      paragraph(
        "SQRATCH does not provide legal, tax, regulatory, advertising, compliance, financial, product-safety, or professional advice. Brands and merchants are responsible for obtaining their own advice from qualified professionals.",
      ),
    ],
  },
  {
    title: "23. Limitation of Liability",
    paragraphs: [
      "To the maximum extent permitted by law, SQRATCH and its owners, directors, officers, employees, contractors, advisors, affiliates, licensors, and service providers will not be liable for indirect, incidental, special, consequential, exemplary, punitive, enhanced, or lost-profit damages, including loss of revenue, loss of goodwill, loss of data, loss of business opportunity, loss of expected savings, loss of customers, loss of discounts, loss of rewards, loss of points, loss of use, or business interruption.",
      "To the maximum extent permitted by law, SQRATCH’s total liability for any claim related to the Service will not exceed the amount paid by you to SQRATCH for the Service during the three months before the claim arose, or one hundred U.S. dollars if no amount was paid.",
      "SQRATCH is not liable for losses, costs, claims, damages, pricing errors, discount misuse, checkout behaviour, fulfillment issues, customer disputes, product claims, product defects, product availability, regulated-product issues, tax issues, payment disputes, refund disputes, return disputes, consumer complaints, Creator disputes, Shopify issues, or third-party service issues arising from merchant-configured campaigns, Reward Offers, Shopify discount codes, Connected Shopify Stores, Brand content, Creator content, or third-party systems, except where prohibited by applicable law.",
      "Some jurisdictions do not allow certain limitations of liability. In those jurisdictions, SQRATCH’s liability will be limited to the maximum extent permitted by applicable law.",
    ],
  },
  {
    title: "24. Indemnification",
    blocks: [
      paragraph(
        "You agree to indemnify, defend, and hold harmless SQRATCH and its owners, directors, officers, employees, contractors, advisors, affiliates, licensors, and service providers from and against any claims, damages, liabilities, losses, costs, and expenses, including reasonable legal fees, arising from or related to:",
      ),
      bullets([
        "your use of SQRATCH;",
        "your Content;",
        "your products, product claims, product descriptions, pricing, availability, advertising, marketing, promotions, campaigns, or Reward Offers;",
        "your Shopify store, Connected Shopify Store, checkout, payments, fulfillment, shipping, taxes, returns, refunds, warranties, or customer service;",
        "your discount codes, reward settings, point configurations, campaign rules, or product eligibility rules;",
        "your violation of these Terms;",
        "your violation of applicable law, regulation, Shopify policy, platform rule, consumer protection rule, advertising rule, privacy law, or third-party right;",
        "your regulated products, age-restricted products, claims, warnings, disclosures, eligibility restrictions, or compliance obligations;",
        "your relationship with Creators, influencers, ambassadors, athletes, agencies, employees, contractors, collaborators, or other third parties;",
        "allegations that your Content infringes or misuses intellectual property, privacy, publicity, confidentiality, moral, contractual, or other rights;",
        "fraud, abuse, misuse, manipulation, unauthorized access, or unlawful conduct by you or your authorized users.",
      ]),
      paragraph(
        "SQRATCH may control the defence of any claim subject to indemnification. You agree to cooperate with SQRATCH in defending such claims.",
      ),
    ],
  },
  {
    title: "25. Suspension and Termination",
    blocks: [
      paragraph(
        "SQRATCH may suspend, limit, or terminate access to the Service, accounts, Brand accounts, Creator accounts, campaigns, Reward Offers, Shopify connections, points, redemptions, discount functionality, or Content if SQRATCH believes that:",
      ),
      bullets([
        "you violated these Terms;",
        "you misused the platform;",
        "you created legal, regulatory, operational, security, fraud, consumer protection, Shopify, reputational, or third-party risk;",
        "your account or campaign may be unlawful, misleading, harmful, abusive, fraudulent, or non-compliant;",
        "your account is inactive;",
        "your use of SQRATCH creates risk for SQRATCH or others;",
        "you fail to meet approval requirements;",
        "you fail to pay applicable fees;",
        "continued access would be commercially, legally, technically, or operationally impractical.",
      ]),
      paragraph("You may stop using SQRATCH at any time."),
      paragraph(
        "Shopify merchants may uninstall the SQRATCH Shopify app from Shopify Admin.",
      ),
      paragraph("Upon suspension, termination, disconnect, or uninstall:"),
      bullets([
        "access to some or all features may stop;",
        "active campaigns may be disabled;",
        "Reward Offers may stop working;",
        "Shopify product sync may stop;",
        "new discount codes may no longer be generated;",
        "Content may be removed, restricted, or retained as permitted by these Terms;",
        "stored Shopify access tokens will be cleared where applicable;",
        "historical records may be retained as described in these Terms and the Privacy Policy;",
        "existing Shopify discount codes may remain in Shopify Admin unless the merchant disables or deletes them in Shopify.",
      ]),
      paragraph(
        "Termination does not relieve you of obligations that arose before termination.",
      ),
    ],
  },
  {
    title: "26. Survival",
    paragraphs: [
      "Sections relating to definitions, intellectual property, content licenses, data retention, privacy, confidentiality, disclaimers, limitation of liability, indemnification, payment obligations, dispute resolution, governing law, termination effects, and any provisions that by their nature should survive will survive termination or expiration of these Terms.",
    ],
  },
  {
    title: "27. Governing Law and Disputes",
    paragraphs: [
      "These Terms are governed by the laws of the Province of Ontario and the federal laws of Canada applicable therein, without regard to conflict of law rules.",
      "Any disputes will be resolved in the courts located in Ontario, Canada, unless applicable law requires otherwise.",
      "You and SQRATCH agree to the personal jurisdiction of those courts for disputes related to these Terms or the Service.",
    ],
  },
  {
    title: "28. Changes to These Terms",
    paragraphs: [
      "SQRATCH may update these Terms from time to time.",
      "If we make material changes, we will update the effective date and may notify users through the platform, by email, through the Shopify app, or by other reasonable means.",
      "Continued use of SQRATCH after changes become effective means you accept the updated Terms.",
      "If you do not agree to updated Terms, you must stop using SQRATCH and, if applicable, uninstall the SQRATCH Shopify app.",
    ],
  },
  {
    title: "29. Contact",
    blocks: [
      paragraph("For questions about these Terms, contact:"),
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

export const termsOfService: LegalDocument = {
  eyebrow: "Legal",
  title: "SQRATCH Terms of Service",
  effectiveDate: "June 1, 2026",
  company: "Sqratch Inc.",
  contact: "support@sqratch.com",
  intro: [
    "These Terms of Service govern access to and use of SQRATCH, including the SQRATCH website, dashboard, Shopify app, platform, software, product experiences, lessons, creator-led content tools, reward functionality, product discovery flows, and related services.",
    "By accessing or using SQRATCH, installing the SQRATCH Shopify app, creating an account, connecting a Shopify store, configuring a campaign, uploading content, redeeming points, or otherwise using the Service, you agree to these Terms.",
    "If you access or use SQRATCH on behalf of a company, brand, merchant, creator, organization, or other legal entity, you represent and warrant that you have authority to bind that entity to these Terms. In that case, “you” and “your” refer to both you personally and the entity on whose behalf you are acting.",
    "Your use of SQRATCH is also governed by the SQRATCH Privacy Policy, which explains how SQRATCH collects, uses, stores, shares, and protects information. The SQRATCH Privacy Policy is available at:",
    "https://sqratch.com/privacy",
    "If the Privacy Policy URL changes, the current version will be made available through the SQRATCH website, dashboard, Shopify app listing, or another reasonable location provided by SQRATCH.",
  ],
  sections,
};
