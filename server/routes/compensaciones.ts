import { Router } from "express";
import { z } from "zod";

import { me, requireAuth, requirePerm } from "../auth.ts";
import { exec, newId, one, rows, tx, type Db } from "../db.ts";
import { bad, HttpError } from "../http.ts";
import { iso } from "../mappers.ts";
import { scopeSolicitudes } from "../scope.ts";
import { construirAsiento, contabilizacionActiva, modoSap } from "../services/contabilidad.ts";
import { contabilizarEnSap } from "../services/sap.ts";
import { exigirAlcance } from "../services/solicitudes.ts";
import { loadConfig } from "./admin.ts";

// ───────── Compensar viaje (Finanzas / Compras, permiso compensar_viaje) ─────────
// Cuando un folio ya está comprobado al 100 % y validado por Compras, se cierra el viaje decidiendo qué pasa con
// lo que el viajero gastó de más (facturas por encima de lo solicitado en cada concepto): se le reembolsa (todo o
// una parte) o no. Un folio compensado ya no admite cambios en sus facturas y sale de las vistas por omisión.

export const compensacionesRouter = Router();
compensacionesRouter.use(requireAuth);

type R = Record<string, unknown>;
const n = (v: unknown) => Number(v) || 0;
const redondear = (v: number) => Math.round(v * 100) / 100;
/** Un envío a SAP "enviando" sin cerrar más allá de este tiempo se considera abandonado y se puede reintentar. */
const ENVIO_VIGENTE_SEG = 120;

export function compensacionOut(r: R) {
  return {
    id: r.id,
    solicitud_id: r.solicitud_id,
    decision: r.decision,
    monto_solicitado: n(r.monto_solicitado),
    monto_comprobado: n(r.monto_comprobado),
    monto_excedente: n(r.monto_excedente),
    monto_reembolso: n(r.monto_reembolso),
    comentario: r.comentario ?? undefined,
    compensado_por: r.compensado_por,
    compensado_at: iso(r.compensado_at),
    documento_sap: r.documento_sap ?? undefined,
  };
}

/** Lanza 409 si el folio ya fue compensado: sus facturas y validaciones quedan congeladas. Recibe el FOLIO. */
export async function exigirNoCompensado(folio: string, db?: Db) {
  const c = await one("SELECT 1 FROM compensaciones WHERE solicitud_id = ?", [folio], db);
  if (c) throw new HttpError(409, "Este viaje ya fue compensado: ya no se pueden modificar sus comprobantes.");
  // Un envío a SAP en curso (o ya confirmado) congela el folio: lo contabilizado debe coincidir con sus facturas.
  const k = await one(
    `SELECT 1 FROM contabilizaciones WHERE solicitud_id = ?
        AND (estado = 'enviado' OR (estado = 'enviando' AND TIMESTAMPDIFF(SECOND, updated_at, NOW(3)) < ?))`,
    [folio, ENVIO_VIGENTE_SEG],
    db,
  );
  if (k) throw new HttpError(409, "Este viaje se está contabilizando en SAP: ya no se pueden modificar sus comprobantes.");
}

/**
 * Resumen por concepto: solicitado, comprobado (lo aplicado, con tope en lo solicitado), facturado (suma de los
 * totales de las facturas XML; en vales, lo aplicado) y excedente = facturado − comprobado.
 */
export async function resumenCompensacion(folio: string, db?: Db) {
  const renglones = await rows<R>(
    `SELECT cg.concepto, cg.monto_solicitado, cg.monto_comprobado, cg.validado,
            -- XML: su Total completo. Vales (foto/PDF sin XML): solo lo aplicado, porque su importe aún es
            -- simulado y no debe generar excedente. El PDF de un par aplica 0.
            COALESCE(SUM(CASE WHEN f.tipo = 'XML' AND f.status <> 'Incompleto' THEN f.total
                              ELSE f.monto_aplicado END), 0) AS facturado
       FROM comprobantes_gasto cg
       LEFT JOIN facturas f ON f.solicitud_id = cg.solicitud_id AND f.concepto = cg.concepto
      WHERE cg.solicitud_id = ?
      GROUP BY cg.solicitud_id, cg.concepto, cg.seq, cg.monto_solicitado, cg.monto_comprobado, cg.validado
      ORDER BY cg.seq`,
    [folio],
    db,
  );
  const conceptos = renglones
    .filter((r) => n(r.monto_solicitado) > 0)
    .map((r) => {
      const solicitado = n(r.monto_solicitado);
      const comprobado = n(r.monto_comprobado);
      const facturado = n(r.facturado);
      return {
        concepto: String(r.concepto),
        solicitado,
        comprobado,
        facturado,
        excedente: redondear(Math.max(0, facturado - comprobado)),
        validado: !!n(r.validado),
      };
    });
  const suma = (k: "solicitado" | "comprobado" | "facturado" | "excedente") =>
    redondear(conceptos.reduce((a, c) => a + c[k], 0));
  // Depósito sobrante: tabla aparte; suma al comprobado del folio (no a un concepto).
  const dep = await one<R>("SELECT COALESCE(SUM(monto), 0) AS total FROM depositos_sobrante WHERE solicitud_id = ?", [folio], db);
  const depositos = redondear(n(dep?.total));
  const comprobadoTotal = redondear(suma("comprobado") + depositos);
  return {
    conceptos,
    solicitado: suma("solicitado"),
    comprobado: comprobadoTotal,
    depositos,
    facturado: suma("facturado"),
    excedente: suma("excedente"),
    // Mismo criterio que avanceComprobacion / avanceValidacion del front.
    comprobadoCompleto:
      conceptos.length > 0 &&
      (conceptos.every((c) => c.comprobado >= c.solicitado) || comprobadoTotal >= suma("solicitado")),
    validadoCompleto: conceptos.length > 0 && conceptos.every((c) => c.validado),
  };
}

// Compensaciones de los folios dentro del alcance del usuario (para marcar "Compensado" en las listas).
compensacionesRouter.get("/compensaciones", async (req, res) => {
  const alcance = scopeSolicitudes(me(req), false);
  const list = await rows<R>(
    `SELECT c.*, k.documento_sap
       FROM compensaciones c
       JOIN solicitudes s ON s.folio = c.solicitud_id
       LEFT JOIN contabilizaciones k ON k.solicitud_id = c.solicitud_id AND k.estado = 'enviado'
      WHERE ${alcance.sql}`,
    alcance.params,
  );
  res.json(list.map(compensacionOut));
});

// Resumen para el diálogo "Compensar viaje" y para el detalle del folio.
compensacionesRouter.get("/solicitudes/:id/compensacion", async (req, res) => {
  const sol = await exigirAlcance(me(req), String(req.params.id));
  const c = await one<R>(
    `SELECT c.*, k.documento_sap FROM compensaciones c
       LEFT JOIN contabilizaciones k ON k.solicitud_id = c.solicitud_id AND k.estado = 'enviado'
      WHERE c.solicitud_id = ?`,
    [sol.folio],
  );
  res.json({
    resumen: await resumenCompensacion(String(sol.folio)),
    compensacion: c ? compensacionOut(c) : null,
  });
});

// Vista previa del asiento que se enviará a SAP al compensar (y estado del último envío). Con la contabilización
// apagada solo avisa que está apagada.
compensacionesRouter.get("/solicitudes/:id/contabilizacion", requirePerm("compensar_viaje"), async (req, res) => {
  const sol = await exigirAlcance(me(req), String(req.params.id));
  const folio = String(sol.folio); // las tablas hijas guardan el folio
  const cfg = await loadConfig();
  const k = await one<R>(
    "SELECT estado, documento_sap, error, intentos, enviado_at FROM contabilizaciones WHERE solicitud_id = ?",
    [folio],
  );
  const envio = k
    ? { estado: k.estado, documento_sap: k.documento_sap ?? null, error: k.error ?? null, intentos: n(k.intentos), enviado_at: iso(k.enviado_at) ?? null }
    : null;
  if (!contabilizacionActiva(cfg)) {
    return res.json({ activo: false, modo: modoSap(cfg), envio });
  }
  const a = await construirAsiento(folio);
  res.json({ ...a, envio });
});

/** Valida la decisión sobre el excedente contra el resumen y devuelve el reembolso y el comentario a guardar. */
function decidirExcedente(
  body: { decision: "reembolsar" | "no_reembolsar" | "sin_excedente"; monto_reembolso?: number; comentario?: string },
  r: Awaited<ReturnType<typeof resumenCompensacion>>,
) {
  const comentario = body.comentario?.trim() || null;
  let reembolso = 0;
  if (r.excedente <= 0) {
    if (body.decision !== "sin_excedente") throw bad("El viaje no tiene gasto excedente que reembolsar.");
  } else {
    if (body.decision === "sin_excedente") throw bad("El viaje tiene gasto excedente: indica si se reembolsa o no.");
    if (!comentario) throw bad("Captura un comentario que justifique la decisión sobre el gasto excedente.");
    if (body.decision === "reembolsar") {
      reembolso = redondear(body.monto_reembolso ?? r.excedente);
      if (!(reembolso > 0)) throw bad("El monto a reembolsar debe ser mayor a 0.");
      if (reembolso > r.excedente) throw bad("El monto a reembolsar no puede ser mayor al gasto excedente.");
    }
  }
  return { comentario, reembolso };
}

/** Registra la compensación (y su bitácora) dentro de la transacción `c`. */
async function registrarCompensacion(
  c: Db,
  p: {
    solicitudId: string;
    folio: unknown;
    userId: string;
    body: { decision: "reembolsar" | "no_reembolsar" | "sin_excedente"; monto_reembolso?: number; comentario?: string };
    documentoSap?: string;
  },
) {
  const sol = await one<R>("SELECT id FROM solicitudes WHERE id = ? FOR UPDATE", [p.solicitudId], c);
  if (!sol) throw new HttpError(404, "La solicitud no existe.");
  if (await one("SELECT 1 FROM compensaciones WHERE solicitud_id = ?", [p.folio], c)) {
    throw new HttpError(409, `El viaje ${p.folio} ya fue compensado.`);
  }
  const r = await resumenCompensacion(String(p.folio), c);
  if (!r.comprobadoCompleto) throw new HttpError(409, "El viaje aún no está comprobado al 100 %.");
  if (!r.validadoCompleto) throw new HttpError(409, "Compras aún no valida todos los conceptos del viaje.");
  const { comentario, reembolso } = decidirExcedente(p.body, r);

  const id = newId("comp_");
  await exec(
    `INSERT INTO compensaciones (id, solicitud_id, decision, monto_solicitado, monto_comprobado, monto_excedente,
                                 monto_reembolso, comentario, compensado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, p.folio, p.body.decision, r.solicitado, r.comprobado, r.excedente, reembolso, comentario, p.userId],
    c,
  );
  await (c as unknown as { query: (sql: string, v: unknown[]) => Promise<unknown> }).query(
    "CALL sp_registrar_log(?, ?, ?, ?, ?)",
    [
      "viaje_compensado", "solicitud", p.solicitudId, p.userId,
      JSON.stringify({
        folio: p.folio, decision: p.body.decision, excedente: r.excedente, reembolso, comentario,
        documento_sap: p.documentoSap ?? null,
      }),
    ],
  );
  return one<R>("SELECT * FROM compensaciones WHERE id = ?", [id], c);
}

// Compensar el viaje. Con la contabilización a SAP activa (Configuración) el viaje SOLO se compensa si SAP confirma
// el asiento: 1) se valida todo y se arma el asiento, 2) se reserva el envío (estado "enviando", que congela el
// folio), 3) se llama a SAP fuera de la transacción, 4) con la confirmación se registra la compensación; si SAP
// falla o no responde, el folio queda sin compensar y se puede volver a intentar.
compensacionesRouter.post(
  "/solicitudes/:id/compensar",
  requirePerm("compensar_viaje"),
  async (req, res) => {
    const auth = me(req);
    const body = z
      .object({
        decision: z.enum(["reembolsar", "no_reembolsar", "sin_excedente"]),
        monto_reembolso: z.coerce.number().optional(),
        comentario: z.string().optional(),
      })
      .parse(req.body);
    const solicitudId = String(req.params.id);
    const sol = await exigirAlcance(auth, solicitudId);
    const folio = String(sol.folio); // compensaciones, contabilizaciones y demás tablas hijas guardan el folio
    if (sol.estatus !== "Cerrado") throw new HttpError(409, "Solo se compensan viajes autorizados.");

    const cfg = await loadConfig();
    if (!contabilizacionActiva(cfg)) {
      const out = await tx(
        (c) => registrarCompensacion(c, { solicitudId, folio: sol.folio, userId: auth.user.id, body }),
        auth.user.id,
      );
      res.status(201).json(compensacionOut(out!));
      return;
    }

    // 1. Validaciones previas (sin bloquear nada) y asiento.
    if (await one("SELECT 1 FROM compensaciones WHERE solicitud_id = ?", [folio])) {
      throw new HttpError(409, `El viaje ${sol.folio} ya fue compensado.`);
    }
    const resumen = await resumenCompensacion(folio);
    if (!resumen.comprobadoCompleto) throw new HttpError(409, "El viaje aún no está comprobado al 100 %.");
    if (!resumen.validadoCompleto) throw new HttpError(409, "Compras aún no valida todos los conceptos del viaje.");
    decidirExcedente(body, resumen);
    const asiento = await construirAsiento(folio);
    if (asiento.bloqueos.length) throw new HttpError(409, asiento.bloqueos.join(" "));
    const modo = modoSap(cfg);

    // 2. Reservar el envío (una sola contabilización por folio).
    const reserva = await tx(async (c) => {
      await one("SELECT id FROM solicitudes WHERE id = ? FOR UPDATE", [solicitudId], c);
      if (await one("SELECT 1 FROM compensaciones WHERE solicitud_id = ?", [folio], c)) {
        throw new HttpError(409, `El viaje ${sol.folio} ya fue compensado.`);
      }
      const prev = await one<R>(
        `SELECT id, estado, documento_sap, TIMESTAMPDIFF(SECOND, updated_at, NOW(3)) AS antiguedad
           FROM contabilizaciones WHERE solicitud_id = ? FOR UPDATE`,
        [folio],
        c,
      );
      if (prev) {
        // Ya confirmado por SAP en un intento anterior cuya compensación no alcanzó a guardarse: no se reenvía.
        if (prev.estado === "enviado") return { id: String(prev.id), documento: String(prev.documento_sap ?? "") };
        if (prev.estado === "enviando" && n(prev.antiguedad) < ENVIO_VIGENTE_SEG) {
          throw new HttpError(409, "Ya hay un envío a SAP en curso para este viaje. Espera unos segundos e inténtalo de nuevo.");
        }
        await exec(
          `UPDATE contabilizaciones SET estado = 'enviando', modo = ?, payload = CAST(? AS JSON), respuesta = NULL,
                  error = NULL, intentos = intentos + 1, creado_por = ? WHERE id = ?`,
          [modo, JSON.stringify(asiento.payload), auth.user.id, prev.id],
          c,
        );
        return { id: String(prev.id), documento: "" };
      }
      const id = newId("ctb_");
      await exec(
        `INSERT INTO contabilizaciones (id, solicitud_id, referencia, estado, modo, payload, intentos, creado_por)
         VALUES (?, ?, ?, 'enviando', ?, CAST(? AS JSON), 1, ?)`,
        [id, folio, asiento.payload.referencia, modo, JSON.stringify(asiento.payload), auth.user.id],
        c,
      );
      return { id, documento: "" };
    }, auth.user.id);

    // 3. SAP (fuera de la transacción: puede tardar).
    let documento = reserva.documento;
    let respuesta: unknown = null;
    if (!documento) {
      const sap = await contabilizarEnSap(asiento.payload, modo);
      if (!sap.ok) {
        await exec("UPDATE contabilizaciones SET estado = 'error', error = ? WHERE id = ?", [sap.error.slice(0, 2000), reserva.id]);
        throw new HttpError(
          409,
          `SAP no confirmó la contabilización: ${sap.error} El viaje no se compensó; puedes volver a intentarlo.`,
        );
      }
      documento = sap.documento;
      respuesta = sap.respuesta;
    }

    // 4. Con la confirmación de SAP: contabilización "enviado" y compensación.
    const out = await tx(async (c) => {
      await exec(
        `UPDATE contabilizaciones SET estado = 'enviado', documento_sap = ?, respuesta = CAST(? AS JSON), error = NULL,
                enviado_at = NOW(3) WHERE id = ?`,
        [documento, JSON.stringify(respuesta ?? null), reserva.id],
        c,
      );
      return registrarCompensacion(c, { solicitudId, folio: sol.folio, userId: auth.user.id, body, documentoSap: documento });
    }, auth.user.id);

    res.status(201).json({ ...compensacionOut(out!), documento_sap: documento });
  },
);
