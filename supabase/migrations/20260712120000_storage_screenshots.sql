-- F2 storage foundation (2026-07-12): the `screenshots` bucket for request
-- icons and screenshots (SPEC Flow 2 step 1, §5 Supabase Storage).
-- Single-transaction migration: a failed run leaves the database clean.
--
-- Rules:
--   * public read (request pages are public/SEO — SPEC §7)
--   * authenticated upload, restricted to the uploader's own top-level folder
--     (upload paths are always <user_id>/<...>)
--   * delete only by the folder owner
--   * png / jpeg / webp only, max 2 MB per file (enforced bucket-level)
--   * no UPDATE policy: files are immutable; replacing = upload new + delete old

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'screenshots',
  'screenshots',
  true,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Re-runnable: drop-then-create keeps the policies converged with this file.
DROP POLICY IF EXISTS screenshots_public_read    ON storage.objects;
DROP POLICY IF EXISTS screenshots_insert_own_dir ON storage.objects;
DROP POLICY IF EXISTS screenshots_delete_own_dir ON storage.objects;

CREATE POLICY screenshots_public_read ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'screenshots');

CREATE POLICY screenshots_insert_own_dir ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'screenshots'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

CREATE POLICY screenshots_delete_own_dir ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'screenshots'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

COMMIT;
