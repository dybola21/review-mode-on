-- =========================================================
-- Phase 2: app_settings, project_files, rights_confirmations
-- =========================================================

-- ---------- app_settings ----------
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read app_settings" ON public.app_settings;
CREATE POLICY "Authenticated users can read app_settings"
  ON public.app_settings FOR SELECT
  TO authenticated
  USING (true);

-- Sem policies de INSERT/UPDATE/DELETE => cliente não altera.
-- Seed inicial (idempotente).
INSERT INTO public.app_settings (key, value) VALUES
  ('max_files_per_project', '20'::jsonb),
  ('max_file_size_mb', '200'::jsonb),
  ('max_variations', '20'::jsonb),
  ('allowed_video_types', '["video/mp4","video/quicktime","video/webm"]'::jsonb),
  ('allowed_image_types', '["image/png","image/jpeg","image/webp"]'::jsonb)
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON public.app_settings;
CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- project_files ----------
CREATE TABLE IF NOT EXISTS public.project_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  storage_path text NOT NULL,
  file_type text NOT NULL,
  mime_type text NOT NULL,
  file_size bigint NOT NULL,
  duration_seconds numeric,
  status text NOT NULL DEFAULT 'uploaded',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_files_file_type_check
    CHECK (file_type IN ('source_video','logo','music','template_asset')),
  CONSTRAINT project_files_status_check
    CHECK (status IN ('uploaded','processing','ready','failed')),
  CONSTRAINT project_files_file_size_check
    CHECK (file_size > 0 AND file_size <= 500 * 1024 * 1024),
  CONSTRAINT project_files_file_name_check
    CHECK (char_length(file_name) BETWEEN 1 AND 255)
);

CREATE INDEX IF NOT EXISTS idx_project_files_project_id ON public.project_files(project_id);
CREATE INDEX IF NOT EXISTS idx_project_files_user_id ON public.project_files(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_files TO authenticated;
GRANT ALL ON public.project_files TO service_role;

ALTER TABLE public.project_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own project files" ON public.project_files;
CREATE POLICY "Users can view their own project files"
  ON public.project_files FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_files.project_id AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert files in their own projects" ON public.project_files;
CREATE POLICY "Users can insert files in their own projects"
  ON public.project_files FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_files.project_id AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update their own project files" ON public.project_files;
CREATE POLICY "Users can update their own project files"
  ON public.project_files FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_files.project_id AND p.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_files.project_id AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete their own project files" ON public.project_files;
CREATE POLICY "Users can delete their own project files"
  ON public.project_files FOR DELETE
  TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_files.project_id AND p.user_id = auth.uid()
    )
  );

-- ---------- rights_confirmations ----------
CREATE TABLE IF NOT EXISTS public.rights_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  confirmation_version text NOT NULL,
  rights_confirmed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rights_confirmations_unique UNIQUE (user_id, project_id, confirmation_version)
);

CREATE INDEX IF NOT EXISTS idx_rights_confirmations_project_id ON public.rights_confirmations(project_id);

GRANT SELECT, INSERT, DELETE ON public.rights_confirmations TO authenticated;
GRANT ALL ON public.rights_confirmations TO service_role;

ALTER TABLE public.rights_confirmations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own rights confirmations" ON public.rights_confirmations;
CREATE POLICY "Users can view their own rights confirmations"
  ON public.rights_confirmations FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = rights_confirmations.project_id AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert their own rights confirmations" ON public.rights_confirmations;
CREATE POLICY "Users can insert their own rights confirmations"
  ON public.rights_confirmations FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = rights_confirmations.project_id AND p.user_id = auth.uid()
    )
  );

-- ---------- Storage policies (project-inputs & project-assets) ----------
-- Buckets são criados via ferramenta separada. Aqui só as policies.
-- Path esperado: {user_id}/{project_id}/{file_id}/{safe_file_name}

DROP POLICY IF EXISTS "Users read own files in project-inputs" ON storage.objects;
CREATE POLICY "Users read own files in project-inputs"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'project-inputs'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users upload own files in project-inputs" ON storage.objects;
CREATE POLICY "Users upload own files in project-inputs"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'project-inputs'
    AND auth.uid()::text = (storage.foldername(name))[1]
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id::text = (storage.foldername(name))[2]
        AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users delete own files in project-inputs" ON storage.objects;
CREATE POLICY "Users delete own files in project-inputs"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'project-inputs'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users read own files in project-assets" ON storage.objects;
CREATE POLICY "Users read own files in project-assets"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'project-assets'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users upload own files in project-assets" ON storage.objects;
CREATE POLICY "Users upload own files in project-assets"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'project-assets'
    AND auth.uid()::text = (storage.foldername(name))[1]
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id::text = (storage.foldername(name))[2]
        AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users delete own files in project-assets" ON storage.objects;
CREATE POLICY "Users delete own files in project-assets"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'project-assets'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );