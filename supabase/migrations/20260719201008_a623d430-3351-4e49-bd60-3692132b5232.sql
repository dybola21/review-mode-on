
CREATE TABLE public.worker_request_nonces (
  nonce text PRIMARY KEY,
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

CREATE INDEX worker_request_nonces_expires_idx
  ON public.worker_request_nonces (expires_at);

GRANT ALL ON public.worker_request_nonces TO service_role;

ALTER TABLE public.worker_request_nonces ENABLE ROW LEVEL SECURITY;
-- No policies: unreachable by anon / authenticated by design.
