import { Router } from "express";
import { z } from "zod";

import { me, requireAuth, requirePerm } from "../auth.ts";
import { exec, newId, one, rows, tx, type Db } from "../db.ts";
import { bad, HttpError } from "../http.ts";
import { iso } from "../mappers.ts";
import { scopeSolicitudes } from "../scope.ts";
import { exigirAlcance } from "../services/solicitudes.ts";

// ───────── Compensar viaje (Finanzas / Compras, permiso compensar_viaje) ─────────
// Cuando un folio ya está comprobado al 100 % y validado por Compras, se cierra el viaje decidiendo qué pasa con
// lo que el viajero gastó de más (facturas por encima de lo solicitado en cada concepto): se le reembolsa (todo o
// una parte) o no. Un folio compensado ya no admite cambios en sus facturas y sale de las vistas por omisión.

export const compensacionesRouter = Router();
compensacionesRouter.use(requireAuth);

type R = Record<string, unknown>;
const n = (v: unknown) => Number(v) || 0;
const redondear = (v: number) => Math.round(v * 100) / 100;

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
  };
}

/** Lanza 409 si el folio ya fue compensado: sus facturas y validaciones quedan congeladas. */
export async function exigirNoCompensado(solicitudId: string, db?: Db) {
  const c = await one("SELECT 1 FROM compensaciones WHERE solicitud_id = ?", [solicitudId], db);
  if (c) throw new HttpError(409, "Este viaje ya fue compensado: ya no se pueden modificar sus comprobantes.");
}

/**
 * Resumen por concepto: solicitado, comprobado (lo aplicado, con tope en lo solicitado), facturado (suma de los
 * totales de las facturas XML; en vales, lo aplicado) y excedente = facturado − comprobado.
 */
export async function resumenCompensacion(solicitudId: string, db?: Db) {
  const renglones = await rows<R>(
    `SELECT cg.id, cg.concepto, cg.monto_solicitado, cg.monto_comprobado, cg.validado,
            -- XML: su Total completo. Vales (foto/PDF sin XML): solo lo aplicado, porque su importe aún es
            -- simulado y no debe generar excedente. El PDF de un par aplica 0.
            COALESCE(SUM(CASE WHEN f.tipo = 'XML' AND f.status <> 'Incompleto' THEN f.total
                              ELSE f.monto_aplicado END), 0) AS facturado
       FROM comprobantes_gasto cg
       LEFT JOIN facturas f ON f.concepto_id = cg.id
      WHERE cg.solicitud_id = ?
      GROUP BY cg.id, cg.concepto, cg.monto_solicitado, cg.monto_comprobado, cg.validado
      ORDER BY cg.id`,
    [solicitudId],
    db,
  );
  const conceptos = renglones
    .filter((r) => n(r.monto_solicitado) > 0)
    .map((r) => {
      const solicitado = n(r.monto_solicitado);
      const comprobado = n(r.monto_comprobado);
      const facturado = n(r.facturado);
      return {
        id: String(r.id),
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
  const dep = await one<R>("SELECT COALESCE(SUM(monto), 0) AS total FROM depositos_sobrante WHERE solicitud_id = ?", [solicitudId], db);
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
    `SELECT c.* FROM compensaciones c JOIN solicitudes s ON s.id = c.solicitud_id WHERE ${alcance.sql}`,
    alcance.params,
  );
  res.json(list.map(compensacionOut));
});

// Resumen para el diálogo "Compensar viaje" y para el detalle del folio.
compensacionesRouter.get("/solicitudes/:id/compensacion", async (req, res) => {
  await exigirAlcance(me(req), String(req.params.id));
  const c = await one<R>("SELECT * FROM compensaciones WHERE solicitud_id = ?", [req.params.id]);
  res.json({
    resumen: await resumenCompensacion(String(req.params.id)),
    compensacion: c ? compensacionOut(c) : null,
  });
});

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
    const sol = await exigirAlcance(auth, String(req.params.id));
    if (sol.estatus !== "Cerrado") throw new HttpError(409, "Solo se compensan viajes autorizados.");

    const out = await tx(async (c) => {
      // Se bloquea la solicitud para que dos personas no compensen el mismo folio a la vez.
      await one("SELECT id FROM solicitudes WHERE id = ? FOR UPDATE", [req.params.id], c);
      if (await one("SELECT 1 FROM compensaciones WHERE solicitud_id = ?", [req.params.id], c)) {
        throw new HttpError(409, `El viaje ${sol.folio} ya fue compensado.`);
      }
      const r = await resumenCompensacion(String(req.params.id), c);
      if (!r.comprobadoCompleto) throw new HttpError(409, "El viaje aún no está comprobado al 100 %.");
      if (!r.validadoCompleto) throw new HttpError(409, "Compras aún no valida todos los conceptos del viaje.");

      const comentario = body.comentario?.trim() || null;
      let reembolso = 0;
      if (r.excedente <= 0) {
        if (body.decision !== "sin_excedente") throw bad("El viaje no tiene gasto excedente que reembolsar.");
      } else {
        if (body.decision === "sin_excedente") {
          throw bad("El viaje tiene gasto excedente: indica si se reembolsa o no.");
        }
        if (!comentario) throw bad("Captura un comentario que justifique la decisión sobre el gasto excedente.");
        if (body.decision === "reembolsar") {
          reembolso = redondear(body.monto_reembolso ?? r.excedente);
          if (!(reembolso > 0)) throw bad("El monto a reembolsar debe ser mayor a 0.");
          if (reembolso > r.excedente) {
            throw bad("El monto a reembolsar no puede ser mayor al gasto excedente.");
          }
        }
      }

      const id = newId("comp_");
      await exec(
        `INSERT INTO compensaciones (id, solicitud_id, decision, monto_solicitado, monto_comprobado, monto_excedente,
                                     monto_reembolso, comentario, compensado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.params.id, body.decision, r.solicitado, r.comprobado, r.excedente, reembolso, comentario, auth.user.id],
        c,
      );
      await c.query("CALL sp_registrar_log(?, ?, ?, ?, ?)", [
        "viaje_compensado", "solicitud", req.params.id, auth.user.id,
        JSON.stringify({
          folio: sol.folio, decision: body.decision, excedente: r.excedente, reembolso, comentario,
        }),
      ]);
      return one<R>("SELECT * FROM compensaciones WHERE id = ?", [id], c);
    }, auth.user.id);

    res.status(201).json(compensacionOut(out!));
  },
);
