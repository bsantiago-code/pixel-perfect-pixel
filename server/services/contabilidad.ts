// Arma el asiento de un folio para SAP a partir de las facturas XML guardadas y de las cuentas de Configuración.
// El desglose de cada XML se guarda al subir la factura (factura_desglose); las facturas anteriores a esa tabla se
// leen de su archivo y se guardan aquí la primera vez.
import { extraerDesgloseCfdi, type DesgloseCfdi } from "../../src/lib/desglose-cfdi.ts";
import { armarPayloadSap, CLAVES_CUENTAS, type Cuentas, type FacturaContable, type ResultadoPayload } from "../../src/lib/sap.ts";
import { exec, one, rows, type Db } from "../db.ts";
import { HttpError } from "../http.ts";
import { loadConfig } from "../routes/admin.ts";
import { almacenDeRef } from "../storage/index.ts";
import type { ModoSap } from "./sap.ts";

type R = Record<string, unknown>;

/** Guarda el desglose del XML de una factura (idempotente). */
export async function guardarDesglose(facturaId: string, d: DesgloseCfdi, db?: Db) {
  await exec(
    `INSERT INTO factura_desglose (factura_id, moneda, tipo_cambio, subtotal, descuento, total, detalle)
     VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE moneda = VALUES(moneda), tipo_cambio = VALUES(tipo_cambio), subtotal = VALUES(subtotal),
       descuento = VALUES(descuento), total = VALUES(total), detalle = VALUES(detalle)`,
    [facturaId, d.moneda.slice(0, 3), d.tipoCambio, d.subtotal, d.descuento, d.total, JSON.stringify(d)],
    db,
  );
}

/** Cuentas guardadas en Configuración (solo claves válidas, solo texto). */
export function cuentasDeConfig(cfg: Record<string, unknown>): Cuentas {
  const raw = cfg.sap_cuentas;
  const out: Cuentas = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (CLAVES_CUENTAS.has(k) && typeof v === "string") out[k] = v.trim();
    }
  }
  return out;
}

export const contabilizacionActiva = (cfg: Record<string, unknown>) => cfg.sap_contabilizacion_activa === true;
export const modoSap = (cfg: Record<string, unknown>): ModoSap => (cfg.sap_modo === "real" ? "real" : "simulado");

/** Facturas XML del folio con su desglose (lo rellena si falta). */
export async function facturasContables(solicitudId: string, db?: Db) {
  const list = await rows<R>(
    `SELECT f.id, f.uuid, f.archivo, f.ruta, cg.concepto, d.detalle,
            CASE WHEN d.factura_id IS NULL THEN a.contenido END AS contenido
       FROM facturas f
       JOIN comprobantes_gasto cg ON cg.id = f.concepto_id
       LEFT JOIN factura_desglose d ON d.factura_id = f.id
       LEFT JOIN factura_archivos a ON a.factura_id = f.id
      WHERE f.solicitud_id = ? AND f.tipo = 'XML'
      ORDER BY f.created_at, f.id`,
    [solicitudId],
    db,
  );
  const facturas: FacturaContable[] = [];
  const ilegibles: string[] = [];
  for (const f of list) {
    let desglose: DesgloseCfdi | null = null;
    if (f.detalle) {
      desglose = (typeof f.detalle === "string" ? JSON.parse(f.detalle) : f.detalle) as DesgloseCfdi;
    } else {
      try {
        const texto = f.ruta
          ? (await almacenDeRef(String(f.ruta)).leer(String(f.ruta))).buffer.toString("utf8")
          : f.contenido
            ? (f.contenido as Buffer).toString("utf8")
            : "";
        desglose = texto ? extraerDesgloseCfdi(texto) : null;
      } catch (e) {
        console.error("No se pudo leer el XML de", f.id, e instanceof Error ? e.message : e);
      }
      if (desglose) await guardarDesglose(String(f.id), desglose, db);
    }
    if (!desglose) ilegibles.push(String(f.archivo));
    else facturas.push({ uuid: String(f.uuid), archivo: String(f.archivo), concepto: String(f.concepto), desglose });
  }
  return { facturas, ilegibles };
}

export type Asiento = ResultadoPayload & {
  activo: boolean;
  modo: ModoSap;
  /** Motivos por los que hoy no se puede enviar a SAP (vacío = se puede). */
  bloqueos: string[];
};

/** Asiento del folio + qué impide enviarlo. En modo simulado las cuentas faltantes no bloquean. */
export async function construirAsiento(solicitudId: string, db?: Db): Promise<Asiento> {
  const sol = await one<R>("SELECT * FROM solicitudes WHERE id = ?", [solicitudId], db);
  if (!sol) throw new HttpError(404, "La solicitud no existe.");
  const cfg = await loadConfig();
  const modo = modoSap(cfg);
  const [soc, usr, sat] = await Promise.all([
    one<R>("SELECT rfc FROM sociedades WHERE nombre = ?", [sol.empresa], db),
    one<R>("SELECT id, nombre FROM usuarios WHERE id = ?", [sol.user_id], db),
    one<R>("SELECT COUNT(*) AS n FROM facturas WHERE solicitud_id = ? AND tipo = 'XML' AND sat_estado = 'Pendiente'", [solicitudId], db),
  ]);
  const { facturas, ilegibles } = await facturasContables(solicitudId, db);
  const hoy = new Date();
  const fecha = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
  const r = armarPayloadSap({
    folio: String(sol.folio),
    empresa: String(sol.empresa),
    rfcSociedad: soc?.rfc ? String(soc.rfc) : undefined,
    fecha,
    viajero: { id: String(sol.user_id), nombre: String(usr?.nombre ?? "") },
    facturas,
    cuentas: cuentasDeConfig(cfg),
  });
  const bloqueos: string[] = [];
  if (!facturas.length) bloqueos.push("El folio no tiene facturas XML que contabilizar.");
  for (const a of ilegibles) bloqueos.push(`No se pudo leer el XML "${a}".`);
  if (Number(sat?.n) > 0) bloqueos.push("Hay facturas pendientes de verificar con el SAT; verifícalas antes de compensar.");
  if (modo === "real" && r.faltantes.length) {
    bloqueos.push(`Faltan cuentas contables en Configuración: ${r.faltantes.join(", ")}.`);
  }
  return { ...r, activo: contabilizacionActiva(cfg), modo, bloqueos };
}
