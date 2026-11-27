// Pre-Registros: cuentas creadas desde el login con estado "No Autorizado para Viajar".
//  · Finanzas / admin (`gestionar_preregistros`): ven todos con datos bancarios y asignan al jefe inmediato.
//  · El jefe inmediato del usuario (o el administrador): habilita o bloquea al viajero.
import { Router } from "express";
import { z } from "zod";

import { me, requireAuth, requirePerm } from "../auth.ts";
import { exec, one, rows, tx } from "../db.ts";
import { bad, forbidden, HttpError, notFound } from "../http.ts";
import { despacharCorreos, encolarCorreos } from "../services/correo.ts";

export const preregistrosRouter = Router();
preregistrosRouter.use(requireAuth);

type R = Record<string, unknown>;

const BASE = `
  SELECT u.id AS usuario_id, u.nombre, u.correo, u.rfc, u.empresa AS sociedad, u.jefe_id,
         j.nombre AS jefe_nombre, u.autorizado_viajar, p.banco, p.cuenta, p.clabe, p.created_at
    FROM usuarios u
    JOIN prealtas p ON p.usuario_id = u.id
    LEFT JOIN usuarios j ON j.id = u.jefe_id`;

const esAdmin = (nombreRol: string) => nombreRol === "administrador";

preregistrosRouter.get("/preregistros", async (req, res) => {
  const { user, role } = me(req);
  const gestor = !!role.permisos.gestionar_preregistros;
  const jefe = !!role.permisos.autorizar_lte5000;
  if (!gestor && !jefe) throw forbidden();

  // Finanzas/admin ven todo (con datos bancarios); un jefe solo a sus colaboradores directos, sin datos bancarios.
  const list = await rows<R>(
    gestor ? `${BASE} ORDER BY p.created_at DESC` : `${BASE} WHERE u.jefe_id = ? ORDER BY p.created_at DESC`,
    gestor ? [] : [user.id],
  );
  res.json(
    list.map((r) => ({
      usuario_id: r.usuario_id,
      nombre: r.nombre,
      correo: r.correo,
      rfc: r.rfc,
      sociedad: r.sociedad,
      jefe_id: r.jefe_id ?? null,
      jefe_nombre: r.jefe_nombre ?? null,
      autorizado_viajar: !!r.autorizado_viajar,
      fecha: String(r.created_at).replace(" ", "T"),
      // Quién puede habilitar a este usuario: su jefe inmediato o el administrador.
      puede_habilitar: esAdmin(role.nombre) || r.jefe_id === user.id,
      ...(gestor ? { banco: r.banco ?? "", cuenta: r.cuenta ?? "", clabe: r.clabe ?? "" } : {}),
    })),
  );
});

// Candidatos a jefe inmediato (usuarios activos que pueden autorizar solicitudes) para el selector de Finanzas/admin.
preregistrosRouter.get("/preregistros/jefes", requirePerm("gestionar_preregistros"), async (_req, res) => {
  res.json(
    await rows<R>(
      `SELECT u.id, u.nombre FROM usuarios u JOIN roles r ON r.id = u.rol_id
        WHERE u.activo = 1 AND JSON_UNQUOTE(JSON_EXTRACT(r.permisos, '$.autorizar_lte5000')) = 'true'
        ORDER BY u.nombre`,
    ),
  );
});

// Finanzas/admin asignan (o cambian) al jefe inmediato; el jefe recibe un correo.
preregistrosRouter.patch("/preregistros/:usuarioId/jefe", requirePerm("gestionar_preregistros"), async (req, res) => {
  const auth = me(req);
  const { jefe_id } = z.object({ jefe_id: z.string().min(1, "Selecciona al jefe inmediato.") }).parse(req.body);
  const u = await one<R>(`${BASE} WHERE u.id = ?`, [req.params.usuarioId]);
  if (!u) throw notFound("No existe un pre-registro de ese usuario.");
  if (jefe_id === u.usuario_id) throw bad("Una persona no puede ser su propio jefe inmediato.");
  const jefe = await one<R>(
    `SELECT u.id, u.nombre, u.correo FROM usuarios u JOIN roles r ON r.id = u.rol_id
      WHERE u.id = ? AND u.activo = 1
        AND JSON_UNQUOTE(JSON_EXTRACT(r.permisos, '$.autorizar_lte5000')) = 'true'`,
    [jefe_id],
  );
  if (!jefe) throw bad("El jefe inmediato debe ser un usuario activo con permiso para autorizar solicitudes.");

  const cambia = u.jefe_id !== jefe_id;
  const pendientes = await tx(async (c) => {
    await exec("UPDATE usuarios SET jefe_id = ? WHERE id = ?", [jefe_id, u.usuario_id], c);
    await c.query("CALL sp_registrar_log(?, ?, ?, ?, ?)", [
      "jefe_asignado", "usuario", u.usuario_id, auth.user.id,
      JSON.stringify({ jefe: jefe.nombre, antes: u.jefe_nombre ?? null }),
    ]);
    if (!cambia) return [];
    return encolarCorreos(c, {
      destinatarios: [{ id: String(jefe.id), correo: String(jefe.correo) }],
      asunto: `Colaborador pendiente de autorizar para viajar — ${u.nombre}`,
      referencia: String(u.usuario_id),
      cuerpo: [
        `${u.nombre} (${u.correo}, ${u.sociedad}) se registró en el Portal de Viáticos CKL y quedó a tu cargo como jefe inmediato.`,
        "",
        'Su cuenta está "No Autorizado para Viajar": puede entrar al portal, pero no puede crear solicitudes.',
        "Entra a Pre-Registros en el portal y habilítala cuando corresponda.",
      ].join("\n"),
    });
  }, auth.user.id);
  despacharCorreos(pendientes);
  res.json({ ok: true, jefe_id, jefe_nombre: jefe.nombre });
});

// Habilita o vuelve a bloquear al viajero: solo su jefe inmediato (o el administrador).
preregistrosRouter.patch("/preregistros/:usuarioId/viajar", async (req, res) => {
  const { user, role } = me(req);
  const { autorizado } = z.object({ autorizado: z.boolean() }).parse(req.body);
  const u = await one<R>(`${BASE} WHERE u.id = ?`, [req.params.usuarioId]);
  if (!u) throw notFound("No existe un pre-registro de ese usuario.");
  if (u.usuario_id === user.id) throw new HttpError(409, "No puedes cambiar tu propio estado.");
  if (!u.jefe_id) throw new HttpError(409, "Aún no tiene jefe inmediato asignado. Finanzas debe asignarlo primero.");
  if (!esAdmin(role.nombre)) {
    if (!role.permisos.autorizar_lte5000 || u.jefe_id !== user.id) {
      throw new HttpError(409, "Este colaborador no está a tu cargo: solo su jefe inmediato puede habilitarlo.");
    }
  }
  await exec("UPDATE usuarios SET autorizado_viajar = ? WHERE id = ?", [autorizado ? 1 : 0, u.usuario_id]);
  await exec("CALL sp_registrar_log(?, ?, ?, ?, ?)", [
    autorizado ? "viajero_habilitado" : "viajero_bloqueado", "usuario", u.usuario_id, user.id,
    JSON.stringify({ nombre: u.nombre, jefe: u.jefe_nombre }),
  ]);
  res.json({ ok: true, autorizado_viajar: autorizado });
});
