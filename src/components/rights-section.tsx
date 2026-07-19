import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  confirmProjectRights,
  getProjectRightsStatus,
} from "@/lib/project-config.functions";
import { RIGHTS_CONFIRMATION_TEXT } from "@/lib/project-schemas";

export function RightsSection({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const statusFn = useServerFn(getProjectRightsStatus);
  const confirmFn = useServerFn(confirmProjectRights);

  const status = useQuery({
    queryKey: ["project-rights", projectId],
    queryFn: () => statusFn({ data: { project_id: projectId } }),
  });

  const confirm = useMutation({
    mutationFn: () => confirmFn({ data: { project_id: projectId } }),
    onSuccess: () => {
      toast.success("Direitos confirmados.");
      qc.invalidateQueries({ queryKey: ["project-rights", projectId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });

  const s = status.data;
  const needsReconfirm = s?.needs_reconfirmation;
  const confirmed = s?.confirmed && !needsReconfirm;

  return (
    <div className="surface-card p-6">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Confirmação de direitos</h2>
      </div>
      <p className="text-sm text-muted-foreground">{RIGHTS_CONFIRMATION_TEXT}</p>

      <div className="mt-4">
        {confirmed ? (
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-500">
            <CheckCircle2 className="mt-0.5 h-4 w-4" />
            <div>
              <div className="font-medium">Direitos confirmados</div>
              {s?.rights_confirmed_at && (
                <div className="text-xs opacity-80">
                  {new Date(s.rights_confirmed_at).toLocaleString("pt-BR")}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {needsReconfirm && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-500">
                <AlertTriangle className="mt-0.5 h-4 w-4" />
                <div>
                  Os arquivos foram alterados após a última confirmação. Uma
                  nova confirmação é necessária antes de qualquer
                  processamento futuro.
                </div>
              </div>
            )}
            <button
              onClick={() => confirm.mutate()}
              disabled={confirm.isPending}
              className="rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {confirm.isPending
                ? "Registrando…"
                : "Confirmo que tenho os direitos"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
