import { useCallback, useEffect, useRef, useState } from "react";
import type { TemplateSettings } from "@/lib/project-schemas";

type Props = {
  template: TemplateSettings;
  headerUrl?: string | null;
  logoUrl?: string | null;
  onPositionChange?: (pos: { x: number; y: number }) => void;
  interactive?: boolean;
};

const POSITION_CLASS: Record<TemplateSettings["watermark_position"], string> = {
  "top-left": "top-3 left-3",
  "top-right": "top-3 right-3",
  "bottom-left": "bottom-3 left-3",
  "bottom-right": "bottom-3 right-3",
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

export function TemplatePreview9x16({
  template,
  headerUrl,
  logoUrl,
  onPositionChange,
  interactive,
}: Props) {
  const useHeaderArt = Boolean(template.header_image_file_id);
  const isCover = template.header_image_fit !== "contain";
  const canDrag = Boolean(interactive && useHeaderArt && isCover && headerUrl && onPositionChange);

  const headerBoxRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const posX = clamp01(template.header_image_position_x ?? 0.5);
  const posY = clamp01(template.header_image_position_y ?? 0.5);

  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }, []);

  useEffect(() => {
    // Reset natural size when the source URL changes so we re-measure.
    setNatural(null);
  }, [headerUrl]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!canDrag) return;
      const box = headerBoxRef.current;
      if (!box || !natural) return;
      const rect = box.getBoundingClientRect();
      const cW = rect.width;
      const cH = rect.height;
      const scale = Math.max(cW / natural.w, cH / natural.h);
      const scaledW = natural.w * scale;
      const scaledH = natural.h * scale;
      const overshootX = Math.max(0, scaledW - cW);
      const overshootY = Math.max(0, scaledH - cH);
      if (overshootX === 0 && overshootY === 0) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const startPosX = posX;
      const startPosY = posY;

      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(true);

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const nextX = overshootX > 0 ? clamp01(startPosX - dx / overshootX) : startPosX;
        const nextY = overshootY > 0 ? clamp01(startPosY - dy / overshootY) : startPosY;
        onPositionChange?.({ x: nextX, y: nextY });
      };
      const up = (ev: PointerEvent) => {
        try {
          (e.target as HTMLElement).releasePointerCapture(ev.pointerId);
        } catch {
          /* noop */
        }
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        setDragging(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [canDrag, natural, onPositionChange, posX, posY],
  );

  const fitClass = isCover ? "object-cover" : "object-contain";
  const objectPosition = isCover ? `${posX * 100}% ${posY * 100}%` : "50% 50%";

  return (
    <div className="mx-auto w-full max-w-[280px]">
      <p className="mb-2 text-center text-xs uppercase tracking-wide text-muted-foreground">
        Prévia do layout
      </p>
      <div
        className="relative overflow-hidden rounded-xl border border-border shadow-lg"
        style={{
          aspectRatio: "9 / 16",
          backgroundColor: useHeaderArt ? "#000000" : template.background_color,
          color: template.text_color,
        }}
      >
        {/* Cabeçalho (arte pronta ou fallback legado) */}
        <div
          ref={headerBoxRef}
          className={`relative w-full overflow-hidden ${
            canDrag ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
          }`}
          style={{
            height: `${template.header_height_ratio * 100}%`,
            backgroundColor: useHeaderArt ? "#000000" : template.background_color,
            touchAction: canDrag ? "none" : undefined,
          }}
          onPointerDown={onPointerDown}
        >
          {useHeaderArt ? (
            headerUrl ? (
              <>
                <img
                  ref={imgRef}
                  src={headerUrl}
                  alt="Arte do cabeçalho"
                  onLoad={onImgLoad}
                  draggable={false}
                  className={`h-full w-full select-none ${fitClass}`}
                  style={{ objectPosition }}
                />
                {canDrag && (
                  <div
                    className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-sm"
                    aria-hidden
                  >
                    Arraste para reposicionar
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-widest text-white/60">
                Arte do cabeçalho
              </div>
            )
          ) : (
            <LegacyHeader template={template} logoUrl={logoUrl ?? null} />
          )}
        </div>

        {/* Área do vídeo */}
        <div
          className="relative bg-black/60"
          style={{ height: `${(1 - template.header_height_ratio) * 100}%` }}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] uppercase tracking-widest text-white/40">Vídeo 9:16</span>
          </div>

          {/* Marca d'água (opcional, sobre o vídeo) */}
          {logoUrl && (
            <div
              className={`absolute ${POSITION_CLASS[template.watermark_position]}`}
              style={{ opacity: template.watermark_opacity }}
            >
              <img src={logoUrl} alt="" className="max-h-6 object-contain" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LegacyHeader({
  template,
  logoUrl,
}: {
  template: TemplateSettings;
  logoUrl: string | null;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 py-2 text-center">
      {logoUrl ? (
        <img src={logoUrl} alt="Logo" className="max-h-10 object-contain" />
      ) : (
        <div
          className="text-[10px] font-semibold uppercase tracking-widest"
          style={{ color: template.accent_color }}
        >
          LOGO
        </div>
      )}
      {template.page_name && (
        <div className="truncate text-xs font-semibold">{template.page_name}</div>
      )}
      {template.identifier && (
        <div className="truncate text-[10px] opacity-80" style={{ color: template.accent_color }}>
          {template.identifier}
        </div>
      )}
    </div>
  );
}
