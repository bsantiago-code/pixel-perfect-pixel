import { Router } from "express";
import { z } from "zod";

import {
  normalizarListaPalabras,
  PALABRAS_DEFAULT,
  type ListasProhibidas,
} from "../../src/lib/palabras-prohibidas.ts";
import { hashPassword, me, requireAuth, requirePerm, toAuthUser } from "../auth.ts";
import { exec, newId, one, rows, tx } from "../db.ts";
import { bad, forbidden, HttpError, notFound } from "../http.ts";
import { cifrarSecreto } from "../secretos.ts";
import { almacenActivo, almacenDe, AlmacenError, driverConfigurado } from "../storage/index.ts";
import { correoOut, hotelOut, logOut, sociedadOut } from "../mappers.ts";
import {
  cargarSmtp,
  CorreoError,
  enviarCorreo,
  limpiarNombre,
  type SmtpCfg,
} from "../services/correo.ts";
import { listPrealtas } from "./auth.ts";

export const adminRouter = Router();
adminRouter.use(requireAuth);

type R = Record<string, unknown>;

// ───────── catálogos ─────────
adminRouter.get("/catalogos", async (_req, res) => {
  const [soc, hot, ori, est] = await Promise.all([
    rows<R>("SELECT * FROM sociedades ORDER BY id"),
    // Cada hotel con los datos de contacto de su convenio vigente (activo, del año en curso; mismo criterio
    // que sp_sincronizar_catalogo_convenios) para la ficha del hotel al solicitar viáticos.
    rows<R>(
      `SELECT h.*, v.telefono AS conv_telefono, v.correo AS conv_correo, v.direccion AS conv_direccion
         FROM hoteles h
         LEFT JOIN (
           SELECT c.nombre_comercial, c.destino, c.telefono, c.correo, c.direccion,
                  ROW_NUMBER() OVER (PARTITION BY c.nombre_comercial, c.destino
                                     ORDER BY c.actualizado_at DESC, c.id DESC) AS rn
             FROM convenios c
            WHERE c.activo = 1 AND c.anio = YEAR(CURDATE())
         ) v ON v.rn = 1 AND v.nombre_comercial = h.nombre AND v.destino = h.ciudad
        ORDER BY h.id`,
    ),
    rows<R>("SELECT nombre FROM origenes ORDER BY id"),
    rows<R>("SELECT nombre FROM estados_mx ORDER BY nombre"),
  ]);
  res.json({
    sociedades: soc.map(sociedadOut),
    hoteles: hot.map(hotelOut),
    origenes: ori.map((o) => o.nombre),
    estados: est.map((e) => e.nombre),
  });
});

// ───────── configuración ─────────
export async function loadConfig(): Promise<Record<string, unknown>> {
  const list = await rows<{ clave: string; valor: unknown }>("SELECT clave, valor FROM configuracion");
  const cfg: Record<string, unknown> = {};
  for (const r of list) cfg[r.clave] = r.valor; // mysql2 ya entrega el JSON parseado
  return cfg;
}

/** Configuración para el navegador: la contraseña SMTP (cifrada en BD) nunca sale; solo si hay una guardada. */
async function configPublica(): Promise<Record<string, unknown>> {
  const cfg = await loadConfig();
  const guardada = typeof cfg.smtp_password === "string" && cfg.smtp_password !== "";
  delete cfg.smtp_password;
  cfg.smtp_password_configurada = guardada;
  return cfg;
}

adminRouter.get("/config", async (_req, res) => {
  res.json(await configPublica());
});

// Palabras prohibidas en facturas (alcohol, tabaco, higiene). Si la clave aún no existe en la BD se usan las de código.
const LISTAS_KEYS = {
  palabras_prohibidas_alcohol: "alcohol",
  palabras_prohibidas_tabaco: "tabaco",
  palabras_prohibidas_higiene: "higiene",
} as const;

export async function cargarListasProhibidas(): Promise<ListasProhibidas> {
  const cfg = await loadConfig();
  const lista = (k: keyof typeof LISTAS_KEYS, def: string[]) =>
    Array.isArray(cfg[k]) ? normalizarListaPalabras(cfg[k]) : def;
  return {
    alcohol: lista("palabras_prohibidas_alcohol", PALABRAS_DEFAULT.alcohol),
    tabaco: lista("palabras_prohibidas_tabaco", PALABRAS_DEFAULT.tabaco),
    higiene: lista("palabras_prohibidas_higiene", PALABRAS_DEFAULT.higiene),
  };
}

const CONFIG_KEYS = new Set([
  "monto_comida_diario", "umbral_finanzas", "dia_deposito", "email_compras",
  "dias_comprobacion_atrasada", "dias_autorizacion_pendiente", "dias_recordatorio_viaje",
  "notif_email_activo", "notif_email_destinatarios", "smtp_servidor", "smtp_puerto", "smtp_usuario",
  "smtp_password", "smtp_cifrado", "smtp_remitente", "notif_plataforma_activo", "revision_automatica_activo",
  "bloquear_folio_monto_hotel", ...Object.keys(LISTAS_KEYS),
]);

adminRouter.put("/config", requirePerm("configurar_montos"), async (req, res) => {
  const body = z.record(z.string(), z.unknown()).parse(req.body);
  const auth = me(req);
  const antes = await loadConfig();
  await tx(async (c) => {
    for (const [k, v] of Object.entries(body)) {
      if (!CONFIG_KEYS.has(k)) continue;
      if (k in LISTAS_KEYS && !Array.isArray(v)) throw bad("Las palabras prohibidas deben ser una lista de textos.");
      if (k === "smtp_password") {
        if (typeof v !== "string") throw bad("La contraseña SMTP debe ser texto.");
        if (v === "") continue; // vacío = conservar la guardada
      }
      const valor =
        k in LISTAS_KEYS
          ? normalizarListaPalabras(v)
          : k === "smtp_remitente"
            ? limpiarNombre(v)
            : k === "smtp_password"
              ? cifrarSecreto(v as string) // AES-256-GCM: nunca se guarda en claro
              : v;
      await exec(
        "INSERT INTO configuracion (clave, valor) VALUES (?, CAST(? AS JSON)) ON DUPLICATE KEY UPDATE valor = VALUES(valor)",
        [k, JSON.stringify(valor)],
        c,
      );
    }
    if (
      "bloquear_folio_monto_hotel" in body &&
      !!antes.bloquear_folio_monto_hotel !== !!body.bloquear_folio_monto_hotel
    ) {
      await c.query("CALL sp_registrar_log(?, ?, ?, ?, ?)", [
        "config_bloqueo_monto_hotel", "config", "bloquear_folio_monto_hotel", auth.user.id,
        JSON.stringify({ antes: !!antes.bloquear_folio_monto_hotel, despues: !!body.bloquear_folio_monto_hotel }),
      ]);
    }
  }, auth.user.id);
  res.json(await configPublica());
});

// Envía un correo de prueba con los valores del formulario (no hace falta guardar antes); si la contraseña
// viene vacía se usa la guardada. Por omisión va al correo del administrador en sesión.
adminRouter.post("/config/probar-correo", requirePerm("configurar_montos"), async (req, res) => {
  const b = z
    .object({
      para: z.string().trim().email("El correo de destino no es válido.").optional(),
      smtp_servidor: z.string().optional(),
      smtp_puerto: z.coerce.number().int().min(1).max(65535).optional(),
      smtp_usuario: z.string().optional(),
      smtp_password: z.string().optional(),
      smtp_cifrado: z.string().optional(),
      smtp_remitente: z.string().optional(),
    })
    .parse(req.body);
  let g: SmtpCfg;
  try {
    // Si la guardada ya no se puede descifrar pero el formulario trae una nueva, se prueba con la nueva.
    g = await cargarSmtp({ ignorarPassword: !!b.smtp_password });
  } catch (e) {
    if (e instanceof CorreoError) throw new HttpError(e.status, e.message);
    throw e;
  }
  const cfg: SmtpCfg = {
    servidor: (b.smtp_servidor ?? g.servidor).trim(),
    puerto: b.smtp_puerto ?? g.puerto,
    usuario: (b.smtp_usuario ?? g.usuario).trim(),
    password: b.smtp_password || g.password,
    cifrado: b.smtp_cifrado || g.cifrado,
    remitente: limpiarNombre(b.smtp_remitente ?? g.remitente),
  };
  const para = b.para ?? me(req).user.correo;
  try {
    const r = await enviarCorreo(
      {
        para,
        asunto: "Correo de prueba — Portal de Viáticos CKL",
        cuerpo:
          "Este es un correo de prueba del Portal de Viáticos CKL.\n\nSi lo recibes, la configuración SMTP funciona correctamente.",
      },
      cfg,
    );
    res.json({ ok: true, para, remitente: r.remitente });
  } catch (e) {
    if (e instanceof CorreoError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

// ───────── almacenamiento de archivos de comprobantes (BD / carpeta local / Google Drive) ─────────
const aHttp = (e: unknown) => (e instanceof AlmacenError ? new HttpError(e.status, e.message) : e);

adminRouter.get("/almacenamiento", requirePerm("configurar_montos"), async (_req, res) => {
  try {
    const driver = driverConfigurado();
    const almacen = driver === "db" ? null : almacenDe(driver);
    const [r] = await rows<{ en_bd: number; en_almacen: number }>(
      "SELECT SUM(ruta IS NULL) AS en_bd, SUM(ruta IS NOT NULL) AS en_almacen FROM facturas",
    );
    res.json({
      driver,
      destino: almacen?.destino ?? "Base de datos",
      archivos_en_bd: Number(r?.en_bd ?? 0),
      archivos_en_almacen: Number(r?.en_almacen ?? 0),
    });
  } catch (e) {
    throw aHttp(e);
  }
});

// Escribe, lee y elimina un archivo de prueba en el almacén externo configurado.
adminRouter.post("/almacenamiento/probar", requirePerm("configurar_montos"), async (_req, res) => {
  try {
    const almacen = almacenActivo();
    if (!almacen) {
      throw bad("El almacenamiento está en modo base de datos (STORAGE_DRIVER=db): no hay un almacén externo que probar.");
    }
    const r = await almacen.probar();
    res.json({ ok: true, driver: almacen.driver, detalle: r.detalle });
  } catch (e) {
    throw aHttp(e);
  }
});

// ───────── sociedades ─────────
const sociedadSchema = z.object({
  nombre: z.string().min(1),
  rfc: z.string().min(1),
  regimen: z.string().default(""),
  cp: z.string().default(""),
  UsoCFDI: z.string().default("G03"),
  sociedad_sap: z.string().default(""),
});

adminRouter.post("/sociedades", requirePerm("configurar_montos"), async (req, res) => {
  const s = sociedadSchema.parse(req.body);
  const r = await exec(
    "INSERT INTO sociedades (nombre, rfc, regimen, cp, uso_cfdi, sociedad_sap) VALUES (?, ?, ?, ?, ?, ?)",
    [s.nombre, s.rfc, s.regimen, s.cp, s.UsoCFDI, s.sociedad_sap],
  );
  res.status(201).json(sociedadOut((await one<R>("SELECT * FROM sociedades WHERE id = ?", [r.insertId]))!));
});

adminRouter.put("/sociedades/:id", requirePerm("configurar_montos"), async (req, res) => {
  const s = sociedadSchema.parse(req.body);
  const r = await exec(
    "UPDATE sociedades SET nombre = ?, rfc = ?, regimen = ?, cp = ?, uso_cfdi = ?, sociedad_sap = ? WHERE id = ?",
    [s.nombre, s.rfc, s.regimen, s.cp, s.UsoCFDI, s.sociedad_sap, req.params.id],
  );
  if (!r.affectedRows) throw notFound();
  res.json(sociedadOut((await one<R>("SELECT * FROM sociedades WHERE id = ?", [req.params.id]))!));
});

// ───────── roles y permisos ─────────
const parsePerm = (v: unknown): Record<string, boolean> => (typeof v === "string" ? JSON.parse(v) : (v as Record<string, boolean>));

adminRouter.get("/roles", async (_req, res) => {
  const list = await rows<R>("SELECT id, nombre, permisos FROM roles ORDER BY id");
  res.json(list.map((r) => ({ id: r.id, nombre: r.nombre, permisos: parsePerm(r.permisos) })));
});

adminRouter.post("/roles", requirePerm("configurar_montos"), async (req, res) => {
  const { nombre, copiarDe } = z
    .object({ nombre: z.string().min(1), copiarDe: z.number().int().optional() })
    .parse(req.body);
  const plantilla = copiarDe ? await one<R>("SELECT permisos FROM roles WHERE id = ?", [copiarDe]) : undefined;
  const permisos = plantilla ? parsePerm(plantilla.permisos) : {};
  if (await one("SELECT id FROM roles WHERE nombre = ?", [nombre])) throw bad("Ya existe un rol con ese nombre.");
  const r = await exec("INSERT INTO roles (nombre, permisos) VALUES (?, CAST(? AS JSON))", [nombre, JSON.stringify(permisos)]);
  res.status(201).json({ id: r.insertId, nombre, permisos });
});

adminRouter.delete("/roles/:id", requirePerm("configurar_montos"), async (req, res) => {
  const rol = await one<R>("SELECT nombre FROM roles WHERE id = ?", [req.params.id]);
  if (!rol) throw notFound();
  const enUso = await one<{ n: number }>("SELECT COUNT(*) n FROM usuarios WHERE rol_id = ?", [req.params.id]);
  if (enUso && enUso.n > 0) {
    throw new HttpError(409, `No se puede eliminar "${rol.nombre}": ${enUso.n} usuario(s) lo tienen asignado.`);
  }
  await exec("DELETE FROM roles WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

// Guardado de la matriz completa (como la pantalla de Permisos).
adminRouter.put("/roles/permisos", requirePerm("configurar_permisos"), async (req, res) => {
  const list = z
    .array(z.object({ id: z.number().int(), permisos: z.record(z.string(), z.boolean()) }))
    .parse(req.body);
  await tx(async (c) => {
    for (const r of list) {
      await exec("UPDATE roles SET permisos = CAST(? AS JSON) WHERE id = ?", [JSON.stringify(r.permisos), r.id], c);
    }
  }, me(req).user.id);
  res.json({ ok: true });
});

// ───────── usuarios ─────────
const COLS = "id, nombre, correo, rfc, rol_id, empresa, jefe_id, activo, initials, autorizado_viajar";

adminRouter.get("/usuarios", async (_req, res) => {
  const list = await rows<R>(`SELECT ${COLS} FROM usuarios ORDER BY nombre`);
  res.json(list.map(toAuthUser));
});

const userSchema = z.object({
  nombre: z.string().min(1, "Captura el nombre."),
  correo: z.string().min(1, "Captura el correo."),
  rfc: z.string().min(1, "Captura el RFC."),
  rol_id: z.number().int(),
  empresa: z.string().min(1),
  jefe_id: z.string().nullable().optional(),
  activo: z.boolean().default(true),
  // false = "No Autorizado para Viajar" (no puede crear solicitudes). Sin enviarlo, no cambia.
  autorizado_viajar: z.boolean().optional(),
  initials: z.string().default(""),
  password: z.string().optional(),
});

async function esAdminRol(rolId: number) {
  const r = await one<R>("SELECT nombre FROM roles WHERE id = ?", [rolId]);
  return r?.nombre === "administrador";
}

adminRouter.post("/usuarios", requirePerm("gestionar_usuarios"), async (req, res) => {
  const u = userSchema.parse(req.body);
  if (!u.password) throw bad("Captura la contraseña.");
  if ((await esAdminRol(u.rol_id)) && me(req).role.nombre !== "administrador") {
    throw forbidden("Solo un administrador puede asignar el rol de administrador.");
  }
  const id = newId("u_");
  await exec(
    `INSERT INTO usuarios (id, nombre, correo, password, rfc, rol_id, empresa, jefe_id, activo, autorizado_viajar, initials)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, u.nombre, u.correo, await hashPassword(u.password), u.rfc, u.rol_id, u.empresa, u.jefe_id ?? null, u.activo, u.autorizado_viajar ?? true, u.initials],
  );
  res.status(201).json(toAuthUser((await one<R>(`SELECT ${COLS} FROM usuarios WHERE id = ?`, [id]))!));
});

adminRouter.put("/usuarios/:id", requirePerm("gestionar_usuarios"), async (req, res) => {
  const u = userSchema.parse(req.body);
  const actual = await one<R>(`SELECT ${COLS} FROM usuarios WHERE id = ?`, [req.params.id]);
  if (!actual) throw notFound("El usuario no existe.");
  const soyAdmin = me(req).role.nombre === "administrador";
  if (!soyAdmin && ((await esAdminRol(Number(actual.rol_id))) || (await esAdminRol(u.rol_id)))) {
    throw forbidden("Solo un administrador puede modificar cuentas de administrador.");
  }
  const sets = ["nombre = ?", "correo = ?", "rfc = ?", "rol_id = ?", "empresa = ?", "jefe_id = ?", "activo = ?", "initials = ?"];
  const params: unknown[] = [u.nombre, u.correo, u.rfc, u.rol_id, u.empresa, u.jefe_id ?? null, u.activo, u.initials];
  if (u.autorizado_viajar !== undefined) {
    sets.push("autorizado_viajar = ?");
    params.push(u.autorizado_viajar);
  }
  if (u.password) {
    sets.push("password = ?");
    params.push(await hashPassword(u.password));
  }
  await exec(`UPDATE usuarios SET ${sets.join(", ")} WHERE id = ?`, [...params, req.params.id]);
  res.json(toAuthUser((await one<R>(`SELECT ${COLS} FROM usuarios WHERE id = ?`, [req.params.id]))!));
});

adminRouter.get("/prealtas", requirePerm("gestionar_usuarios"), async (_req, res) => {
  res.json(await listPrealtas());
});

// ───────── bitácora y correos simulados ─────────
adminRouter.get("/logs", requirePerm("configurar_montos", "ver_reportes", "gestionar_convenios"), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const entidad = typeof req.query.entidad === "string" ? req.query.entidad : null;
  const entidadId = typeof req.query.entidad_id === "string" ? req.query.entidad_id : null;
  const where: string[] = [];
  const params: unknown[] = [];
  if (entidad) { where.push("entidad = ?"); params.push(entidad); }
  if (entidadId) { where.push("entidad_id = ?"); params.push(entidadId); }
  const list = await rows<R>(
    `SELECT * FROM logs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY fecha DESC LIMIT ?`,
    [...params, limit],
  );
  res.json(list.map(logOut));
});

adminRouter.get("/correos", requirePerm("configurar_montos"), async (_req, res) => {
  const list = await rows<R>("SELECT * FROM correos ORDER BY fecha DESC LIMIT 200");
  res.json(list.map(correoOut));
});
