import { Router } from "express";
import { z } from "zod";

import { me, requireAuth, requirePerm } from "../auth.ts";
import { exec, newId, one, rows, tx } from "../db.ts";
import { bad, HttpError, notFound } from "../http.ts";
import { day, dmy } from "../mappers.ts";

// ───────── Presupuestos por departamento (Admin / Finanzas, permiso gestionar_presupuestos) ─────────
// Cada departamento tiene bolsas de presupuesto por rango de fechas (por omisión un mes). Lo ejercido NO se
// guarda: v_presupuestos lo calcula con los folios autorizados (Cerrado) cuya fecha de solicitud cae en el rango,
// así que una reversión o un rechazo regresan el monto solos. Las reglas (sin empalmes, montos, bitácora, aviso o
// bloqueo al autorizar) viven en MySQL: sp_validar_presupuesto, trg_presupuestos_*, sp_autorizar_solicitud.

export const presupuestosRouter = Router();
presupuestosRouter.use(requireAuth);

type R = Record<string, unknown>;
const n = (v: unknown) => Number(v) || 0;

export const departamentoOut = (r: R) => ({
  id: Number(r.id),
  nombre: String(r.nombre),
  activo: !!r.activo,
});

export function presupuestoOut(r: R) {
  return {
    id: r.id,
    departamento_id: Number(r.departamento_id),
    departamento: r.departamento,
    fecha_inicio: day(r.fecha_inicio),
    fecha_fin: day(r.fecha_fin),
    monto: n(r.monto),
    notas: r.notas ?? "",
    ejercido: n(r.ejercido),
    disponible: n(r.disponible),
    folios_autorizados: n(r.folios_autorizados),
    por_autorizar: n(r.por_autorizar),
    folios_por_autorizar: n(r.folios_por_autorizar),
    comprobado: n(r.comprobado),
  };
}

/**
 * Presupuesto que le toca a un folio (bolsa de su departamento que cubre la fecha de solicitud). Se muestra en el
 * detalle del folio a quien autoriza. `null` si el folio no tiene departamento.
 */
export async function presupuestoDeSolicitud(solicitudId: string) {
  const s = await one<R>(
    `SELECT s.departamento_id, s.fecha, d.nombre AS departamento
       FROM solicitudes s LEFT JOIN departamentos d ON d.id = s.departamento_id
      WHERE s.id = ?`,
    [solicitudId],
  );
  if (!s) return null;
  if (s.departamento_id == null)
    return { departamento_id: null, departamento: null, presupuesto: null };
  const p = await one<R>(
    "SELECT * FROM v_presupuestos WHERE departamento_id = ? AND ? BETWEEN fecha_inicio AND fecha_fin LIMIT 1",
    [s.departamento_id, s.fecha],
  );
  return {
    departamento_id: Number(s.departamento_id),
    departamento: String(s.departamento),
    presupuesto: p ? presupuestoOut(p) : null,
  };
}

// ───────── departamentos ─────────
// La lista la usa también Usuarios (para asignar el departamento), por eso basta con tener sesión.
presupuestosRouter.get("/departamentos", async (_req, res) => {
  const list = await rows<R>("SELECT * FROM departamentos ORDER BY nombre");
  res.json(list.map(departamentoOut));
});

const departamentoSchema = z.object({
  nombre: z.string().trim().min(1, "Captura el nombre del departamento.").max(80),
  activo: z.boolean().default(true),
});

async function nombreLibre(nombre: string, exceptoId?: number) {
  const otro = await one<R>("SELECT id FROM departamentos WHERE nombre = ? AND id <> ?", [
    nombre,
    exceptoId ?? 0,
  ]);
  if (otro) throw new HttpError(409, `Ya existe el departamento "${nombre}".`);
}

presupuestosRouter.post(
  "/departamentos",
  requirePerm("gestionar_presupuestos"),
  async (req, res) => {
    const d = departamentoSchema.parse(req.body);
    await nombreLibre(d.nombre);
    const r = await exec("INSERT INTO departamentos (nombre, activo) VALUES (?, ?)", [
      d.nombre,
      d.activo,
    ]);
    await exec("CALL sp_registrar_log(?, ?, ?, ?, ?)", [
      "departamento_alta",
      "departamento",
      String(r.insertId),
      me(req).user.id,
      JSON.stringify({ nombre: d.nombre }),
    ]);
    res
      .status(201)
      .json(
        departamentoOut((await one<R>("SELECT * FROM departamentos WHERE id = ?", [r.insertId]))!),
      );
  },
);

// Renombrar o desactivar (no se borran: conservan el historial de folios y presupuestos).
presupuestosRouter.put(
  "/departamentos/:id",
  requirePerm("gestionar_presupuestos"),
  async (req, res) => {
    const d = departamentoSchema.parse(req.body);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw bad("Departamento inválido.");
    const antes = await one<R>("SELECT * FROM departamentos WHERE id = ?", [id]);
    if (!antes) throw notFound("El departamento no existe.");
    await nombreLibre(d.nombre, id);
    await exec("UPDATE departamentos SET nombre = ?, activo = ? WHERE id = ?", [
      d.nombre,
      d.activo,
      id,
    ]);
    if (antes.nombre !== d.nombre || !!antes.activo !== d.activo) {
      await exec("CALL sp_registrar_log(?, ?, ?, ?, ?)", [
        "departamento_modificacion",
        "departamento",
        String(id),
        me(req).user.id,
        JSON.stringify({
          antes: { nombre: antes.nombre, activo: !!antes.activo },
          despues: { nombre: d.nombre, activo: d.activo },
        }),
      ]);
    }
    res.json(departamentoOut((await one<R>("SELECT * FROM departamentos WHERE id = ?", [id]))!));
  },
);

// ───────── presupuestos ─────────
presupuestosRouter.get(
  "/presupuestos",
  requirePerm("gestionar_presupuestos"),
  async (_req, res) => {
    const [list, sinDepto] = await Promise.all([
      rows<R>("SELECT * FROM v_presupuestos ORDER BY departamento, fecha_inicio DESC"),
      one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM usuarios WHERE activo = 1 AND departamento_id IS NULL",
      ),
    ]);
    res.json({ presupuestos: list.map(presupuestoOut), usuarios_sin_departamento: n(sinDepto?.n) });
  },
);

// Folios que cuentan en una bolsa: autorizados (descuentan) y pendientes (por autorizar, informativo).
presupuestosRouter.get(
  "/presupuestos/:id/folios",
  requirePerm("gestionar_presupuestos"),
  async (req, res) => {
    const p = await one<R>("SELECT * FROM presupuestos WHERE id = ?", [req.params.id]);
    if (!p) throw notFound("El presupuesto no existe.");
    const list = await rows<R>(
      `SELECT s.id, s.folio, s.fecha, s.estatus, s.monto_total, s.destino_resumen, u.nombre AS usuario
       FROM solicitudes s JOIN usuarios u ON u.id = s.user_id
      WHERE s.departamento_id = ? AND s.fecha BETWEEN ? AND ? AND s.estatus IN ('Cerrado', 'Abierto')
      ORDER BY s.fecha DESC, s.folio DESC`,
      [p.departamento_id, p.fecha_inicio, p.fecha_fin],
    );
    res.json(
      list.map((r) => ({
        id: r.id,
        folio: r.folio,
        fecha: dmy(r.fecha),
        estatus: r.estatus,
        monto_total: n(r.monto_total),
        destino_resumen: r.destino_resumen,
        usuario: r.usuario,
      })),
    );
  },
);

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (usa aaaa-mm-dd).");
const presupuestoSchema = z.object({
  departamento_id: z.number().int(),
  fecha_inicio: fecha,
  fecha_fin: fecha,
  monto: z.number().min(0, "El monto del presupuesto no puede ser negativo."),
  notas: z.string().trim().max(500).optional().default(""),
});

async function leer(id: string) {
  return presupuestoOut((await one<R>("SELECT * FROM v_presupuestos WHERE id = ?", [id]))!);
}

presupuestosRouter.post(
  "/presupuestos",
  requirePerm("gestionar_presupuestos"),
  async (req, res) => {
    const p = presupuestoSchema.parse(req.body);
    const auth = me(req);
    const id = newId("pp_");
    // La validación (fechas, empalmes) y la bitácora las hace trg_presupuestos_bi/ai.
    await tx(
      (c) =>
        exec(
          `INSERT INTO presupuestos (id, departamento_id, fecha_inicio, fecha_fin, monto, notas, creado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            p.departamento_id,
            p.fecha_inicio,
            p.fecha_fin,
            p.monto,
            p.notas || null,
            auth.user.id,
          ],
          c,
        ),
      auth.user.id,
    );
    res.status(201).json(await leer(id));
  },
);

presupuestosRouter.put(
  "/presupuestos/:id",
  requirePerm("gestionar_presupuestos"),
  async (req, res) => {
    const p = presupuestoSchema.parse(req.body);
    const auth = me(req);
    const id = String(req.params.id);
    const r = await tx(
      (c) =>
        exec(
          `UPDATE presupuestos SET departamento_id = ?, fecha_inicio = ?, fecha_fin = ?, monto = ?, notas = ?
          WHERE id = ?`,
          [p.departamento_id, p.fecha_inicio, p.fecha_fin, p.monto, p.notas || null, id],
          c,
        ),
      auth.user.id,
    );
    if (!r.affectedRows) throw notFound("El presupuesto no existe.");
    res.json(await leer(id));
  },
);

presupuestosRouter.delete(
  "/presupuestos/:id",
  requirePerm("gestionar_presupuestos"),
  async (req, res) => {
    const auth = me(req);
    const r = await tx(
      (c) => exec("DELETE FROM presupuestos WHERE id = ?", [req.params.id], c),
      auth.user.id,
    );
    if (!r.affectedRows) throw notFound("El presupuesto no existe.");
    res.json({ ok: true });
  },
);
