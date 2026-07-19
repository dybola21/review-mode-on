# Editor em Massa — FFmpeg Worker

Serviço independente responsável por baixar vídeos, aplicar template e
variações editoriais, gerar variantes 9:16 e enviá-las de volta para o
storage do aplicativo Lovable via **URLs assinadas fornecidas pelo próprio
servidor**. O worker nunca conhece o `storagePath`, o `service role key` do
Supabase ou tokens de usuário.

> Este serviço processa somente conteúdo enviado por usuários que
> confirmaram, no aplicativo, possuir os direitos necessários sobre os
> arquivos. O worker não implementa qualquer recurso destinado a evasão
> de detecção, moderação ou direitos autorais.

## Arquitetura

```
┌──────────────┐  POST /jobs      ┌─────────────┐   ffmpeg (spawn, argv)   ┌─────────┐
│ Lovable app  │ ───────────────▶ │   Worker    │ ───────────────────────▶ │  disk   │
│              │                  │  (Fastify)  │                          │  /tmp   │
│              │  webhooks (HMAC) │  ┌────────┐ │   HTTP PUT signed URL    └─────────┘
│              │ ◀─────────────── │  │ SQLite │ │ ───────────────────────▶ Supabase Storage
└──────────────┘                  │  │ queue  │ │                          (render-outputs)
                                  │  └────────┘ │
                                  └─────────────┘
                                    volume /data
```

- **Fila persistente:** SQLite (WAL) montado em `/data`. Idempotência por
  `app_job_id` e `Idempotency-Key`. Recuperação após restart: jobs em
  `processing` voltam para `queued`.
- **Concorrência:** processa `MAX_CONCURRENCY` jobs simultaneamente (padrão 1).
- **Aceita novos jobs** enquanto a fila couber; só executa
  `MAX_CONCURRENCY` renders em paralelo.
- **Contrato:** exatamente o mesmo descrito em
  [`../src/routes/api/public/README.md`](../src/routes/api/public/README.md).

## Endpoints

### `GET /health`

Não requer auth; sujeito a rate limit. Resposta 200 quando ffmpeg, ffprobe
e a fila estão prontos; 503 caso contrário.

```json
{ "status": "ok", "ffmpeg": true, "queue": "ready", "version": "0.1.0" }
```

Não expõe paths, variáveis ou secrets.

### `POST /jobs`

- `Authorization: Bearer <WORKER_API_KEY>` — comparação em tempo constante.
- `Idempotency-Key: <string>` obrigatória.
- Body limitado a 5 MiB, validado com Zod (schema `strict` — rejeita
  `storagePath` e demais campos desconhecidos).
- URLs de download/upload precisam bater com `ALLOWED_DOWNLOAD_HOSTS` /
  `ALLOWED_UPLOAD_HOSTS` e ser HTTPS em produção.
- Nunca aceita comandos, filtros ou argumentos FFmpeg do cliente.

Resposta imediata (antes de processar):

```
202 Accepted
{ "workerJobId": "<uuid gerado pelo worker>" }
```

## Webhooks para o aplicativo

Enviados com `x-worker-signature` (HMAC-SHA256 sobre
`${timestamp}.${rawBody}`) e `x-worker-timestamp` (ISO-8601). Fila de webhooks
persistente com backoff exponencial em 5xx/timeout. Eventos `processing`
são limitados a 1 a cada 2s por job. `completed` só é enviado após todos os
uploads confirmados.

- `200` — sucesso ou duplicado (marca entregue).
- `4xx` — marca entregue e loga aviso (não retentar).
- `5xx`/timeout — retenta com backoff até 5 min.

## Variáveis de ambiente

Todas validadas com Zod no boot. Falta ou valor fraco derruba o processo.

| Variável                   | Obrigatório | Descrição                                         |
| -------------------------- | :---------: | ------------------------------------------------- |
| `PORT`                     |     não     | Porta HTTP (default 3000).                        |
| `WORKER_API_KEY`           |   **sim**   | Bearer usado pelo Lovable (mín. 32 chars).        |
| `APP_WEBHOOK_URL`          |   **sim**   | URL do endpoint `/api/public/worker-webhook`.     |
| `APP_WEBHOOK_SECRET`       |   **sim**   | HMAC dos webhooks (mín. 32 chars).                |
| `WORKER_PUBLIC_URL`        |     não     | URL pública do worker (uso informativo).          |
| `DATA_DIR`                 |     não     | Volume persistente (default `/data`).             |
| `TEMP_DIR`                 |     não     | Diretório efêmero (default `/tmp/editor-worker`). |
| `MAX_CONCURRENCY`          |     não     | Jobs simultâneos (default 1).                     |
| `MAX_INPUT_BYTES`          |     não     | Bytes máx. por download.                          |
| `MAX_OUTPUT_BYTES`         |     não     | Bytes máx. por resultado.                         |
| `MAX_JOB_DURATION_SECONDS` |     não     | Wall clock máx. por job.                          |
| `FFMPEG_TIMEOUT_SECONDS`   |     não     | Timeout por invocação de ffmpeg.                  |
| `ALLOWED_DOWNLOAD_HOSTS`   |   **sim**   | Hostnames permitidos nos inputs (CSV).            |
| `ALLOWED_UPLOAD_HOSTS`     |   **sim**   | Hostnames permitidos nos uploads (CSV).           |
| `LOG_LEVEL`                |     não     | pino level (default `info`).                      |

Segredos, signed URLs e `Authorization` são redigidos dos logs.

## Deploy no Railway

1. **New Service → Deploy from GitHub Repo.**
2. **Root Directory:** `/worker`.
3. **Dockerfile Path:** `/worker/Dockerfile`.
4. **Volume:** monte um volume persistente em `/data` (uma réplica nesta
   primeira versão — SQLite não suporta múltiplos writers).
5. **Public networking:** exponha a porta `3000`.
6. **Domain:** aponte um domínio próprio (`worker.seudominio.com`) para o
   serviço.
7. **Variáveis:** configure os secrets acima. Nunca copie `.env` para a
   imagem — o `.dockerignore` já bloqueia.
8. **Healthcheck** (Railway): `GET /health`, esperando 200.

No Lovable, configure depois:

- `VIDEO_WORKER_URL` = `https://worker.seudominio.com`
- `VIDEO_WORKER_API_KEY` = mesmo valor de `WORKER_API_KEY`
- `VIDEO_WORKER_WEBHOOK_SECRET` = mesmo valor de `APP_WEBHOOK_SECRET`
- `PUBLIC_APP_URL` já configurado (produção)

## Limites e proteções

- Downloads/uploads via `fetch` com `AbortController`, cap de bytes por
  streaming (não confia apenas em `Content-Length`) e allowlist de hosts.
- FFmpeg sempre via `spawn(..., { shell: false })` com argumentos em array.
  Textos do usuário passam por um SVG rasterizado — nunca são interpolados
  em linha de comando.
- Parâmetros de variação determinísticos por `(jobId, workerOutputId, index)`,
  clamped em intervalos seguros.
- Nome de arquivo local sempre gerado pelo worker; `fileName` do cliente é
  usado apenas para o contrato de resposta.
- Sem execução de comandos do cliente; sem `exec`, sem `shell: true`.

## Logs

Estruturados via `pino`. Fields redigidos: `signedUrl`, `signedUploadUrl`,
`authorization`, `WORKER_API_KEY`, `APP_WEBHOOK_SECRET`. Erros de FFmpeg
mantêm apenas o `code` seguro (`render_failed`, `render_timeout`,
`output_invalid`, etc.). Nenhum stack trace ou linha de comando é retornado
ao aplicativo.

## Recuperação

- **Restart:** `recoverInProgress()` volta jobs `processing` para `queued`.
- **Uploads confirmados:** persistidos em `uploaded_outputs`; não são
  refeitos após retomada.
- **URLs expiradas:** `input_expired` / `output_upload_expired` disparam
  chamada aos endpoints `/api/public/worker-renew-input` /
  `.../worker-renew-upload` com HMAC + nonce; retry com backoff limitado.
- **Shutdown:** `SIGTERM`/`SIGINT` param de aceitar jobs, fecham a fila,
  dão até 15s para ffmpeg encerrar e então enviam `SIGKILL`.

## Testes

```bash
cd worker
npm install
npm run lint
npm run typecheck
npm test
```

Testes unitários cobrem: HMAC/timing-safe, allowlist de URLs,
path traversal, contrato Zod (rejeita `storagePath` e campos desconhecidos),
idempotência da fila, recuperação após restart, determinismo das variações,
autenticação/idempotência do `POST /jobs`.

O teste de integração (`tests/integration.ffmpeg.test.ts`) gera 2s de vídeo
sintético via ffmpeg e valida com ffprobe. É automaticamente pulado quando
`ffmpeg`/`ffprobe` não estão instalados no ambiente. Ele passa dentro do
`docker build` (a imagem instala ambos).

## Primeiro teste end-to-end

1. `docker build -t editor-worker ./worker`
2. `docker run --rm -p 3000:3000 -v $(pwd)/.data:/data --env-file worker/.env.local editor-worker`
3. `curl http://localhost:3000/health` → esperar `{ "status": "ok", ... }`.
4. No Lovable, configure `VIDEO_WORKER_URL`, `VIDEO_WORKER_API_KEY`,
   `VIDEO_WORKER_WEBHOOK_SECRET` e submeta um job pequeno (1 vídeo curto,
   1 variação).
5. Confirmar no dashboard do Lovable que o job avança de `submitting` →
   `processing` → `completed` e que o output baixa corretamente.
