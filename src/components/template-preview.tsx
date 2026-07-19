import type { TemplateSettings } from "@/lib/project-schemas";

type Props = {
  template: TemplateSettings;
  logoUrl?: string | null;
};

const POSITION_CLASS: Record<TemplateSettings["watermark_position"], string> = {
  "top-left": "top-3 left-3",
  "top-right": "top-3 right-3",
  "bottom-left": "bottom-3 left-3",
  "bottom-right": "bottom-3 right-3",
};

export function TemplatePreview9x16({ template, logoUrl }: Props) {
  return (
    <div className="mx-auto w-full max-w-[280px]">
      <p className="mb-2 text-center text-xs uppercase tracking-wide text-muted-foreground">
        Prévia do layout
      </p>
      <div
        className="relative overflow-hidden rounded-xl border border-border shadow-lg"
        style={{
          aspectRatio: "9 / 16",
          backgroundColor: template.background_color,
          color: template.text_color,
        }}
      >
        {/* Cabeçalho */}
        <div
          className="flex flex-col items-center justify-center gap-1 border-b border-white/10 px-3 py-2 text-center"
          style={{ height: `${template.header_height_ratio * 100}%` }}
        >
          {logoUrl ? (
            <img
              src={logoUrl}
              alt="Logo"
              className="max-h-10 object-contain"
            />
          ) : (
            <div
              className="text-[10px] font-semibold uppercase tracking-widest"
              style={{ color: template.accent_color }}
            >
              LOGO
            </div>
          )}
          {template.page_name && (
            <div className="truncate text-xs font-semibold">
              {template.page_name}
            </div>
          )}
          {template.identifier && (
            <div
              className="truncate text-[10px] opacity-80"
              style={{ color: template.accent_color }}
            >
              {template.identifier}
            </div>
          )}
        </div>

        {/* Área do vídeo */}
        <div
          className="relative flex-1 bg-black/60"
          style={{
            height: `${(1 - template.header_height_ratio) * 100}%`,
          }}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] uppercase tracking-widest text-white/40">
              Vídeo 9:16
            </span>
          </div>

          {/* Frase principal */}
          {template.headline && (
            <div className="absolute inset-x-0 bottom-8 px-4 text-center">
              <p
                className="text-sm font-semibold leading-tight"
                style={{ color: template.text_color }}
              >
                {template.headline}
              </p>
            </div>
          )}

          {/* Marca d'água */}
          <div
            className={`absolute ${POSITION_CLASS[template.watermark_position]}`}
            style={{ opacity: template.watermark_opacity }}
          >
            {logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                className="max-h-6 object-contain"
              />
            ) : (
              <div
                className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase"
                style={{
                  color: template.text_color,
                  backgroundColor: template.accent_color + "40",
                }}
              >
                marca
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
