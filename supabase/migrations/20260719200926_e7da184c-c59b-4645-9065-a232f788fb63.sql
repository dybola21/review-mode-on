
CREATE TABLE public.render_output_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  render_job_id uuid NOT NULL REFERENCES public.render_jobs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  worker_output_id text NOT NULL,
  file_name text NOT NULL,
  storage_path text NOT NULL UNIQUE,
  mime_type text NOT NULL DEFAULT 'video/mp4',
  source_file_id uuid REFERENCES public.project_files(id) ON DELETE SET NULL,
  variation_index integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (render_job_id, worker_output_id)
);

CREATE INDEX render_output_targets_job_idx ON public.render_output_targets(render_job_id);
CREATE INDEX render_output_targets_user_idx ON public.render_output_targets(user_id);

GRANT SELECT ON public.render_output_targets TO authenticated;
GRANT ALL ON public.render_output_targets TO service_role;

ALTER TABLE public.render_output_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own render output targets"
  ON public.render_output_targets FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
