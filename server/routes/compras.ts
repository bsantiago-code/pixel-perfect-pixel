import { Router } from "express";
import { z } from "zod";

import { me, requireAuth, requirePerm } from "../auth.ts";
import { exec, newId, one, rows, tx, withConn } from "../db.ts";
import { bad, forbidden, HttpError, notFound } from "../http.ts";
import { convenioOut, day, revisionOut } from "../mappers.ts";
import { scopeSolicitudes } from "../scope.ts";
import {
  COLUMNAS_OBLIGATORIAS,
  MAX_FILAS_IMPORTACION,
  PLANTILLA_CONVENIOS,
} from "../../src/lib/importar-convenios.ts";
import { ESTADOS_MX } from "../../src/lib/store.ts";

export const comprasRouter = Router();
comprasRouter.use(requireAuth);

type R = Record<string, unknown>;

// ───────── convenios con hoteles ─────────
const convenioSchema = z.object({
  anio: z.coerce.number().int().min(2000, "Captura un año válido.").max(2100, "Captura un año válido."),
  tipo_sucursal: z.string().default(""),
  no_sucursal: z.string().default(""),
  destino: z.string().trim().min(1, "Captura el destino."),
  estado: z.string().min(1, "Selecciona el estado del destino."),
  nombre_comercial: z.string().trim().min(1, "Captura el nombre comercial del hotel."),
  costo_sencilla: z.coerce.number().gt(0, "Captura el costo de la habitación sencilla (mayor a cero)."),
  costo_doble: z.coerce.number().gt(0, "El costo de la habitación doble debe ser mayor a cero (o déjalo vacío).").nullable().optional(),
  no_proveedor: z.string().default(""),
  razon_social: z.string().default(""),
  telefono: z.string().default(""),
  contacto: z.string().default(""),
  banco: z.string().default(""),
  correo: z.string().trim().default(""),
  direccion: z.string().trim().max(300, "La dirección admite hasta 300 caracteres.").default(""),
  notas: z.string().default(""),
});

async function validarConvenio(c: z.infer<typeof convenioSchema>, excluirId: string | null) {
  if (c.correo && !/^\S+@\S+\.\S+$/.test(c.correo)) throw bad("El correo no tiene un formato válido.");
  const dup = await one(
    "SELECT id FROM convenios WHERE anio = ? AND destino = ? AND nombre_comercial = ? AND id <> ?",
    [c.anio, c.destino, c.nombre_comercial, excluirId ?? ""],
  );
  if (dup) throw new HttpError(409, "Ya existe un convenio de ese hotel en ese destino y año. Modifica el existente.");
}

const COLS = [
  "anio", "tipo_sucursal", "no_sucursal", "destino", "estado", "nombre_comercial", "costo_sencilla", "costo_doble",
  "no_proveedor", "razon_social", "telefono", "contacto", "banco", "correo", "direccion", "notas",
] as const;

const sincronizar = (c: { query: (sql: string, p?: unknown[]) => Promise<unknown> }, userId: string) =>
  c.query("CALL sp_sincronizar_catalogo_convenios(?, NULL)", [userId]);

comprasRouter.get("/convenios", requirePerm("gestionar_convenios"), async (_req, res) => {
  const list = await rows<R>("SELECT * FROM convenios ORDER BY anio DESC, destino, nombre_comercial");
  res.json(list.map(convenioOut));
});

comprasRouter.post("/convenios", requirePerm("gestionar_convenios"), async (req, res) => {
  const { user } = me(req);
  const c = convenioSchema.parse(req.body);
  await validarConvenio(c, null);
  const id = newId("cv_");
  await tx(async (conn) => {
    await exec(
      `INSERT INTO convenios (id, ${COLS.join(", ")}, activo) VALUES (?, ${COLS.map(() => "?").join(", ")}, 1)`,
      [id, ...COLS.map((k) => c[k] ?? null)],
      conn,
    );
    await sincronizar(conn, user.id);
  }, user.id);
  res.status(201).json(convenioOut((await one<R>("SELECT * FROM convenios WHERE id = ?", [id]))!));
});

// ───────── carga masiva desde Excel (pestaña "Hoteles") ─────────
// La pantalla lee el Excel y manda las filas ya convertidas (src/lib/importar-convenios.ts); aquí se valida de nuevo
// cada fila. Mismo hotel + destino + año que uno existente → se actualiza (solo las columnas que trae el archivo, para
// no borrar datos que el Excel no incluye); si no, alta. Todo en una transacción; las filas con error no se cargan.
const CAMPOS_IMPORTABLES = PLANTILLA_CONVENIOS.map((p) => p.campo) as [string, ...string[]];
comprasRouter.post("/convenios/importar", requirePerm("gestionar_convenios"), async (req, res) => {
  const { user } = me(req);
  const body = z
    .object({
      archivo: z.string().max(255).default(""),
      columnas: z.array(z.enum(CAMPOS_IMPORTABLES)).min(1),
      filas: z
        .array(z.object({ fila: z.number().int(), datos: z.record(z.string(), z.unknown()) }))
        .min(1, "El archivo no trae filas para cargar.")
        .max(MAX_FILAS_IMPORTACION, `Se pueden cargar hasta ${MAX_FILAS_IMPORTACION} convenios por archivo.`),
    })
    .parse(req.body);
  const faltan = COLUMNAS_OBLIGATORIAS.filter((c) => !body.columnas.includes(c));
  if (faltan.length) throw bad(`Al archivo le faltan columnas obligatorias: ${faltan.join(", ")}.`);
  const columnas = COLS.filter((k) => (body.columnas as string[]).includes(k));

  const errores: { fila: number; motivo: string }[] = [];
  const validas: { fila: number; c: z.infer<typeof convenioSchema> }[] = [];
  for (const f of body.filas) {
    const r = convenioSchema.safeParse(f.datos);
    if (!r.success) {
      errores.push({ fila: f.fila, motivo: r.error.issues[0]?.message ?? "Datos inválidos" });
      continue;
    }
    if (!ESTADOS_MX.includes(r.data.estado)) {
      errores.push({ fila: f.fila, motivo: `Estado no reconocido: “${r.data.estado}”` });
      continue;
    }
    if (r.data.correo && !/^\S+@\S+\.\S+$/.test(r.data.correo)) {
      errores.push({ fila: f.fila, motivo: "Correo con formato inválido" });
      continue;
    }
    validas.push({ fila: f.fila, c: r.data });
  }

  let nuevos = 0;
  let actualizados = 0;
  if (validas.length) {
    await tx(async (conn) => {
      for (const { c } of validas) {
        const existe = await one<R>(
          "SELECT id FROM convenios WHERE anio = ? AND destino = ? AND nombre_comercial = ?",
          [c.anio, c.destino, c.nombre_comercial],
          conn,
        );
        if (existe) {
          // El trigger trg_convenios_au registra en la bitácora qué cambió.
          await exec(
            `UPDATE convenios SET ${columnas.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
            [...columnas.map((k) => c[k] ?? null), existe.id],
            conn,
          );
          actualizados++;
        } else {
          await exec(
            `INSERT INTO convenios (id, ${COLS.join(", ")}, activo) VALUES (?, ${COLS.map(() => "?").join(", ")}, 1)`,
            [newId("cv_"), ...COLS.map((k) => c[k] ?? null)],
            conn,
          );
          nuevos++;
        }
      }
      await sincronizar(conn, user.id);
      await conn.query("CALL sp_registrar_log(?, ?, ?, ?, ?)", [
        "convenios_importados", "convenio", "importacion_excel", user.id,
        JSON.stringify({ archivo: body.archivo, nuevos, actualizados, con_error: errores.length }),
      ]);
    }, user.id);
  }
  res.json({ nuevos, actualizados, errores });
});

comprasRouter.put("/convenios/:id", requirePerm("gestionar_convenios"), async (req, res) => {
  const { user } = me(req);
  const c = convenioSchema.parse(req.body);
  if (!(await one("SELECT id FROM convenios WHERE id = ?", [req.params.id]))) throw notFound("El convenio no existe.");
  await validarConvenio(c, String(req.params.id));
  await tx(async (conn) => {
    await exec(`UPDATE convenios SET ${COLS.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...COLS.map((k) => c[k] ?? null), req.params.id], conn);
    await sincronizar(conn, user.id);
  }, user.id);
  res.json(convenioOut((await one<R>("SELECT * FROM convenios WHERE id = ?", [req.params.id]))!));
});

comprasRouter.post("/convenios/:id/baja", requirePerm("gestionar_convenios"), async (req, res) => {
  const { user } = me(req);
  const { motivo } = z.object({ motivo: z.string().default("") }).parse(req.body);
  // El SP exige motivo; se usa un texto por omisión si la baja se captura sin él.
  await withConn(user.id, (c) => c.query("CALL sp_dar_baja_convenio(?, ?, ?)", [req.params.id, motivo.trim() || "Sin motivo capturado", user.id]));
  res.json(convenioOut((await one<R>("SELECT * FROM convenios WHERE id = ?", [req.params.id]))!));
});

comprasRouter.post("/convenios/:id/reactivar", requirePerm("gestionar_convenios"), async (req, res) => {
  const { user } = me(req);
  await withConn(user.id, (c) => c.query("CALL sp_reactivar_convenio(?, ?)", [req.params.id, user.id]));
  res.json(convenioOut((await one<R>("SELECT * FROM convenios WHERE id = ?", [req.params.id]))!));
});

// ───────── revisiones de monto manual de hotel ─────────
comprasRouter.get("/revisiones-monto", async (req, res) => {
  const auth = me(req);
  const revisor = !!auth.role.permisos.revisar_monto_manual;
  // Compras ve todas. Los demás ven las de los folios dentro de su alcance (las propias; el jefe, además las de
  // su equipo; Finanzas, todas): quien autoriza necesita saber si el folio trae un hotel con monto manual y si
  // está bloqueado. La campanita sigue siendo solo para Compras (se filtra en NotificationBell).
  const alcance = scopeSolicitudes(auth, false);
  const list = revisor
    ? await rows<R>("SELECT * FROM revisiones_monto ORDER BY creada_at DESC")
    : await rows<R>(
        `SELECT r.* FROM revisiones_monto r JOIN solicitudes s ON s.id = r.solicitud_id
          WHERE ${alcance.sql} ORDER BY r.creada_at DESC`,
        alcance.params,
      );
  res.json(list.map(revisionOut));
});

comprasRouter.post("/revisiones-monto/:id/decidir", requirePerm("revisar_monto_manual"), async (req, res) => {
  const { user } = me(req);
  const { decision, comentario } = z
    .object({ decision: z.enum(["aceptado", "rechazado"]), comentario: z.string().default("") })
    .parse(req.body);
  const r = await one<R>("SELECT * FROM revisiones_monto WHERE id = ?", [req.params.id]);
  if (!r) throw notFound("La revisión no existe.");
  if (r.estado !== "pendiente") throw new HttpError(409, "Esa revisión ya fue resuelta.");
  if (r.user_id === user.id) throw forbidden("No puedes revisar tu propia solicitud.");
  // El trigger trg_revisiones_monto_bu sella decidido_at; trg_revisiones_monto_au registra la bitácora.
  await exec(
    "UPDATE revisiones_monto SET estado = ?, decidido_por = ?, comentario = ? WHERE id = ?",
    [decision, user.id, comentario.trim() || null, req.params.id],
  );
  res.json(revisionOut((await one<R>("SELECT * FROM revisiones_monto WHERE id = ?", [req.params.id]))!));
});

// ───────── gasto por concepto (Dashboard y Reportes) ─────────
comprasRouter.get("/reportes/renglones-gasto", requirePerm("ver_gasto_por_concepto"), async (_req, res) => {
  const list = await rows<R>(
    "SELECT * FROM v_renglones_gasto WHERE categoria IS NOT NULL ORDER BY created_at DESC, folio",
  );
  res.json(
    list.map((r) => ({
      solicitud_id: r.solicitud_id,
      folio: r.folio,
      user_id: r.user_id,
      empresa: r.empresa,
      created_at: day(r.created_at),
      categoria: r.categoria,
      subconcepto: r.subconcepto,
      solicitado: Number(r.solicitado),
      comprobado: Number(r.comprobado),
    })),
  );
});
