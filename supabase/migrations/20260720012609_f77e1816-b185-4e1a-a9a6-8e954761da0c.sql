
-- 3-fix-A: dados & RLS para project_files

-- 1) Remover policies legadas pelos NOMES REAIS existentes.
DROP POLICY IF EXISTS "Users can view their own project files" ON public.project_files;
DROP POLICY IF EXISTS "Users can insert files in their own projects" ON public.project_files;
DROP POLICY IF EXISTS "Users can update their own project files" ON public.project_files;
DROP POLICY IF EXISTS "Users can delete their own project files" ON public.project_files;

-- 2) Garantir a policy única SELECT own (idempotente).
DROP POLICY IF EXISTS "project_files select own" ON public.project_files;
CREATE POLICY "project_files select own"
  ON public.project_files FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 3) Revogar INSERT/UPDATE/DELETE do papel authenticated.
--    Escrita passa a ocorrer somente via server functions (service_role).
REVOKE INSERT, UPDATE, DELETE ON public.project_files FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.project_files FROM anon;
GRANT SELECT ON public.project_files TO authenticated;
GRANT ALL ON public.project_files TO service_role;

-- 4) Ampliar constraint de status para incluir 'pending' e 'expired'.
ALTER TABLE public.project_files
  DROP CONSTRAINT IF EXISTS project_files_status_check;
ALTER TABLE public.project_files
  ADD CONSTRAINT project_files_status_check
  CHECK (status = ANY (ARRAY['pending','uploaded','processing','ready','failed','expired']));

-- 5) Coluna de expiração do upload pendente + índice.
ALTER TABLE public.project_files
  ADD COLUMN IF NOT EXISTS upload_expires_at timestamptz;

DROP INDEX IF EXISTS project_files_pending_idx;
CREATE INDEX IF NOT EXISTS project_files_pending_expiry_idx
  ON public.project_files (upload_expires_at)
  WHERE status = 'pending';

-- 6) Função de limpeza segura de pendências expiradas.
--    Marca como 'expired' registros pending cujo upload_expires_at já passou.
--    Não remove linhas — permite auditoria. Executada por service_role.
CREATE OR REPLACE FUNCTION public.expire_pending_project_files()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.project_files
     SET status = 'expired'
   WHERE status = 'pending'
     AND upload_expires_at IS NOT NULL
     AND upload_expires_at < now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_pending_project_files() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_pending_project_files() TO service_role;
