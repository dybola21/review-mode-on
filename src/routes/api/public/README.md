# Worker Contract

External FFmpeg worker integration. All endpoints under `/api/public/*` are
callable without a Supabase session and MUST enforce their own auth in the
handler (HMAC over `${timestamp}.${rawBody}` with
`VIDEO_WORKER_WEBHOOK_SECRET`, timestamp fresh within ±5 minutes, and a
per-request nonce persisted in `worker_request_nonces` for replay
protection).

The server never sends `SUPABASE_SERVICE_ROLE_KEY` or `storagePath` to the
worker. The server owns all storage paths.

## `POST {VIDEO_WORKER_URL}/jobs` (server → worker)

Sent by `submitRenderJob`. Idempotency-Key header equals `jobId`.

```json
{
  "jobId": "uuid",
  "projectId": "uuid",
  "callbackUrl": "https://<PUBLIC_APP_URL>/api/public/worker-webhook",
  "inputFiles": [
    {
      "fileId": "uuid",
      "fileName": "safe-name.mp4",
      "fileType": "source_video | logo | music | template_asset",
      "mimeType": "video/mp4",
      "signedUrl": "https://…"
    }
  ],
  "outputTargets": [
    {
      "workerOutputId": "uuid",
      "fileName": "safe-name_v1.mp4",
      "mimeType": "video/mp4",
      "signedUploadUrl": "https://…"
    }
  ],
  "templateSettings": { "…": "asset references use fileId only" },
  "variationSettings": { "…": "…" },
  "variationCount": 3,
  "uploadTtlSeconds": 7200
}
```

`fileType` comes from `project_files` (never client-supplied). Only assets
actually referenced by `templateSettings` are included. `outputTargets`
length equals `sourceCount × variationCount`, hard-capped at 400.

On definitive POST failure the server marks the job `failed`, removes this
job's `render_output_targets` and any partial objects under
`<userId>/<projectId>/<jobId>/` in the `render-outputs` bucket. Other jobs
are never affected.

## `POST /api/public/worker-webhook` (worker → server)

Headers: `x-worker-signature`, `x-worker-timestamp`.

```json
{
  "eventId": "unique-per-event",
  "eventType": "status_update",
  "timestamp": "2026-07-19T…",
  "jobId": "uuid",
  "workerJobId": "worker-side id",
  "status": "queued | processing | completed | failed | cancelled | expired",
  "progress": 0-100,
  "errorCode": "optional",
  "errorMessage": "optional",
  "outputs": [
    {
      "workerOutputId": "must match a pre-declared target",
      "fileSize": 12345,
      "checksum": "optional",
      "expiresAt": "optional ISO-8601"
    }
  ]
}
```

- `200` — event processed or duplicate `eventId`.
- `400` — payload invalid, unknown output, too many outputs.
- `401` — signature/timestamp invalid, unknown job, worker id mismatch.
- `409` — invalid status transition.
- `503` — transient DB/Storage failure; worker should retry (nonce freed).

`completed` only records outputs that (a) match a pre-declared
`workerOutputId`, (b) exist in the `render-outputs` bucket, and (c) have
size > 0. Any missing/empty/unknown output fails the job.

## `POST /api/public/worker-renew-upload` (worker → server)

Renews the signed upload URL for a single output target.

```json
{
  "jobId": "uuid",
  "workerJobId": "…",
  "workerOutputId": "…",
  "nonce": "unique per request"
}
```

Response:

```json
{ "workerOutputId": "…", "signedUploadUrl": "https://…", "expiresInSeconds": 3600 }
```

Only accepted while the job is in `queued`, `submitting`, or `processing`.

## `POST /api/public/worker-renew-input` (worker → server)

Renews the signed download URL for a single input file.

```json
{
  "jobId": "uuid",
  "workerJobId": "…",
  "fileId": "uuid",
  "nonce": "unique per request"
}
```

Response:

```json
{ "fileId": "uuid", "signedUrl": "https://…", "expiresIn": 3600 }
```

Only accepted while the job is `queued` or `processing`. `storagePath` is
never accepted from the worker and never returned. Transient DB/Storage
errors return `503` and release the nonce so the worker can retry.
