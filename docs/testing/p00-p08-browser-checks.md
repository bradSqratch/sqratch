# P00–P08 browser acceptance checks

These checks have **not been run** by the implementation agent. Run on a local
or explicitly authorized sandbox with test accounts/media. The automated
PostgreSQL lane is documented in `docs/prisma-migrations.md`.

1. QR management: delete an untouched, never-exported batch; it disappears.
   Attempt deletion after export, after an anonymous scan, and after redemption;
   each shows the conflict and keeps its row. Edit a redeemed code: status and
   redemption details are read-only. Attempt campaign reassignment; history
   blocks it. Open both `/q/{code}` and legacy `/redeemQR/{campaign}/{code}`;
   the printed code still resolves. Check the image after a simulated failed
   reassignment save.
2. Publication: as the owner, another signed-in user, and in an anonymous
   window, verify draft public entry points fail as missing. As the owner use
   creator management to edit the draft, and confirm campaign listings omit it.
   Publish it in creator management and verify its public page loads. Complete
   an owner lesson and check that no learner event or reward was created. Published private courses still require an unlock for other users.
   Previously issued media URLs remain valid until their TTL expires.
3. Approvals: throttle a decision request; both buttons remain disabled. Decide
   the same request in a second tab. The losing tab shows “already decided” and
   reloads the list. Confirm the successful status matches the granted access.
4. Administrator access: verify the UI displays the server's self-change and
   history conflicts. Attempt to delete an account with points or redemption
   history; it must remain present and recommend deactivation.
5. Media: upload a video and allow POST/PATCH to reach the server, then block or
   lose the response. Confirm the draft and bucket/path survive, no cleanup
   DELETE is sent, and retry reuses the upload. A create retry returns the same
   lesson id. Repeat for replacement, avatar, brand assets and WHY video.
   A definite validation rejection may clean the new object; an attached object
   returns `409 ASSET_IN_USE`. A missing video does not break the whole hub/list.
6. Brand context (two tabs): load a populated create/edit form for Brand A in
   tab 1. In tab 2 switch to Brand B. Submit tab 1: verify
   `409 BRAND_CONTEXT_MISMATCH`, preserved fields, and no write under either
   brand. Switch back to A and retry successfully. Repeat a representative
   campaign, reward, product and upload action, including a global ADMIN.
   VIEWER-only membership must still be refused. Missing expected-brand headers
   remain accepted for older clients during the staged compatibility release.
7. Community privacy: with an account lacking a name, post a comment/question
   and answer as a creator. Other users see “SQRATCH member”; responses contain
   no selected email field or email-derived fallback name.

Asset reference checks are defensive reads, not an atomic attachment/deletion
protocol. P13's staged-asset lifecycle remains necessary to close that later race.
