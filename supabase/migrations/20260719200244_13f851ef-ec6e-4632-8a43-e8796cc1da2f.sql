
-- ============================================================
-- Fase 3A: fila de renderização (render_jobs, render_outputs)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.render_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  worker_job_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT render_jobs_status_check CHECK (status IN (
    'queued','submitting','processing','completed','failed','cancelled','expired'
  )),
  CONSTRAINT render_jobs_progress_check CHECK (progress >= 0 AND progress <= 100),
  CONSTRAINT render_jobs_attempt_check CHECK (attempt_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS render_jobs_worker_job_id_key
  ON public.render_jobs(worker_job_id)
  WHERE worker_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS render_jobs_user_id_idx ON public.render_jobs(user_id);
CREATE INDEX IF NOT EXISTS render_jobs_project_id_idx ON public.render_jobs(project_id);
CREATE INDEX IF NOT EXISTS render_jobs_status_idx ON public.render_jobs(status);

-- Único job ativo por projeto (queued/submitting/processing)
CREATE UNIQUE INDEX IF NOT EXISTS render_jobs_one_active_per_project
  ON public.render_jobs(project_id)
  WHERE status IN ('queued','submitting','processing');

GRANT SELECT ON public.render_jobs TO authenticated;
GRANT ALL ON public.render_jobs TO service_role;

ALTER TABLE public.render_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "render_jobs owner select"
  ON public.render_jobs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Sem policies de INSERT/UPDATE/DELETE para authenticated: apenas service_role
-- (server functions com supabaseAdmin) altera essa tabela.

CREATE TRIGGER render_jobs_set_updated_at
  BEFORE UPDATE ON public.render_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
CREATE TABLE IF NOT EXISTS public.render_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  render_job_id UUID NOT NULL REFERENCES public.render_jobs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  worker_output_id TEXT,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_size BIGINT,
  mime_type TEXT NOT NULL DEFAULT 'video/mp4',
  checksum TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS render_outputs_job_worker_output_unique
  ON public.render_outputs(render_job_id, worker_output_id)
  WHERE worker_output_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS render_outputs_user_id_idx ON public.render_outputs(user_id);
CREATE INDEX IF NOT EXISTS render_outputs_project_id_idx ON public.render_outputs(project_id);
CREATE INDEX IF NOT EXISTS render_outputs_job_id_idx ON public.render_outputs(render_job_id);

GRANT SELECT ON public.render_outputs TO authenticated;
GRANT ALL ON public.render_outputs TO service_role;

ALTER TABLE public.render_outputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "render_outputs owner select"
  ON public.render_outputs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================
-- Storage policies para render-outputs (bucket criado via tool)
-- Primeiro segmento do path = auth.uid()::text
-- ============================================================
DO $$
BEGIN
  -- SELECT own files
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='storage' AND tablename='objects'
    AND policyname='render-outputs owner select'
  ) THEN
    CREATE POLICY "render-outputs owner select"
      ON storage.objects FOR SELECT TO authenticated
      USING (
        bucket_id = 'render-outputs'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;
