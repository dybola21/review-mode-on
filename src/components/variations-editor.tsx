import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { updateVariationSettings } from "@/lib/project-config.functions";
import {
  DEFAULT_VARIATION_SETTINGS,
  makeVariationSettingsSchema,
  type VariationSettings,
} from "@/lib/project-schemas";

const RANGES = {
  brightness: { min: -0.2, max: 0.2, step: 0.01, label: "Brilho" },
  contrast: { min: 0.8, max: 1.2, step: 0.01, label: "Contraste" },
  saturation: { min: 0.8, max: 1.2, step: 0.01, label: "Saturação" },
  temperature: { min: -15, max: 15, step: 1, label: "Temperatura" },
  scale: { min: 1.0, max: 1.1, step: 0.005, label: "Escala" },
} as const;

type RangeKey = keyof typeof RANGES;

export function VariationsEditor({
  projectId,
  initial,
  currentCount,
  maxVariations,
}: {
  projectId: string;
  initial: unknown;
  currentCount: number;
  maxVariations: number;
}) {
  const schema = useMemo(() => makeVariationSettingsSchema(maxVariations), [maxVariations]);

  const parsed = schema.safeParse(initial);
  const [v, setV] = useState<VariationSettings>(
    parsed.success
      ? parsed.data
      : { ...DEFAULT_VARIATION_SETTINGS, variation_count: currentCount || 1 },
  );

  const saveFn = useServerFn(updateVariationSettings);
  const save = useMutation({
    mutationFn: () => {
      const check = schema.safeParse(v);
      if (!check.success) {
        throw new Error(check.error.issues[0]?.message ?? "Inválido");
      }
      return saveFn({ data: { project_id: projectId, settings: v } });
    },
    onSuccess: () => toast.success("Variações salvas."),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });

  function setRange(key: RangeKey, side: "min" | "max", value: number) {
    setV((prev) => ({ ...prev, [key]: { ...prev[key], [side]: value } }));
  }

  return (
    <div className="surface-card p-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Variações editoriais</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Cada variação gera uma versão editorial do vídeo com pequenos ajustes de identidade
          visual. Máx {maxVariations} por projeto.
        </p>
      </div>

      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Quantidade de variações
          </span>
          <input
            type="number"
            min={1}
            max={maxVariations}
            value={v.variation_count}
            onChange={(e) =>
              setV((prev) => ({
                ...prev,
                variation_count: Math.max(1, Math.min(maxVariations, Number(e.target.value) || 1)),
              }))
            }
            className="input w-32"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          {(Object.keys(RANGES) as RangeKey[]).map((key) => {
            const r = RANGES[key];
            return (
              <div key={key} className="rounded-md border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium">{r.label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {v[key].min} → {v[key].max}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    step={r.step}
                    min={r.min}
                    max={r.max}
                    value={v[key].min}
                    onChange={(e) => setRange(key, "min", Number(e.target.value))}
                    className="input"
                  />
                  <input
                    type="number"
                    step={r.step}
                    min={r.min}
                    max={r.max}
                    value={v[key].max}
                    onChange={(e) => setRange(key, "max", Number(e.target.value))}
                    className="input"
                  />
                </div>
              </div>
            );
          })}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.watermark_position_jitter}
            onChange={(e) => setV((p) => ({ ...p, watermark_position_jitter: e.target.checked }))}
          />
          Permitir leve variação da posição da marca d’água
        </label>

        <div className="flex justify-end">
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {save.isPending ? "Salvando…" : "Salvar variações"}
          </button>
        </div>
      </div>
    </div>
  );
}
