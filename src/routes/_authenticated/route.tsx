import {
  createFileRoute,
  Outlet,
  redirect,
  Link,
  useNavigate,
} from "@tanstack/react-router";
import { LogOut, User } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({
        to: "/auth",
        search: { next: location.href },
      });
    }
    return { user: data.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { user, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();

  async function handleSignOut() {
    try {
      await queryClient.cancelQueries();
      queryClient.clear();
    } catch {
      /* noop */
    }
    await supabase.auth.signOut();
    toast.success("Você saiu.");
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface/50 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/dashboard" className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-md gradient-primary" />
            <span className="text-base font-semibold tracking-tight">
              Editor em Massa
            </span>
          </Link>
          <nav className="flex items-center gap-2">
            <Link
              to="/dashboard"
              activeProps={{ className: "bg-accent" }}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Projetos
            </Link>
            <Link
              to="/settings"
              activeProps={{ className: "bg-accent" }}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <User className="mr-1 inline h-4 w-4" />
              <span className="hidden sm:inline">Conta</span>
            </Link>
            <button
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              title={user.email ?? "Sair"}
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sair</span>
            </button>
          </nav>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
