# Worker Contract

External FFmpeg worker integration. All endpoints under `/api/public/*` are
callable without a Supabase session and MUST enforce their own auth in the
handler:

- `x-worker-signature`: HMAC-SHA256 hex over `${timestamp}.${rawBody}` using
  `VIDEO_WORKER_WEBHOOK_SECRET`.
- `x-worker-timestamp`: **epoch seconds** as a decimal string. ISO-8601 and
  millisecond precision are rejected. Freshness window is ±5 minutes.
- Per-request `nonce` (in the JSON body) persisted in
  `worker_request_nonces` for replay protection.

The server never sends `SUPABASE_SERVICE_ROLE_KEY` or `storagePath` to the
worker. The server owns all storage paths. `workerJobId` is the worker-side
job id returned by `POST /jobs` — the app persists it and requires
renew/webhook calls to echo it back verbatim.

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
      "fileType": "source_video | logo | template_asset",
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
  "templateSettings": {
    "page_name": "string ≤ 80",
    "identifier": "string ≤ 80",
    "headline": "string ≤ 200",
    "logo_file_id": "uuid | null (must match an inputFiles.fileId when set)",
    "background_color": "#RRGGBB",
    "text_color": "#RRGGBB",
    "accent_color": "#RRGGBB",
    "watermark_position": "top-left | top-right | bottom-left | bottom-right",
    "watermark_opacity": "0..1",
    "header_height_ratio": "0..0.4 (fraction of 1920)"
  },
  "variationSettings": {
    "brightness":  { "min": -0.2, "max": 0.2 },
    "contrast":    { "min": 0.8,  "max": 1.2 },
    "saturation":  { "min": 0.8,  "max": 1.2 },
    "temperature": { "min": -15,  "max": 15  },
    "scale":       { "min": 1.0,  "max": 1.1 },
    "watermark_position_jitter": false,
    "variation_count": 3
  },
  "variationCount": 3,
  "uploadTtlSeconds": 7200
}
```

`fileType` comes from `project_files` (never client-supplied). Music is NOT
part of this contract version — no audio inputs are accepted. Only assets
actually referenced by `templateSettings` are included. `outputTargets`
length equals `sourceCount × variationCount`, hard-capped at 400.

### Rendering rules (canonical)

- Output is always `1080×1920` (portrait, `yuv420p`, `h264`).
- The top `header_height_ratio × 1920` pixels are reserved for the header:
  background rectangle in `background_color`, accent underline in
  `accent_color`, logo (when `logo_file_id` set), `page_name` and
  `identifier` in `text_color`. Video is scaled/cropped to fill the
  remaining area — it is never covered by the header.
- `headline` is drawn over the lower portion of the video area, centered,
  in `text_color` with a `background_color` stroke for legibility.
- `logo_file_id` MUST reference an image input (`image/*` MIME). A missing
  or non-image logo fails the job with `template_logo_invalid`.
- The logo is also composed as the watermark. Size ≈ 15% of frame width.
- `watermark_opacity` is applied via `colorchannelmixer=aa=<opacity>`.
- `watermark_position_jitter=true` adds a deterministic per-output offset
  derived from `sha256(jobId|workerOutputId|variationIndex|wm)`, bounded to
  ±4% of frame width and clamped to keep the mark fully inside the frame.
- Variation temperature is expressed in UI units `[-15, 15]` and mapped
  linearly to the ffmpeg `colorbalance` range `[-0.1, 0.1]` inside the
  worker (0 stays 0).

## `POST /api/public/worker-webhook` (worker → server)

Headers: `x-worker-signature`, `x-worker-timestamp`.

```json
{
  "eventId": "unique-per-event",
  "eventType": "status_update",
  "timestamp": 1721400000,
  "jobId": "uuid",
  "workerJobId": "worker-side id (must match render_jobs.worker_job_id)",
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
