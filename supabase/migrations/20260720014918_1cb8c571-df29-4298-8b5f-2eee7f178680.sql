-- 3-fix-B: reescrever finalize_render_job para ser atômica e exclusiva
-- ============================================================
-- Nova assinatura: recebe o job, o worker_job_id e o conjunto exato de
-- outputs reportados pelo worker. A RPC bloqueia o job (FOR UPDATE),
-- valida estado, valida conjunto exato (missing / extra / duplicados),
-- faz UPSERT em render_outputs preservando os campos server-owned dos
-- targets, e transiciona job + project para 'completed' em uma única
-- transação. Retorna jsonb estruturado para o webhook mapear em HTTP.

-- Remove versões antigas (assinatura antiga: (_job_id uuid) → boolean).
DROP FUNCTION IF EXISTS public.finalize_render_job(uuid);

CREATE OR REPLACE FUNCTION public.finalize_render_job(
  _job_id uuid,
  _worker_job_id text,
  _outputs jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  job_row public.render_jobs%ROWTYPE;
  expected_ids text[];
  reported_ids text[];
  duplicate_ids text[];
  missing_ids text[];
  extra_ids text[];
BEGIN
  IF _outputs IS NULL OR jsonb_typeof(_outputs) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_outputs');
  END IF;

  -- Bloqueia a linha do job para tornar tudo abaixo atômico contra
  -- webhooks concorrentes.
  SELECT * INTO job_row FROM public.render_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Vínculo do worker_job_id: se já vinculado, precisa bater. Se não
  -- vinculado, aceitamos e persistimos aqui mesmo.
  IF job_row.worker_job_id IS NOT NULL AND job_row.worker_job_id <> _worker_job_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'worker_mismatch');
  END IF;

  -- Idempotência forte: já completed e mesmo binding → sucesso.
  IF job_row.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;
  -- Terminal não-completed → não reabrimos.
  IF job_row.status IN ('failed','cancelled','expired') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'terminal');
  END IF;

  -- Coleta esperados (targets do job).
  SELECT COALESCE(array_agg(worker_output_id ORDER BY worker_output_id), ARRAY[]::text[])
    INTO expected_ids
    FROM public.render_output_targets
   WHERE render_job_id = _job_id;

  IF expected_ids = ARRAY[]::text[] THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_targets');
  END IF;

  -- Coleta reportados (com detecção de duplicados).
  SELECT COALESCE(array_agg(elem ORDER BY elem), ARRAY[]::text[])
    INTO reported_ids
    FROM jsonb_array_elements_text(
      (SELECT jsonb_agg(o->>'worker_output_id')
         FROM jsonb_array_elements(_outputs) o)
    ) AS elem;

  -- Duplicados: se o array reportado tem mais elementos que seu conjunto
  -- distinto, existem repetidos.
  SELECT COALESCE(array_agg(dup), ARRAY[]::text[]) INTO duplicate_ids
    FROM (
      SELECT elem AS dup
        FROM jsonb_array_elements_text(
               (SELECT jsonb_agg(o->>'worker_output_id')
                  FROM jsonb_array_elements(_outputs) o)
             ) AS elem
       GROUP BY elem
      HAVING COUNT(*) > 1
    ) d;
  IF duplicate_ids <> ARRAY[]::text[] THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'duplicate_outputs', 'duplicates', duplicate_ids
    );
  END IF;

  -- Missing e extras.
  SELECT COALESCE(array_agg(e ORDER BY e), ARRAY[]::text[]) INTO missing_ids
    FROM unnest(expected_ids) e
   WHERE e <> ALL (reported_ids);
  SELECT COALESCE(array_agg(r ORDER BY r), ARRAY[]::text[]) INTO extra_ids
    FROM unnest(reported_ids) r
   WHERE r <> ALL (expected_ids);

  IF missing_ids <> ARRAY[]::text[] OR extra_ids <> ARRAY[]::text[] THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'set_mismatch',
      'missing', missing_ids,
      'extra',   extra_ids
    );
  END IF;

  -- UPSERT: usa metadata canônica do target (nunca do worker),
  -- persiste file_size / checksum / expires_at vindos do payload.
  INSERT INTO public.render_outputs (
    render_job_id, project_id, user_id,
    worker_output_id, file_name, storage_path, mime_type,
    file_size, checksum, expires_at
  )
  SELECT
    t.render_job_id,
    t.project_id,
    t.user_id,
    t.worker_output_id,
    t.file_name,
    t.storage_path,
    t.mime_type,
    NULLIF((o->>'file_size'), '')::bigint,
    NULLIF(o->>'checksum', ''),
    NULLIF(o->>'expires_at', '')::timestamptz
  FROM public.render_output_targets t
  JOIN jsonb_array_elements(_outputs) o
    ON o->>'worker_output_id' = t.worker_output_id
  WHERE t.render_job_id = _job_id
  ON CONFLICT (render_job_id, worker_output_id) DO UPDATE
    SET file_size  = EXCLUDED.file_size,
        checksum   = EXCLUDED.checksum,
        expires_at = EXCLUDED.expires_at;

  -- Bind worker_job_id se ainda não vinculado (protegido pelo FOR UPDATE
  -- e pela igualdade checada acima).
  UPDATE public.render_jobs
     SET worker_job_id = _worker_job_id
   WHERE id = _job_id
     AND worker_job_id IS NULL;

  -- Transição final: só completa se ainda não-terminal (já validado, mas
  -- reforçamos idempotência).
  UPDATE public.render_jobs
     SET status = 'completed',
         progress = 100,
         completed_at = now()
   WHERE id = _job_id
     AND status NOT IN ('completed','failed','cancelled','expired');

  UPDATE public.projects
     SET status = 'completed'
   WHERE id = job_row.project_id
     AND status NOT IN ('completed','failed');

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_render_job(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_render_job(uuid, text, jsonb) TO service_role;
