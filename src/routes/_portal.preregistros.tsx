import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { lista, useApiMutation, useJefesPosibles, usePreregistros, type Preregistro } from "@/lib/queries";

export const Route = createFileRoute("/_portal/preregistros")({
  head: () => ({ meta: [{ title: "Pre-Registros — CKL" }] }),
  component: Preregistros,
});

const fh = (iso: string) => new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });

function EstadoBadge({ autorizado }: { autorizado: boolean }) {
  return autorizado ? (
    <span className="ckl-badge" style={{ background: "#D8F3DC", color: "#2D6A4F" }}>Autorizado para Viajar</span>
  ) : (
    <span className="ckl-badge" style={{ background: "#FEF3C7", color: "#B45309" }}>No Autorizado para Viajar</span>
  );
}

// Cuentas creadas desde el Pre-Registro. Finanzas/admin asignan el jefe inmediato; el jefe (o el administrador)
// habilita al colaborador para viajar. Mientras esté "No Autorizado para Viajar" no puede crear solicitudes.
function Preregistros() {
  const { role, hasPerm } = useAuth();
  const gestor = hasPerm("gestionar_preregistros");
  const puedeVer = gestor || hasPerm("autorizar_lte5000");
  const { data } = usePreregistros(puedeVer);
  const { data: jefesData } = useJefesPosibles(gestor);
  const filas = lista(data);
  const jefes = lista(jefesData);

  const asignarJefe = useApiMutation(
    (v: { p: Preregistro; jefe_id: string }) => api.patch(`/preregistros/${v.p.usuario_id}/jefe`, { jefe_id: v.jefe_id }),
    { onSuccess: (_r, v) => toast.success(`Jefe inmediato asignado a ${v.p.nombre}. Se le avisó por correo.`) },
  );
  const cambiarEstado = useApiMutation(
    (v: { p: Preregistro; autorizado: boolean }) => api.patch(`/preregistros/${v.p.usuario_id}/viajar`, { autorizado: v.autorizado }),
    {
      onSuccess: (_r, v) =>
        toast.success(v.autorizado ? `${v.p.nombre} quedó autorizado para viajar.` : `${v.p.nombre} quedó como No Autorizado para Viajar.`),
    },
  );

  if (!puedeVer) {
    return <div className="ckl-card p-8 text-center text-sm">Sin permiso para acceder.</div>;
  }

  const esAdmin = role?.nombre === "administrador";
  const sinJefe = filas.filter((f) => !f.jefe_id && !f.autorizado_viajar).length;
  const porHabilitar = filas.filter((f) => f.puede_habilitar && !f.autorizado_viajar).length;

  return (
    <div className="space-y-4">
      <div className="ckl-card p-4 text-sm">
        <div className="font-semibold">Pre-Registros</div>
        <p className="mt-1 text-xs text-muted-foreground">
          {gestor
            ? "Quien se pre-registra entra al portal de inmediato, pero queda “No Autorizado para Viajar” y no puede crear solicitudes. Asigna su jefe inmediato: él recibe un aviso y es quien lo habilita."
            : "Estos colaboradores se pre-registraron y están a tu cargo. Habilítalos para que puedan crear solicitudes de viáticos."}
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {gestor && <span className="ckl-badge" style={{ background: "#FEF3C7", color: "#B45309" }}>{sinJefe} sin jefe asignado</span>}
          <span className="ckl-badge" style={{ background: "#DBEAFE", color: "#1D4ED8" }}>{porHabilitar} por habilitar por ti</span>
        </div>
      </div>

      <div className="ckl-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-secondary text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Colaborador</th>
              <th className="p-3">Sociedad</th>
              {gestor && <th className="p-3">Datos bancarios</th>}
              <th className="p-3">Registro</th>
              <th className="p-3">Jefe inmediato</th>
              <th className="p-3">Estado</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {filas.map((p) => (
              <tr key={p.usuario_id} className="border-t align-top">
                <td className="p-3">
                  <div className="font-medium">{p.nombre}</div>
                  <div className="text-xs text-muted-foreground">{p.correo}</div>
                  <div className="text-xs text-muted-foreground">{p.rfc}</div>
                </td>
                <td className="p-3 text-xs">{p.sociedad}</td>
                {gestor && (
                  <td className="p-3 text-xs">
                    <div>{p.banco || "—"}</div>
                    <div className="text-muted-foreground">Cuenta: {p.cuenta || "—"}</div>
                    <div className="text-muted-foreground">CLABE: {p.clabe || "—"}</div>
                  </td>
                )}
                <td className="whitespace-nowrap p-3 text-xs">{fh(p.fecha)}</td>
                <td className="p-3 text-xs">
                  {gestor ? (
                    <select
                      className="ckl-input"
                      aria-label={`Jefe inmediato de ${p.nombre}`}
                      value={p.jefe_id ?? ""}
                      disabled={asignarJefe.isPending}
                      onChange={(e) => e.target.value && asignarJefe.mutate({ p, jefe_id: e.target.value })}
                    >
                      <option value="">— Asignar jefe —</option>
                      {jefes.filter((j) => j.id !== p.usuario_id).map((j) => (
                        <option key={j.id} value={j.id}>{j.nombre}</option>
                      ))}
                    </select>
                  ) : (
                    p.jefe_nombre ?? "—"
                  )}
                </td>
                <td className="p-3"><EstadoBadge autorizado={p.autorizado_viajar} /></td>
                <td className="p-3">
                  {p.puede_habilitar ? (
                    p.autorizado_viajar ? (
                      <button
                        onClick={() => cambiarEstado.mutate({ p, autorizado: false })}
                        disabled={cambiarEstado.isPending}
                        className="ckl-btn-outline"
                      >
                        Bloquear
                      </button>
                    ) : (
                      <button
                        onClick={() => cambiarEstado.mutate({ p, autorizado: true })}
                        disabled={cambiarEstado.isPending}
                        className="ckl-btn-primary"
                      >
                        Habilitar para viajar
                      </button>
                    )
                  ) : !p.autorizado_viajar ? (
                    <span className="text-xs text-muted-foreground">
                      {p.jefe_id ? "Lo habilita su jefe" : esAdmin ? "Asigna un jefe" : "Sin jefe asignado"}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
            {filas.length === 0 && (
              <tr>
                <td colSpan={gestor ? 7 : 6} className="p-8 text-center text-sm text-muted-foreground">
                  {gestor ? "Aún no hay pre-registros." : "No tienes colaboradores pre-registrados a tu cargo."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
