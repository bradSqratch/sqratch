import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildApprovalEmailHtml,
  buildInviteEmailHtml,
  buildWelcomeEmailHtml,
} from "../src/helpers/emailTemplates";

// ---------------------------------------------------------------------------
// SQRATCH is a registered trademark. The React app / navbar already use the
// canonical ® wordmark; these emails were the last place still rendering the
// obsolete ™ symbol. Regression coverage for that swap.
// ---------------------------------------------------------------------------

const templates = {
  welcome: () =>
    buildWelcomeEmailHtml({ name: "Ada Lovelace", ctaUrl: "https://sqratch.com/login" }),
  invite: () =>
    buildInviteEmailHtml({
      name: "Ada Lovelace",
      campaignName: "Launch Week",
      inviteUrl: "https://sqratch.com/invite/abc123",
    }),
  approval: () =>
    buildApprovalEmailHtml({
      name: "Ada Lovelace",
      accountTypeLabel: "Creator",
      loginUrl: "https://sqratch.com/login",
    }),
};

test("active email templates use the registered trademark symbol on the SQRATCH wordmark", () => {
  for (const [key, build] of Object.entries(templates)) {
    const html = build();
    assert.match(html, /SQRATCH<span[^>]*>®<\/span>/, `${key} template should render SQRATCH®`);
  }
});

test("active email templates no longer contain the obsolete trademark symbol", () => {
  for (const [key, build] of Object.entries(templates)) {
    const html = build();
    assert.doesNotMatch(html, /™|&trade;|&#8482;/, `${key} template should not contain ™`);
  }
});

test("email templates do not import or reference the React SqratchLogo component", () => {
  const source = readFileSync(
    new URL("../src/helpers/emailTemplates.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /SqratchLogo/);
  assert.doesNotMatch(source, /from\s+["']@\/components\/brand\/sqratch-logo["']/);
});

test("template interpolation, escaping, and links remain unchanged around the wordmark swap", () => {
  const welcomeHtml = templates.welcome();
  assert.match(welcomeHtml, /Hi Ada Lovelace,/);
  assert.match(welcomeHtml, /href="https:\/\/sqratch\.com\/login"/);

  const inviteHtml = templates.invite();
  assert.match(inviteHtml, /Launch Week/);
  assert.match(inviteHtml, /href="https:\/\/sqratch\.com\/invite\/abc123"/);

  const approvalHtml = templates.approval();
  assert.match(approvalHtml, /Creator/);
  assert.match(approvalHtml, /href="https:\/\/sqratch\.com\/login"/);

  // Escaping still applied to interpolated user-controlled fields.
  const escapedInvite = buildInviteEmailHtml({
    name: "Ada",
    campaignName: "<script>alert(1)</script>",
    inviteUrl: "https://sqratch.com/invite/xyz",
  });
  assert.doesNotMatch(escapedInvite, /<script>alert\(1\)<\/script>/);
  assert.match(escapedInvite, /&lt;script&gt;/);
});
