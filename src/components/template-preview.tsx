import type { TemplateSettings } from "@/lib/project-schemas";

type Props = {
  template: TemplateSettings;
  headerUrl?: string | null;
  logoUrl?: string | null;
};

const POSITION_CLASS: Record<TemplateSettings["watermark_position"], string> = {
  "top-left": "top-3 left-3",
  "top-right": "top-3 right-3",
  "bottom-left": "bottom-3 left-3",
  "bottom-right": "bottom-3 right-3",
};

export function TemplatePreview9x16({ template, headerUrl, logoUrl }: Props) {
  const useHeaderArt = Boolean(template.header_image_file_id);
  const fitClass = template.header_image_fit === "contain" ? "object-contain" : "object-cover";

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
          className="relative w-full overflow-hidden"
          style={{
            height: `${template.header_height_ratio * 100}%`,
            backgroundColor: useHeaderArt ? "#000000" : template.background_color,
          }}
        >
          {useHeaderArt ? (
            headerUrl ? (
              <img
                src={headerUrl}
                alt="Arte do cabeçalho"
                className={`h-full w-full ${fitClass}`}
              />
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
