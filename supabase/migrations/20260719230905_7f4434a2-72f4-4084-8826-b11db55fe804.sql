
-- ============================================================
-- Wave 3: server-side hardening
-- ============================================================

-- 1) Restrict direct writes on project_files from authenticated role.
--    Server functions use service_role (supabaseAdmin) for writes.
--    Users keep read + delete-own; INSERT/UPDATE go through the server.
DROP POLICY IF EXISTS "Users manage own project files" ON public.project_files;
DROP POLICY IF EXISTS "Users can view own project files" ON public.project_files;
DROP POLICY IF EXISTS "Users can insert own project files" ON public.project_files;
DROP POLICY IF EXISTS "Users can update own project files" ON public.project_files;
DROP POLICY IF EXISTS "Users can delete own project files" ON public.project_files;

CREATE POLICY "project_files select own"
  ON public.project_files FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE for authenticated. Server functions use service_role.

-- 2) Support explicit upload lifecycle. 'pending' means the server has
--    reserved the row and issued a signed upload URL. 'uploaded' means
--    the server confirmed the object exists. 'expired' allows cleanup.
--    project_files.status default remains 'uploaded' (legacy rows).
CREATE INDEX IF NOT EXISTS project_files_pending_idx
  ON public.project_files (status, created_at)
  WHERE status = 'pending';

-- 3) Restrict direct writes on render_outputs and render_output_targets.
DROP POLICY IF EXISTS "Users can view own render outputs" ON public.render_outputs;
CREATE POLICY "render_outputs select own"
  ON public.render_outputs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own output targets" ON public.render_output_targets;
CREATE POLICY "render_output_targets select own"
  ON public.render_output_targets FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 4) Atomic completion RPC. Marks a job completed only when its
--    status is still non-terminal AND every expected target has a row
--    in render_outputs. Returns TRUE on success, FALSE if a race made
--    completion invalid so the webhook returns 409 for the worker to
--    retry.
CREATE OR REPLACE FUNCTION public.finalize_render_job(_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  expected int;
  actual int;
  cur_status text;
BEGIN
  SELECT status INTO cur_status FROM public.render_jobs WHERE id = _job_id FOR UPDATE;
  IF cur_status IS NULL THEN RETURN FALSE; END IF;
  IF cur_status IN ('completed','failed','cancelled','expired') THEN
    RETURN cur_status = 'completed';
  END IF;

  SELECT COUNT(*) INTO expected FROM public.render_output_targets WHERE render_job_id = _job_id;
  SELECT COUNT(*) INTO actual FROM public.render_outputs WHERE render_job_id = _job_id;
  IF expected = 0 OR actual <> expected THEN RETURN FALSE; END IF;

  UPDATE public.render_jobs
     SET status = 'completed', progress = 100, completed_at = now()
   WHERE id = _job_id;
  UPDATE public.projects
     SET status = 'completed'
   WHERE id = (SELECT project_id FROM public.render_jobs WHERE id = _job_id);
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_render_job(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_render_job(uuid) TO service_role;
