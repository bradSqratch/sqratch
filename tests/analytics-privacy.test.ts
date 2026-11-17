import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as policy from '../src/lib/analytics-policy';

const sensitive = [
  '/commerce7/connect?tenantId=test-tenant&account=SYNTHETIC_SECRET_TOKEN_123',
  '/commerce7/link?t=SYNTHETIC_LINK_TOKEN_456',
  '/login?callbackUrl=%2Fcommerce7%2Flink%3Ft%3DSYNTHETIC_NESTED_TOKEN_789',
  '/verify-email?email=test.user%40example.com',
  '/signup?next=%2Fcommerce7%2Flink%3Ft%3DSYNTHETIC_SIGNUP_TOKEN',
  '/sign-up', '/forgot-password', '/reset-password?token=SYNTHETIC_RECOVERY_TOKEN', '/reset-password#token=SYNTHETIC_FRAGMENT_TOKEN',
  '/account', '/profile', '/dashboard', '/admin/user-management',
  '/auth/callback', '/api/auth/callback/google?code=SYNTHETIC_OAUTH_CODE',
  '/api/shopify/oauth/callback?code=SYNTHETIC_SHOPIFY_CODE', '/shopify?host=SYNTHETIC_HOST',
  '/checkout?token=SYNTHETIC_CHECKOUT_TOKEN', '/unknown-route?secret=SYNTHETIC_UNKNOWN',
];
const url = (path: string) => `https://sqratch.example${path}`;
test('sensitive Commerce7, nested auth, email, OAuth, account and recovery URLs are suppressed across every analytics provider', () => {
  for (const path of sensitive) {
    assert.equal(policy.analyticsPath(url(path)), null, path);
    assert.equal(policy.safeAnalyticsUrl(url(path)), null, path);
    assert.equal(policy.safeGoogleEvent('page_view', {}, url(path)), null, path);
    for (const type of ['pageview', 'vital', 'event']) assert.equal(policy.filterTelemetry({ type, url: url(path) }, url(path)), null, `${type} ${path}`);
  }
});

test('public pages and QR/campaign/course/lesson routes survive with dynamic segments, query and hash removed', () => {
  const cases = [
    ['/', '/'], ['/about', '/about'], ['/support', '/support'], ['/privacy', '/privacy'], ['/terms', '/terms'],
    ['/c/SYNTHETIC_CAMPAIGN', '/c/[campaignSlug]'], ['/q/SYNTHETIC_QR_SECRET', '/q/[qrCodeData]'],
    ['/redeemQR/SYNTHETIC_CAMPAIGN/SYNTHETIC_QR_SECRET', '/redeemQR/[campaignID]/[qrcodeID]'],
    ['/x/test.user%40example.com', '/x/[experienceSlug]'],
    ...['shop', 'posts', 'learn', 'qa'].map((part) => [`/x/SYNTHETIC_EXPERIENCE/${part}`, `/x/[experienceSlug]/${part}`]),
    ['/x/SYNTHETIC_EXPERIENCE/courses/SYNTHETIC_COURSE', '/x/[experienceSlug]/courses/[courseSlug]'],
    ['/x/SYNTHETIC_EXPERIENCE/lessons/SYNTHETIC_LESSON', '/x/[experienceSlug]/lessons/[lessonId]'],
  ];
  for (const [path, expected] of cases) {
    const raw = `${url(path)}?token=SYNTHETIC_QUERY_SECRET&email=test.user%40example.com#SYNTHETIC_FRAGMENT_SECRET`;
    assert.equal(policy.analyticsPath(raw), expected);
    assert.equal(policy.safeAnalyticsUrl(raw), url(expected));
    const event = policy.safeGoogleEvent('page_view', {}, raw);
    assert.ok(event); assert.equal(event.properties.page_path, expected);
    assert.doesNotMatch(JSON.stringify(event), /SYNTHETIC_|test\.user|%40|\?|#/);
    assert.deepEqual(policy.filterTelemetry({ type: 'pageview', url: raw }, raw), { type: 'pageview', url: url(expected) });
    assert.deepEqual(policy.filterTelemetry({ type: 'vital', url: raw, route: path }, raw), { type: 'vital', url: url(expected), route: expected });
  }
});

test('Google custom events preserve supported names and validated business numbers, and drop arbitrary PII or URL properties', () => {
  for (const event of ['qr_scan', 'campaign_view', 'campaign_click', 'product_click', 'select_item', 'view_item', 'purchase', 'generate_lead']) {
    const safe = policy.safeGoogleEvent(event, {
      value: 10, quantity: 2, engagement_time_msec: 30, currency: 'CAD',
      page_location: 'https://evil.example/?token=SYNTHETIC_OVERRIDE', page_referrer: 'SYNTHETIC_REFERRER',
      page_title: 'test.user@example.com', email: 'test.user@example.com', user_id: 'SYNTHETIC_USER_ID',
      items: [{ item_name: 'SYNTHETIC_ITEM_SECRET' }], callbackUrl: 'SYNTHETIC_CALLBACK',
    }, url('/c/SYNTHETIC_CAMPAIGN?token=SYNTHETIC_QUERY'));
    assert.ok(safe); assert.equal(safe.event, event); assert.equal(safe.properties.value, 10); assert.equal(safe.properties.quantity, 2); assert.equal(safe.properties.currency, 'CAD');
    assert.equal(safe.properties.page_title, 'SQRATCH'); assert.equal(safe.properties.page_referrer, '');
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC|test\.user|evil\.example/);
  }
  for (const number of [NaN, Infinity, -1, 1e13]) assert.equal(policy.safeGoogleEvent('purchase', { value: number, currency: 'test.user@example.com' }, url('/'))?.properties.value, undefined);
  assert.equal(policy.safeGoogleEvent('SYNTHETIC_UNKNOWN_EVENT', {}, url('/')), null);
  assert.equal(policy.filterTelemetry({ type: 'event', url: url('/'), name: 'SYNTHETIC_SECRET_EVENT', data: { email: 'test.user@example.com' } }, url('/')), null);
});

test('live callbacks reject delayed events while sensitive, resume safe pages and never forward sensitive referrers', () => {
  const good = { type: 'pageview', url: url('/about?token=SYNTHETIC_OLD_QUERY'), data: 'SYNTHETIC_UNKNOWN_PROPERTY' };
  const bad = { type: 'pageview', url: url(sensitive[0]) };
  const transitions = [
    { current: url('/about'), event: good, accepted: true },
    { current: url(sensitive[0]), event: good, accepted: false },
    { current: url(sensitive[1]), event: bad, accepted: false },
    { current: url('/about'), event: bad, accepted: false },
    { current: url('/about'), event: good, accepted: true },
  ];
  for (const step of transitions) {
    const result = policy.filterTelemetry(step.event, step.current); assert.equal(result !== null, step.accepted);
    if (result) assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|data/);
  }
  for (const referrer of [url(sensitive[0]), url('/about?token=SYNTHETIC_REFERRER'), url('/#SYNTHETIC_FRAGMENT'), 'not a URL']) assert.equal(policy.filterTelemetry(good, url('/about'), referrer), null);
  assert.ok(policy.filterTelemetry(good, url('/about'), 'https://referrer.example/about'));
});

test('malformed paths and non-web URL schemes fail closed', () => {
  for (const path of ['javascript:alert(1)', 'data:text/html,secret', 'https://user:secret@example.com/', '/%ZZ', '/commerce7%2Fconnect?account=SYNTHETIC_ENCODED']) assert.equal(policy.analyticsPath(path), null, path);
});

test('source guard keeps MP server-only, removes browser Google script and registers both Vercel callbacks', () => {
  const google = readFileSync('src/components/GoogleAnalytics.tsx', 'utf8');
  const helper = readFileSync('src/lib/googleAnalytics.ts', 'utf8');
  const layout = readFileSync('src/app/layout.tsx', 'utf8');
  const vercel = readFileSync('src/components/PrivacyAnalytics.tsx', 'utf8');
  assert.doesNotMatch(google + helper + layout, /googletagmanager|dataLayer|gtag\(|createElement\(['"]iframe|srcdoc|GA4_API_SECRET|mp\/collect/);
  assert.match(helper, /fetch\('\/api\/analytics\/google'/);
  assert.equal((vercel.match(/beforeSend=/g) ?? []).length, 2);
  assert.match(vercel, /window\.location\.href, document\.referrer/);
  assert.match(readFileSync('next.config.ts', 'utf8'), /frame-ancestors https:\/\/admin\.platform\.commerce7\.com/);
  assert.match(readFileSync('src/app/commerce7/connect/page.tsx', 'utf8'), /https:\/\/dev-center\.platform\.commerce7\.com\/v2\/commerce7\.js/);
});

test('Speed Insights excludes user-authored dynamic pages and delayed metrics after leaving static content', () => {
  const metric = { type: 'vital', url: url('/about') };
  assert.ok(policy.filterSpeedTelemetry(metric, url('/about')));
  for (const path of ['/x/SYNTHETIC_ID', '/c/SYNTHETIC_ID', '/q/SYNTHETIC_ID', '/login']) {
    assert.equal(policy.filterSpeedTelemetry(metric, url(path)), null);
    assert.equal(policy.filterSpeedTelemetry({ type: 'vital', url: url(path) }, url('/about')), null);
  }
});

function clientHarness(initial = '/') {
  let pathname = initial.split('?')[0]; let previous: unknown[] | undefined; let effect: (() => unknown) | undefined; let serial = 0;
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const window = { location: new URL(url(initial)), sqratchAnalyticsConsent: undefined as boolean | undefined };
  const navigator = { doNotTrack: undefined as string | undefined, globalPrivacyControl: false };
  const storage = new Map<string, string>();
  const helper: typeof import('../src/lib/googleAnalytics') = {} as never;
  const compile = (file: string) => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compile('src/lib/googleAnalytics.ts'), { exports: helper, window, navigator, Date, JSON, crypto: { randomUUID: () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}` }, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, process: { env: { NODE_ENV: 'production' } }, fetch: (target: string, init: RequestInit) => { requests.push({ url: target, init, body: JSON.parse(String(init.body)) }); return Promise.resolve(new Response(null, { status: 204 })); }, require: () => policy });
  const component: { default?: () => void } = {};
  runInNewContext(compile('src/components/GoogleAnalytics.tsx'), { exports: component, window, require(name: string) {
    if (name === 'react') return { useEffect: (callback: () => unknown, deps: unknown[]) => { if (!previous || !deps.every((value, i) => Object.is(previous?.[i], value))) effect = callback; previous = deps; } };
    if (name === 'next/navigation') return { usePathname: () => pathname };
    if (name === '@/lib/analytics-policy') return policy;
    if (name === '@/lib/googleAnalytics') return helper;
    throw new Error(name);
  } });
  function render(next = initial) { window.location.href = url(next); pathname = next.split(/[?#]/)[0]; component.default?.(); const work = effect; effect = undefined; return work?.(); }
  return { requests, window, navigator, storage, helper, render, replayEffect: () => { previous = undefined; } };
}

test('actual client emits closed enum-only transport and strips customer/user URLs and free text', () => {
  const app = clientHarness('/c/SYNTHETIC_CAMPAIGN?account=SYNTHETIC_TOKEN#secret'); app.render();
  app.helper.gaEvent('product_click', { value: 12, quantity: 2, currency: 'USD', email: 'test.user@example.com', user_id: 'SYNTHETIC_USER', clientId: 'SYNTHETIC_CLIENT', callbackUrl: 'SYNTHETIC_CALLBACK', page_location: 'https://secret.example/?token=secret', items: [{ item_name: 'private' }] });
  assert.equal(app.requests.length, 2);
  for (const request of app.requests) {
    assert.equal(request.url, '/api/analytics/google'); assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.referrerPolicy, 'no-referrer'); assert.equal(request.init.keepalive, true);
    assert.deepEqual(Object.keys(request.body).sort(), ['clientId', 'event', 'eventId', 'properties', 'route', 'sessionId']);
    assert.equal(request.body.route, 'campaign');
    assert.match(String(request.body.clientId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(String(request.body.eventId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(Number.isSafeInteger(request.body.sessionId));
    assert.doesNotMatch(JSON.stringify(request.body), /SYNTHETIC|test\.user|secret\.example|https?:|page_location|page_title|callbackUrl|user_id|items/);
  }
  assert.equal(app.requests[0].body.clientId, app.requests[1].body.clientId); assert.equal(app.requests[0].body.sessionId, app.requests[1].body.sessionId); assert.notEqual(app.requests[0].body.eventId, app.requests[1].body.eventId);
  assert.deepEqual(app.requests[1].body.properties, { value: 12, quantity: 2, currency: 'USD' });
});

test('actual lifecycle dedupes query-only and StrictMode effects but preserves pathname, Back/Forward and sensitive reset', () => {
  const app = clientHarness('/about?token=SYNTHETIC_INITIAL'); assert.equal(app.render(), undefined); assert.equal(app.requests.length, 1);
  app.render('/about?token=SYNTHETIC_CHANGED'); app.replayEffect(); app.render('/about?token=SYNTHETIC_CHANGED'); assert.equal(app.requests.length, 1);
  app.render('/support'); app.render('/about'); assert.equal(app.requests.length, 3); // Back/Forward
  app.render('/c/SYNTHETIC_A'); app.render('/c/SYNTHETIC_B'); assert.equal(app.requests.length, 5);
  app.render('/commerce7/link?t=SYNTHETIC_SECRET'); app.helper.gaEvent('product_click'); app.render('/login?callbackUrl=SYNTHETIC_SECRET'); assert.equal(app.requests.length, 5);
  app.render('/c/SYNTHETIC_B'); assert.equal(app.requests.length, 6);
  for (const request of app.requests) assert.doesNotMatch(JSON.stringify(request.body), /SYNTHETIC|https?:|\?/);
});

test('sensitive initial URLs and live route before React commit suppress actual client dispatch', () => {
  for (const path of sensitive) { const app = clientHarness(path); app.render(); app.helper.gaEvent('purchase', { value: 1 }); assert.equal(app.requests.length, 0, path); assert.equal(app.storage.size, 0); }
  const app = clientHarness('/about'); app.render(); app.window.location.href = url(sensitive[0]); app.helper.gaEvent('product_click'); assert.equal(app.requests.length, 1);
});

test('explicit consent rejection, DNT and GPC suppress actual transport and identity creation', () => {
  for (const preference of ['consent', 'dnt', 'gpc']) {
    const app = clientHarness('/about');
    if (preference === 'consent') app.window.sqratchAnalyticsConsent = false;
    if (preference === 'dnt') app.navigator.doNotTrack = '1';
    if (preference === 'gpc') app.navigator.globalPrivacyControl = true;
    app.render(); app.helper.gaEvent('product_click', { value: 1 }); assert.equal(app.requests.length, 0); assert.equal(app.storage.size, 0);
  }
});
