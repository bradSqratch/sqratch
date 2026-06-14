# Lesson Video Storage

## Upload Architecture

Lesson videos use a server-authorized direct upload:

1. The browser sends JSON metadata to `POST /api/uploads/video`.
2. The route authenticates the creator, verifies course ownership, validates the file, generates a unique object path, and creates a signed upload URL for that exact object.
3. The browser uploads the file directly to Supabase Storage.
4. After storage succeeds, the browser sends lesson JSON and the server-issued bucket/path to `POST` or `PATCH /api/creator/lessons`.
5. If lesson persistence fails, the browser calls the authenticated cleanup route for the newly uploaded course object.

No video bytes pass through a Next.js route or Vercel Function. Signed direct upload remains compatible with either a public or private bucket.

Signed direct upload was selected instead of TUS because the repository does not have a browser Supabase auth/session model or `tus-js-client`. Upload progress and cancellation use `XMLHttpRequest`. Interrupted uploads are not resumable.

## Playback Architecture

`Lesson.videoStorageBucket` and `Lesson.videoStoragePath` are the stable references for new and edited uploaded lessons. Expiring signed URLs are generated only by trusted server code after SQRATCH course-access authorization.

- Anonymous visitors can receive a signed URL for lessons in `PUBLIC` courses.
- `PRIVATE` course lessons require the existing `canAccessPrivate` result: creator ownership or a logged-in user with a linked campaign unlock.
- Creator dashboard previews are signed only after creator/course ownership validation.
- API responses containing signed media URLs use `Cache-Control: private, no-store`.
- Signed URLs are not stored in Prisma, logs, or analytics.
- `LESSON_VIDEO_SIGNED_URL_TTL_SECONDS` defaults to 3600 seconds and is clamped between 60 and 14,400 seconds.

Signed URLs can be copied and shared until they expire. This is access control, not DRM.

Existing `videoUploadUrl` values remain supported. The server strictly parses legacy URLs only when they use the configured Supabase origin, configured lesson-video bucket, and expected experience/course path. Existing videos do not need to be re-uploaded. Editing a legacy lesson migrates it to explicit bucket/path fields.

Experience WHY videos use a different storage flow and are intentionally unchanged by this lesson-video migration.

## Required Environment

- `SUPABASE_STORAGE_URL` or `NEXT_PUBLIC_SUPABASE_URL`: Supabase project origin.
- `SUPABASE_STORAGE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_ROLE_KEY`: server-only Storage credential.
- `SUPABASE_LESSON_VIDEO_BUCKET`: optional; defaults to `lesson-videos`.
- `MAX_VIDEO_UPLOAD_MB`: optional; defaults to `250`.
- `LESSON_VIDEO_SIGNED_URL_TTL_SECONDS`: optional; defaults to `3600`.

Never place a service-role key in a `NEXT_PUBLIC_*` variable.

## Supabase Bucket Settings

- Bucket name: `lesson-videos`
- Private: `yes`, but only after the compatible application and migration are deployed and verified
- File-size limit: `250 MB`
- Allowed MIME types:
  - `video/mp4`
  - `video/webm`
  - `video/quicktime`
  - `video/mpeg`
  - `video/x-m4v`
- Storage CORS origins:
  - `https://www.sqratch.com`
  - required Vercel preview origins
  - local development origins such as `http://localhost:3000`

The bucket audited on June 14, 2026 was public, had a 250 MB limit, and had no storage-level MIME allowlist.

## No-Downtime Deployment

1. Keep `lesson-videos` public.
2. Apply migration `20260614120000_add_lesson_video_storage_reference`.
3. Deploy the signed-playback-compatible application.
4. Verify public and creator lesson APIs return `/object/sign/` URLs, not `/object/public/` lesson URLs.
5. Verify an anonymous visitor can play an uploaded lesson in a `PUBLIC` course.
6. Verify an unlocked logged-in user can play an uploaded lesson in a `PRIVATE` course.
7. Verify the creator owner can preview and play their own uploaded lesson.
8. Verify anonymous and logged-in users without an unlock receive no private lesson video URL.
9. Verify new uploads, replacements, YouTube switches, and deletions.
10. Change only the `lesson-videos` bucket to private in Supabase.
11. Repeat steps 4 through 9.

Do not make the bucket private before both the migration and compatible application are deployed.

## Rollback

If playback fails after the bucket is made private:

1. Immediately change `lesson-videos` back to public.
2. Keep the schema migration applied; the nullable fields are backward-compatible.
3. Roll back the application deployment if necessary.
4. Confirm legacy `/object/public/` playback works again.
5. Diagnose signed URL creation, environment values, bucket permissions, and CORS before retrying.

Do not delete or rewrite lesson records during rollback.
