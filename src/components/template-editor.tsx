import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { TemplatePreview9x16 } from "@/components/template-preview";
import { updateTemplateSettings } from "@/lib/project-config.functions";
import {
  DEFAULT_TEMPLATE_SETTINGS,
  templateSettingsSchema,
  type TemplateSettings,
} from "@/lib/project-schemas";


export function TemplateEditor({
  projectId,
  initial,
}: {
  projectId: string;
  initial: unknown;
}) {
  const parsed = templateSettingsSchema.safeParse(initial);
  const [tpl, setTpl] = useState<TemplateSettings>(
    parsed.success ? parsed.data : defaultTemplateSettings(),
  );

  const saveFn = useServerFn(updateTemplateSettings);
  const save = useMutation({
    mutationFn: () =>
      saveFn({ data: { project_id: projectId, template: tpl } }),
    onSuccess: () => toast.success("Template salvo."),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });

  function set<K extends keyof TemplateSettings>(
    key: K,
    value: TemplateSettings[K],
  ) {
    setTpl((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="surface-card p-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Template do projeto</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Identidade visual aplicada a todas as variações.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome da página">
              <input
                className="input"
                value={tpl.page_name}
                onChange={(e) => set("page_name", e.target.value)}
                maxLength={80}
              />
            </Field>
            <Field label="Identificador">
              <input
                className="input"
                value={tpl.identifier}
                onChange={(e) => set("identifier", e.target.value)}
                maxLength={80}
                placeholder="@usuario"
              />
            </Field>
          </div>
          <Field label="Frase principal">
            <textarea
              className="input min-h-[64px]"
              value={tpl.headline}
              onChange={(e) => set("headline", e.target.value)}
              maxLength={200}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <ColorField
              label="Fundo"
              value={tpl.background_color}
              onChange={(v) => set("background_color", v)}
            />
            <ColorField
              label="Texto"
              value={tpl.text_color}
              onChange={(v) => set("text_color", v)}
            />
            <ColorField
              label="Destaque"
              value={tpl.accent_color}
              onChange={(v) => set("accent_color", v)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Posição da marca">
              <select
                className="input"
                value={tpl.watermark_position}
                onChange={(e) =>
                  set(
                    "watermark_position",
                    e.target.value as TemplateSettings["watermark_position"],
                  )
                }
              >
                <option value="top-left">Sup. esquerda</option>
                <option value="top-right">Sup. direita</option>
                <option value="bottom-left">Inf. esquerda</option>
                <option value="bottom-right">Inf. direita</option>
              </select>
            </Field>
            <Field
              label={`Opacidade da marca (${Math.round(tpl.watermark_opacity * 100)}%)`}
            >
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(tpl.watermark_opacity * 100)}
                onChange={(e) =>
                  set("watermark_opacity", Number(e.target.value) / 100)
                }
              />
            </Field>
            <Field
              label={`Área superior (${Math.round(tpl.header_height_ratio * 100)}%)`}
            >
              <input
                type="range"
                min={5}
                max={40}
                value={Math.round(tpl.header_height_ratio * 100)}
                onChange={(e) =>
                  set("header_height_ratio", Number(e.target.value) / 100)
                }
              />
            </Field>
          </div>

          <div className="flex justify-end">
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {save.isPending ? "Salvando…" : "Salvar template"}
            </button>
          </div>
        </div>

        <TemplatePreview9x16 template={tpl} />
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 cursor-pointer rounded border border-border bg-surface"
        />
        <input
          className="input flex-1 font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={9}
        />
      </div>
    </Field>
  );
}
