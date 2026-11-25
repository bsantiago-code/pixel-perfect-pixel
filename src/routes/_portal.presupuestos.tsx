import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AlertTriangle, Edit2, Eye, Plus, RefreshCw, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import {
  lista,
  useApiMutation,
  useDepartamentos,
  useFoliosPresupuesto,
  useLogs,
  usePresupuestos,
  useUsuarios,
} from "@/lib/queries";
import {
  fmtFechaIso,
  fmtMoney,
  hoyLocal,
  mesDe,
  pctEjercido,
  periodoSiguiente,
  type Departamento,
  type Presupuesto,
} from "@/lib/store";
import { showErrorDialog } from "@/components/ErrorDialog";
import { Paginacion, usePaginacion } from "@/components/portal/Paginacion";
import { DateField, Modal } from "./_portal.solicitar";

export const Route = createFileRoute("/_portal/presupuestos")({
  head: () => ({ meta: [{ title: "Presupuestos — CKL" }] }),
  component: Presupuestos,
});

// Formulario de una bolsa (alta, edición o renovación).
type Borrador = {
  id?: string;
  departamento_id: number | "";
  fecha_inicio: string;
  fecha_fin: string;
  monto: string;
  notas: string;
};

const periodo = (p: { fecha_inicio: string; fecha_fin: string }) =>
  `${fmtFechaIso(p.fecha_inicio)} – ${fmtFechaIso(p.fecha_fin)}`;

// Color de la barra de avance: verde < 80 %, ámbar 80–100 %, rojo si se rebasó.
const colorAvance = (pct: number) => (pct > 100 ? "#B5040F" : pct >= 80 ? "#B45309" : "#2D6A4F");

function Presupuestos() {
  const { hasPerm } = useAuth();
  const permitido = hasPerm("gestionar_presupuestos");
  const { data } = usePresupuestos(permitido);
  const presupuestos = lista(data?.presupuestos);
  const departamentos = lista(useDepartamentos().data);
  const [deptoFiltro, setDeptoFiltro] = useState<number | "todos">("todos");
  const [form, setForm] = useState<Borrador | null>(null);
  const [verFolios, setVerFolios] = useState<Presupuesto | null>(null);
  const [gestionDeptos, setGestionDeptos] = useState(false);

  const hoy = hoyLocal();
  const historial = useMemo(
    () => presupuestos.filter((p) => deptoFiltro === "todos" || p.departamento_id === deptoFiltro),
    [presupuestos, deptoFiltro],
  );
  const { visibles: paginaHistorial, paginacion } = usePaginacion(historial);

  const eliminar = useApiMutation((id: string) => api.del(`/presupuestos/${id}`), {
    onSuccess: () => toast.success("Presupuesto eliminado."),
  });

  if (!permitido) {
    return <div className="ckl-card p-8 text-center text-sm">Sin permiso para acceder.</div>;
  }

  const activos = departamentos.filter((d) => d.activo);
  const vigenteDe = (deptoId: number) =>
    presupuestos.find(
      (p) => p.departamento_id === deptoId && p.fecha_inicio <= hoy && hoy <= p.fecha_fin,
    );
  // La bolsa más reciente del departamento (para proponer la renovación).
  const ultimaDe = (deptoId: number) =>
    presupuestos
      .filter((p) => p.departamento_id === deptoId)
      .sort((a, b) => b.fecha_fin.localeCompare(a.fecha_fin))[0];

  const nuevo = (deptoId?: number) => {
    const base = deptoId ? ultimaDe(deptoId) : undefined;
    // Sin bolsas previas: el mes en curso. Con bolsa previa que ya terminó o es la vigente: el periodo siguiente.
    const per =
      base && base.fecha_fin >= mesDe(hoy).fecha_inicio ? periodoSiguiente(base) : mesDe(hoy);
    setForm({
      departamento_id: deptoId ?? "",
      ...per,
      monto: base ? String(base.monto) : "",
      notas: "",
    });
  };
  const renovar = (p: Presupuesto) =>
    setForm({
      departamento_id: p.departamento_id,
      ...periodoSiguiente(ultimaDe(p.departamento_id) ?? p),
      monto: String(p.monto),
      notas: "",
    });
  const editar = (p: Presupuesto) =>
    setForm({
      id: p.id,
      departamento_id: p.departamento_id,
      fecha_inicio: p.fecha_inicio,
      fecha_fin: p.fecha_fin,
      monto: String(p.monto),
      notas: p.notas,
    });
  const borrar = (p: Presupuesto) => {
    const aviso =
      p.folios_autorizados > 0
        ? ` Tiene ${p.folios_autorizados} folio(s) autorizado(s) que dejarán de contar en un presupuesto.`
        : "";
    if (!confirm(`¿Eliminar el presupuesto de ${p.departamento} (${periodo(p)})?${aviso}`)) return;
    eliminar.mutate(p.id);
  };

  return (
    <div className="space-y-5">
      <div
        className="rounded-md border p-3 text-sm"
        style={{ background: "#DBEAFE", color: "#1D4ED8" }}
      >
        Cada departamento tiene su bolsa de presupuesto por periodo (por omisión, un mes). Al quedar
        autorizado un viaje, su monto total se descuenta de la bolsa de su departamento que cubre la
        fecha de la solicitud; si la autorización se revierte, el monto regresa.
      </div>

      {(data?.usuarios_sin_departamento ?? 0) > 0 && (
        <div
          className="flex items-start gap-2 rounded-md border p-3 text-sm"
          style={{ background: "#FEF3C7", color: "#92400E", borderColor: "#F59E0B" }}
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            {data!.usuarios_sin_departamento} usuario(s) activo(s) sin departamento: sus viajes no
            descuentan de ningún presupuesto.{" "}
            {hasPerm("gestionar_usuarios") ? (
              <Link to="/usuarios" className="font-semibold underline">
                Asígnalo en Usuarios.
              </Link>
            ) : (
              "Pide al administrador que se los asigne en Usuarios."
            )}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Presupuesto vigente hoy</h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setGestionDeptos(true)} className="ckl-btn-outline">
            <Tags size={14} /> Departamentos
          </button>
          <button onClick={() => nuevo()} className="ckl-btn-primary" disabled={!activos.length}>
            <Plus size={14} /> Nuevo presupuesto
          </button>
        </div>
      </div>

      {activos.length === 0 ? (
        <div className="ckl-card p-6 text-center text-sm text-muted-foreground">
          No hay departamentos activos. Agrégalos en “Departamentos”.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {activos.map((d) => {
            const p = vigenteDe(d.id);
            if (!p) {
              return (
                <div key={d.id} className="ckl-card flex flex-col justify-between gap-3 p-4">
                  <div>
                    <div className="font-semibold">{d.nombre}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Sin presupuesto vigente.
                    </div>
                  </div>
                  <button onClick={() => nuevo(d.id)} className="ckl-btn-outline self-start">
                    <Plus size={14} /> Asignar presupuesto
                  </button>
                </div>
              );
            }
            const pct = pctEjercido(p);
            return (
              <div key={d.id} className="ckl-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">{d.nombre}</div>
                    <div className="text-xs text-muted-foreground">{periodo(p)}</div>
                  </div>
                  <span className="text-sm font-semibold" style={{ color: colorAvance(pct) }}>
                    {pct}%
                  </span>
                </div>
                <div
                  className="mt-3 h-2 w-full overflow-hidden rounded-full bg-secondary"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Ejercido de ${d.nombre}`}
                >
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(pct, 100)}%`, background: colorAvance(pct) }}
                  />
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Asignado</dt>
                    <dd className="font-medium">{fmtMoney(p.monto)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Ejercido</dt>
                    <dd className="font-medium">{fmtMoney(p.ejercido)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Disponible</dt>
                    <dd
                      className="font-medium"
                      style={{ color: p.disponible < 0 ? "#B5040F" : undefined }}
                    >
                      {fmtMoney(p.disponible)}
                    </dd>
                  </div>
                </dl>
                <div className="mt-2 text-[11px] text-muted-foreground">
                  {p.folios_autorizados} folio(s) autorizado(s)
                  {p.folios_por_autorizar > 0 &&
                    ` · ${p.folios_por_autorizar} por autorizar (${fmtMoney(p.por_autorizar)})`}
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  <button onClick={() => setVerFolios(p)} className="ckl-btn-ghost">
                    <Eye size={14} /> Folios
                  </button>
                  <button onClick={() => editar(p)} className="ckl-btn-ghost">
                    <Edit2 size={14} /> Editar
                  </button>
                  <button onClick={() => renovar(p)} className="ckl-btn-ghost">
                    <RefreshCw size={14} /> Renovar
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="ckl-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
          <h2 className="text-sm font-semibold">Historial de presupuestos</h2>
          <select
            className="ckl-input w-auto"
            value={deptoFiltro}
            onChange={(e) => setDeptoFiltro(e.target.value === "todos" ? "todos" : +e.target.value)}
            aria-label="Filtrar por departamento"
          >
            <option value="todos">Todos los departamentos</option>
            {departamentos.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nombre}
              </option>
            ))}
          </select>
        </div>
        {historial.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            Aún no hay presupuestos registrados.
          </div>
        ) : (
          <>
            {/* Móvil (< 768 px): tarjetas apiladas. */}
            <ul className="divide-y md:hidden">
              {paginaHistorial.map((p) => (
                <li key={p.id} className="p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{p.departamento}</span>
                    <span className="font-semibold" style={{ color: colorAvance(pctEjercido(p)) }}>
                      {pctEjercido(p)}%
                    </span>
                  </div>
                  <div className="text-muted-foreground">{periodo(p)}</div>
                  <div className="mt-1">
                    Asignado {fmtMoney(p.monto)} · Ejercido {fmtMoney(p.ejercido)} · Disponible{" "}
                    <span style={{ color: p.disponible < 0 ? "#B5040F" : undefined }}>
                      {fmtMoney(p.disponible)}
                    </span>
                  </div>
                  <Acciones
                    p={p}
                    onFolios={setVerFolios}
                    onEditar={editar}
                    onRenovar={renovar}
                    onBorrar={borrar}
                  />
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-secondary text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3">Departamento</th>
                    <th className="p-3">Periodo</th>
                    <th className="p-3 text-right">Asignado</th>
                    <th className="p-3 text-right">Ejercido</th>
                    <th className="p-3 text-right">Disponible</th>
                    <th className="p-3 text-right">%</th>
                    <th className="p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {paginaHistorial.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-3">
                        {p.departamento}
                        {p.notas && (
                          <div className="text-[11px] text-muted-foreground">{p.notas}</div>
                        )}
                      </td>
                      <td className="p-3 text-xs">
                        {periodo(p)}
                        {p.fecha_inicio <= hoy && hoy <= p.fecha_fin && (
                          <span
                            className="ckl-badge ml-2"
                            style={{ background: "#D8F3DC", color: "#2D6A4F" }}
                          >
                            Vigente
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right">{fmtMoney(p.monto)}</td>
                      <td className="p-3 text-right">{fmtMoney(p.ejercido)}</td>
                      <td
                        className="p-3 text-right"
                        style={{ color: p.disponible < 0 ? "#B5040F" : undefined }}
                      >
                        {fmtMoney(p.disponible)}
                      </td>
                      <td
                        className="p-3 text-right font-semibold"
                        style={{ color: colorAvance(pctEjercido(p)) }}
                      >
                        {pctEjercido(p)}%
                      </td>
                      <td className="p-3">
                        <Acciones
                          p={p}
                          onFolios={setVerFolios}
                          onEditar={editar}
                          onRenovar={renovar}
                          onBorrar={borrar}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginacion {...paginacion} className="border-t px-3" />
          </>
        )}
      </div>

      {form && (
        <FormPresupuesto
          inicial={form}
          departamentos={departamentos}
          onClose={() => setForm(null)}
        />
      )}
      {verFolios && <FoliosPresupuesto p={verFolios} onClose={() => setVerFolios(null)} />}
      {gestionDeptos && (
        <GestionDepartamentos
          departamentos={departamentos}
          onClose={() => setGestionDeptos(false)}
        />
      )}
    </div>
  );
}

function Acciones({
  p,
  onFolios,
  onEditar,
  onRenovar,
  onBorrar,
}: {
  p: Presupuesto;
  onFolios: (p: Presupuesto) => void;
  onEditar: (p: Presupuesto) => void;
  onRenovar: (p: Presupuesto) => void;
  onBorrar: (p: Presupuesto) => void;
}) {
  const btn = "rounded p-1.5 hover:bg-secondary";
  return (
    <div className="mt-1 flex justify-end gap-0.5 md:mt-0">
      <button
        onClick={() => onFolios(p)}
        className={btn}
        title="Ver folios"
        aria-label="Ver folios"
      >
        <Eye size={14} />
      </button>
      <button onClick={() => onEditar(p)} className={btn} title="Editar" aria-label="Editar">
        <Edit2 size={14} />
      </button>
      <button
        onClick={() => onRenovar(p)}
        className={btn}
        title="Renovar (periodo siguiente)"
        aria-label="Renovar"
      >
        <RefreshCw size={14} />
      </button>
      <button onClick={() => onBorrar(p)} className={btn} title="Eliminar" aria-label="Eliminar">
        <Trash2 size={14} />
      </button>
    </div>
  );
}

const TIPO_LOG: Record<string, string> = {
  presupuesto_alta: "Alta",
  presupuesto_modificacion: "Modificación",
};

function FormPresupuesto({
  inicial,
  departamentos,
  onClose,
}: {
  inicial: Borrador;
  departamentos: Departamento[];
  onClose: () => void;
}) {
  const [f, setF] = useState<Borrador>(inicial);
  const set = <K extends keyof Borrador>(k: K, v: Borrador[K]) => setF((x) => ({ ...x, [k]: v }));
  const usuarios = lista(useUsuarios().data);
  const logs = lista(useLogs({ entidad: "presupuesto", limit: 500 }, !!inicial.id).data).filter(
    (l) => l.entidad_id === inicial.id,
  );
  const nombreUsuario = (id: string | null) => usuarios.find((u) => u.id === id)?.nombre ?? "—";

  const guardar = useApiMutation(
    (b: Borrador) => {
      const body = {
        departamento_id: Number(b.departamento_id),
        fecha_inicio: b.fecha_inicio,
        fecha_fin: b.fecha_fin,
        monto: Number(b.monto),
        notas: b.notas.trim(),
      };
      return b.id ? api.put(`/presupuestos/${b.id}`, body) : api.post("/presupuestos", body);
    },
    {
      onSuccess: (_r, b) => {
        toast.success(b.id ? "Presupuesto actualizado." : "Presupuesto registrado.");
        onClose();
      },
    },
  );

  const submit = () => {
    if (!f.departamento_id) return showErrorDialog("Elige el departamento.");
    if (!f.fecha_inicio || !f.fecha_fin)
      return showErrorDialog("Captura la fecha inicial y la final.");
    if (f.fecha_fin < f.fecha_inicio)
      return showErrorDialog("La fecha final no puede ser anterior a la inicial.");
    const monto = Number(f.monto);
    if (f.monto.trim() === "" || !Number.isFinite(monto) || monto < 0) {
      return showErrorDialog("Captura un monto válido (cero o mayor).");
    }
    guardar.mutate(f);
  };

  const opciones = departamentos.filter((d) => d.activo || d.id === f.departamento_id);

  return (
    <Modal onClose={onClose}>
      <h3 className="mb-3 text-lg font-semibold">
        {f.id ? "Editar presupuesto" : "Nuevo presupuesto"}
      </h3>
      <div className="space-y-3">
        <div>
          <label className="ckl-label">Departamento</label>
          <select
            className="ckl-input"
            value={f.departamento_id}
            onChange={(e) => set("departamento_id", e.target.value ? +e.target.value : "")}
          >
            <option value="">— Elige —</option>
            {opciones.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nombre}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="ckl-label">Desde</label>
            <DateField value={f.fecha_inicio} onChange={(v) => set("fecha_inicio", v)} />
          </div>
          <div>
            <label className="ckl-label">Hasta</label>
            <DateField
              value={f.fecha_fin}
              min={f.fecha_inicio}
              onChange={(v) => set("fecha_fin", v)}
            />
          </div>
        </div>
        <button
          type="button"
          className="text-xs font-medium underline"
          style={{ color: "var(--color-primary)" }}
          onClick={() => setF((x) => ({ ...x, ...mesDe(x.fecha_inicio || hoyLocal()) }))}
        >
          Ajustar al mes completo
        </button>
        <div>
          <label className="ckl-label">Monto asignado ($)</label>
          <input
            type="number"
            min={0}
            className="ckl-input"
            value={f.monto}
            onChange={(e) => set("monto", e.target.value)}
          />
        </div>
        <div>
          <label className="ckl-label">Notas (opcional)</label>
          <input
            className="ckl-input"
            maxLength={500}
            value={f.notas}
            placeholder="Ej. Ampliación aprobada por Dirección"
            onChange={(e) => set("notas", e.target.value)}
          />
        </div>
      </div>

      {logs.length > 0 && (
        <div className="mt-4 rounded-md border">
          <div className="border-b bg-secondary px-3 py-2 text-xs font-semibold">Historial</div>
          <ul className="divide-y text-xs">
            {logs.map((l) => {
              const a = l.detalle.antes as Record<string, unknown> | undefined;
              const d = l.detalle.despues as Record<string, unknown> | undefined;
              const cambios =
                a && d
                  ? [
                      a.monto !== d.monto &&
                        `Monto: ${fmtMoney(Number(a.monto))} → ${fmtMoney(Number(d.monto))}`,
                      (a.fecha_inicio !== d.fecha_inicio || a.fecha_fin !== d.fecha_fin) &&
                        `Periodo: ${periodo(a as { fecha_inicio: string; fecha_fin: string })} → ${periodo(d as { fecha_inicio: string; fecha_fin: string })}`,
                      a.notas !== d.notas &&
                        `Notas: ${String(a.notas ?? "—")} → ${String(d.notas ?? "—")}`,
                    ].filter(Boolean)
                  : [];
              return (
                <li key={l.id} className="px-3 py-2">
                  <b>{TIPO_LOG[l.tipo] ?? l.tipo}</b> · {l.fecha.slice(0, 16).replace("T", " ")} ·{" "}
                  {nombreUsuario(l.usuario_id)}
                  {l.tipo === "presupuesto_alta" && (
                    <div className="mt-0.5 text-muted-foreground">
                      Monto {fmtMoney(Number(l.detalle.monto))}
                    </div>
                  )}
                  {cambios.length > 0 && (
                    <div className="mt-0.5 text-muted-foreground">{cambios.join("; ")}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="ckl-btn-ghost">
          Cancelar
        </button>
        <button onClick={submit} disabled={guardar.isPending} className="ckl-btn-primary">
          {guardar.isPending ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </Modal>
  );
}

function FoliosPresupuesto({ p, onClose }: { p: Presupuesto; onClose: () => void }) {
  const { data, isLoading } = useFoliosPresupuesto(p.id);
  const folios = lista(data);
  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg font-semibold">{p.departamento}</h3>
      <div className="text-xs text-muted-foreground">{periodo(p)}</div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Asignado</div>
          <div className="font-medium">{fmtMoney(p.monto)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Ejercido</div>
          <div className="font-medium">{fmtMoney(p.ejercido)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Comprobado</div>
          <div className="font-medium">{fmtMoney(p.comprobado)}</div>
        </div>
      </div>
      {isLoading ? (
        <div className="mt-4 text-sm text-muted-foreground">Cargando…</div>
      ) : folios.length === 0 ? (
        <div className="mt-4 text-sm text-muted-foreground">
          Ningún folio de este departamento en el periodo.
        </div>
      ) : (
        <ul className="mt-4 divide-y rounded-md border text-xs">
          {folios.map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-2 p-2">
              <div className="min-w-0">
                <div className="font-medium">
                  {s.folio} · {s.usuario}
                </div>
                <div className="text-muted-foreground">
                  {s.fecha} · {s.destino_resumen}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-medium">{fmtMoney(s.monto_total)}</div>
                <span
                  className="ckl-badge"
                  style={
                    s.estatus === "Cerrado"
                      ? { background: "#DBEAFE", color: "#1D4ED8" }
                      : { background: "#FEF3C7", color: "#92400E" }
                  }
                >
                  {s.estatus === "Cerrado" ? "Autorizado" : "Por autorizar"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Solo los autorizados descuentan del presupuesto; los que están por autorizar se muestran
        como referencia.
      </p>
    </Modal>
  );
}

function GestionDepartamentos({
  departamentos,
  onClose,
}: {
  departamentos: Departamento[];
  onClose: () => void;
}) {
  const [nuevo, setNuevo] = useState("");
  const [editando, setEditando] = useState<{ id: number; nombre: string } | null>(null);
  const crear = useApiMutation(
    (nombre: string) => api.post("/departamentos", { nombre, activo: true }),
    {
      onSuccess: () => {
        toast.success("Departamento agregado.");
        setNuevo("");
      },
    },
  );
  const actualizar = useApiMutation((d: Departamento) => api.put(`/departamentos/${d.id}`, d), {
    onSuccess: () => setEditando(null),
  });

  const agregar = () => {
    const nombre = nuevo.trim();
    if (!nombre) return showErrorDialog("Captura el nombre del departamento.");
    crear.mutate(nombre);
  };

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg font-semibold">Departamentos</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Los departamentos no se borran: desactívalos para que ya no se ofrezcan (conservan su
        historial).
      </p>
      <ul className="mt-3 divide-y rounded-md border text-sm">
        {departamentos.map((d) => (
          <li key={d.id} className="flex items-center gap-2 p-2">
            {editando?.id === d.id ? (
              <>
                <input
                  className="ckl-input flex-1"
                  value={editando.nombre}
                  autoFocus
                  onChange={(e) => setEditando({ id: d.id, nombre: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      actualizar.mutate({ ...d, nombre: editando.nombre.trim() });
                    if (e.key === "Escape") setEditando(null);
                  }}
                />
                <button
                  className="ckl-btn-primary"
                  onClick={() => actualizar.mutate({ ...d, nombre: editando.nombre.trim() })}
                >
                  Guardar
                </button>
              </>
            ) : (
              <>
                <span className={`flex-1 ${d.activo ? "" : "text-muted-foreground line-through"}`}>
                  {d.nombre}
                </span>
                <button
                  className="rounded p-1.5 hover:bg-secondary"
                  title="Renombrar"
                  aria-label={`Renombrar ${d.nombre}`}
                  onClick={() => setEditando({ id: d.id, nombre: d.nombre })}
                >
                  <Edit2 size={14} />
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={d.activo}
                  aria-label={d.activo ? `Desactivar ${d.nombre}` : `Activar ${d.nombre}`}
                  onClick={() => actualizar.mutate({ ...d, activo: !d.activo })}
                  className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
                  style={{ background: d.activo ? "var(--color-primary)" : "#ccc" }}
                >
                  <span
                    className="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                    style={{ transform: d.activo ? "translateX(18px)" : "translateX(2px)" }}
                  />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <input
          className="ckl-input flex-1"
          placeholder="Nuevo departamento"
          value={nuevo}
          maxLength={80}
          onChange={(e) => setNuevo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && agregar()}
        />
        <button onClick={agregar} className="ckl-btn-primary" disabled={crear.isPending}>
          <Plus size={14} /> Agregar
        </button>
      </div>
    </Modal>
  );
}
