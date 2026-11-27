import { useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { toast } from "sonner";
import { showErrorDialog } from "@/components/ErrorDialog";
import { api } from "@/lib/api";
import { useApiMutation, useResumenCompensacion, useVistaSap } from "@/lib/queries";
import {
  DECISION_COMPENSACION,
  fmtTarifa,
  type Compensacion,
  type DecisionCompensacion,
  type Solicitud,
} from "@/lib/store";
import { Modal } from "@/routes/_portal.solicitar";
import type { VistaSap } from "@/lib/queries";

// Diálogo "Compensar viaje" (Finanzas / Compras, permiso compensar_viaje): muestra por concepto lo solicitado,
// lo comprobado (con tope en lo solicitado) y lo facturado de más, y registra la decisión sobre ese excedente.
// El servidor vuelve a validar todo (comprobado al 100 %, validado por Compras, montos y comentario).
export function CompensarViajeDialog({
  solicitud,
  onClose,
  onListo,
}: {
  solicitud: Solicitud;
  onClose: () => void;
  onListo: () => void;
}) {
  const { data, isLoading } = useResumenCompensacion(solicitud.id);
  const r = data?.resumen;
  // Contabilización a SAP: si está activa, compensar solo procede cuando SAP confirma el asiento.
  const { data: sap, refetch: refrescarSap } = useVistaSap(solicitud.id);
  const sapActivo = !!sap?.activo;
  const bloqueos = sap?.bloqueos ?? [];
  const hayExcedente = (r?.excedente ?? 0) > 0;
  const [decision, setDecision] = useState<"reembolsar" | "no_reembolsar">("no_reembolsar");
  const [monto, setMonto] = useState("");
  const [comentario, setComentario] = useState("");

  const compensar = useApiMutation(
    (body: { decision: DecisionCompensacion; monto_reembolso?: number; comentario?: string }) =>
      api.post(`/solicitudes/${solicitud.id}/compensar`, body),
    {
      onSuccess: () => {
        toast.success(
          sapActivo
            ? `Viaje ${solicitud.folio} compensado y contabilizado en SAP.`
            : `Viaje ${solicitud.folio} compensado.`,
        );
        onListo();
      },
    },
  );

  // Si SAP no confirmó, el estado del envío (y su error) cambió en el servidor: se vuelve a leer.
  useEffect(() => {
    if (compensar.isError) void refrescarSap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compensar.isError]);

  const enviar = () => {
    if (!r) return;
    if (bloqueos.length) return showErrorDialog(bloqueos.join(" "));
    if (!hayExcedente) return compensar.mutate({ decision: "sin_excedente", comentario });
    if (!comentario.trim()) {
      return showErrorDialog("Captura un comentario que justifique la decisión sobre el gasto excedente.");
    }
    if (decision === "reembolsar") {
      const m = monto.trim() === "" ? r.excedente : Number(monto);
      if (!(m > 0)) return showErrorDialog("El monto a reembolsar debe ser mayor a 0.");
      if (m > r.excedente) {
        return showErrorDialog(
          `El monto a reembolsar no puede ser mayor al gasto excedente (${fmtTarifa(r.excedente)}).`,
        );
      }
      return compensar.mutate({ decision, monto_reembolso: m, comentario });
    }
    compensar.mutate({ decision, comentario });
  };

  return (
    <Modal onClose={onClose}>
      <div className="flex items-center gap-2">
        <Scale size={20} style={{ color: "var(--color-primary)" }} />
        <h3 className="text-lg font-semibold">Compensar viaje {solicitud.folio}</h3>
      </div>
      {isLoading || !r ? (
        <p className="mt-4 text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <p className="mt-2 text-xs text-muted-foreground">
            Al compensar se cierra el viaje: ya no se podrán subir ni quitar comprobantes y el folio
            saldrá de las vistas por omisión.
            {sapActivo && " Antes se envía la contabilización a SAP: si SAP no la confirma, el viaje no se compensa."}
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="bg-secondary text-left text-muted-foreground">
                <tr>
                  <th className="p-2">Concepto</th>
                  <th className="p-2 text-right">Solicitado</th>
                  <th className="p-2 text-right">Comprobado</th>
                  <th className="p-2 text-right">Gastó de más</th>
                </tr>
              </thead>
              <tbody>
                {r.conceptos.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="p-2">{c.concepto}</td>
                    <td className="p-2 text-right">{fmtTarifa(c.solicitado)}</td>
                    <td className="p-2 text-right">{fmtTarifa(c.comprobado)}</td>
                    <td
                      className="p-2 text-right font-semibold"
                      style={{ color: c.excedente > 0 ? "#B5040F" : undefined }}
                    >
                      {c.excedente > 0 ? fmtTarifa(c.excedente) : "—"}
                    </td>
                  </tr>
                ))}
                {r.depositos > 0 && (
                  <tr className="border-t">
                    <td className="p-2">Depósito sobrante</td>
                    <td className="p-2 text-right">—</td>
                    <td className="p-2 text-right">{fmtTarifa(r.depositos)}</td>
                    <td className="p-2 text-right">—</td>
                  </tr>
                )}
                <tr className="border-t-2 bg-secondary font-semibold">
                  <td className="p-2">Total</td>
                  <td className="p-2 text-right">{fmtTarifa(r.solicitado)}</td>
                  <td className="p-2 text-right">{fmtTarifa(r.comprobado)}</td>
                  <td className="p-2 text-right" style={{ color: hayExcedente ? "#B5040F" : undefined }}>
                    {hayExcedente ? fmtTarifa(r.excedente) : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {sapActivo && sap && <AsientoSap vista={sap} />}

          {hayExcedente ? (
            <div className="mt-4 space-y-2 text-sm">
              <div className="font-semibold">¿Qué se hace con el gasto excedente?</div>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  className="mt-1"
                  checked={decision === "no_reembolsar"}
                  onChange={() => setDecision("no_reembolsar")}
                />
                <span>No se le reembolsa al viajero</span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  className="mt-1"
                  checked={decision === "reembolsar"}
                  onChange={() => setDecision("reembolsar")}
                />
                <span>Se le reembolsa al viajero</span>
              </label>
              {decision === "reembolsar" && (
                <div className="ml-6">
                  <label className="ckl-label">Monto a reembolsar (máximo {fmtTarifa(r.excedente)})</label>
                  <input
                    type="number"
                    min={0}
                    max={r.excedente}
                    step="0.01"
                    className="ckl-input"
                    placeholder={String(r.excedente)}
                    value={monto}
                    onChange={(e) => setMonto(e.target.value)}
                  />
                </div>
              )}
              <div>
                <label className="ckl-label">Comentario (obligatorio)</label>
                <textarea
                  className="ckl-input min-h-[70px]"
                  value={comentario}
                  onChange={(e) => setComentario(e.target.value)}
                  placeholder="Por qué se reembolsa (o no) el gasto excedente..."
                />
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-2 text-sm">
              <div className="rounded-md p-2 text-xs" style={{ background: "#D8F3DC", color: "#2D6A4F" }}>
                El viaje está cuadrado: no hay gasto por encima de lo solicitado.
              </div>
              <label className="ckl-label">Comentario (opcional)</label>
              <textarea
                className="ckl-input min-h-[60px]"
                value={comentario}
                onChange={(e) => setComentario(e.target.value)}
              />
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className="ckl-btn-ghost">
              Cancelar
            </button>
            <button
              onClick={enviar}
              disabled={compensar.isPending || bloqueos.length > 0}
              className="ckl-btn-primary disabled:opacity-60"
            >
              <Scale size={14} />{" "}
              {compensar.isPending ? "Enviando a SAP…" : sapActivo ? "Compensar y enviar a SAP" : "Compensar viaje"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Resumen de una compensación ya registrada (detalle del folio y Comprobación). */
export function ResumenCompensado({ c, quien }: { c: Compensacion; quien: string }) {
  const fecha = new Date(c.compensado_at).toLocaleString("es-MX", {
    dateStyle: "short",
    timeStyle: "short",
  });
  return (
    <div className="rounded-md border p-3 text-xs" style={{ background: "#EEF2FF", borderColor: "#6366F1", color: "#3730A3" }}>
      <div className="flex items-center gap-1.5 font-semibold">
        <Scale size={14} /> Viaje compensado el {fecha} por {quien}
      </div>
      <div className="mt-1">
        {DECISION_COMPENSACION[c.decision]}
        {c.monto_excedente > 0 && <> · Gasto excedente: {fmtTarifa(c.monto_excedente)}</>}
        {c.decision === "reembolsar" && <> · Reembolso: <b>{fmtTarifa(c.monto_reembolso)}</b></>}
      </div>
      {c.comentario && <div className="mt-1 italic">“{c.comentario}”</div>}
      {c.documento_sap && (
        <div className="mt-1">
          Contabilizado en SAP · documento <b>{c.documento_sap}</b>
        </div>
      )}
    </div>
  );
}

// Vista previa del asiento que se enviará a SAP: líneas por cuenta (gasto, IVA por tasa, retenciones y contrapartida),
// avisos y lo que impide enviar. Las cuentas salen de Configuración; el IVA y los importes, del XML.
function AsientoSap({ vista }: { vista: VistaSap }) {
  const p = vista.payload;
  if (!p) return null;
  const bloqueos = vista.bloqueos ?? [];
  const avisos = [
    ...(vista.faltantes?.length && vista.modo === "simulado"
      ? [`Faltan cuentas contables por configurar (no bloquea en modo simulado): ${vista.faltantes.join(", ")}.`]
      : []),
    ...(vista.advertencias ?? []),
  ];
  return (
    <div className="mt-4 rounded-lg border p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold">Contabilización a SAP · referencia {p.referencia}</div>
        <span
          className="rounded px-2 py-0.5 font-semibold"
          style={{ background: vista.modo === "real" ? "#D8F3DC" : "#FEF3C7", color: vista.modo === "real" ? "#2D6A4F" : "#B45309" }}
        >
          Modo {vista.modo}
        </span>
      </div>
      {vista.envio?.estado === "error" && (
        <div className="mt-2 rounded-md p-2" style={{ background: "#FEE9EA", color: "#B5040F" }}>
          El último envío falló{vista.envio.error ? `: ${vista.envio.error}` : "."} Puedes volver a intentarlo.
        </div>
      )}
      {bloqueos.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-md p-2" style={{ background: "#FEE9EA", color: "#B5040F" }}>
          {bloqueos.map((b) => (
            <li key={b}>• {b}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 max-h-48 overflow-auto rounded border">
        <table className="w-full">
          <thead className="bg-secondary text-left text-muted-foreground">
            <tr>
              <th className="p-1.5">Cuenta</th>
              <th className="p-1.5">Descripción</th>
              <th className="p-1.5 text-right">Debe</th>
              <th className="p-1.5 text-right">Haber</th>
            </tr>
          </thead>
          <tbody>
            {p.lineas.map((l, i) => (
              <tr key={i} className="border-t">
                <td className="p-1.5 font-mono" style={{ color: l.cuenta ? undefined : "#B5040F" }}>
                  {l.cuenta ?? "sin cuenta"}
                </td>
                <td className="p-1.5">{l.descripcion}</td>
                <td className="p-1.5 text-right">{l.debe ? fmtTarifa(l.debe) : ""}</td>
                <td className="p-1.5 text-right">{l.haber ? fmtTarifa(l.haber) : ""}</td>
              </tr>
            ))}
            <tr className="border-t-2 bg-secondary font-semibold">
              <td className="p-1.5" colSpan={2}>Totales</td>
              <td className="p-1.5 text-right">{fmtTarifa(p.totales.debe)}</td>
              <td className="p-1.5 text-right">{fmtTarifa(p.totales.haber)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {avisos.length > 0 && (
        <ul className="mt-2 space-y-1 text-muted-foreground">
          {avisos.map((a) => (
            <li key={a}>• {a}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
