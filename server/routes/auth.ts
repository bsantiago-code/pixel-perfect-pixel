import { randomInt } from "node:crypto";

import { Router } from "express";
import { z } from "zod";

import { evaluarContrasena, PASSWORD_MIN_LENGTH } from "../../src/lib/store.ts";
import {
  closeSession,
  findUserByIdentifier,
  hashPassword,
  loadRole,
  me,
  openSession,
  optionalAuth,
  requireAuth,
  toAuthUser,
  verifyPassword,
} from "../auth.ts";
import { exec, newId, one, rows, tx } from "../db.ts";
import { bad, HttpError } from "../http.ts";
import { huellaCodigo } from "../secretos.ts";
import { despacharCorreos, encolarCorreos } from "../services/correo.ts";

export const authRouter = Router();

const RESET_TTL_MIN = 10;

authRouter.post("/auth/login", async (req, res) => {
  const { identifier, password } = z
    .object({ identifier: z.string().min(1), password: z.string().min(1) })
    .parse(req.body);
  const u = await findUserByIdentifier(identifier);
  const stored = u ? String(u.password) : "";
  if (!u || !u.activo || !(await verifyPassword(stored, password))) {
    throw new HttpError(401, "Usuario o contraseña incorrectos.", "BAD_CREDENTIALS");
  }
  await openSession(res, String(u.id));
  const user = toAuthUser(u);
  res.json({ user, role: await loadRole(user.rol_id) });
});

authRouter.post("/auth/logout", async (req, res) => {
  await closeSession(req, res);
  res.json({ ok: true });
});

// Sin sesión responde 200 con user: null (así la página de login no genera errores 401 en consola).
authRouter.get("/auth/me", optionalAuth, (req, res) => {
  if (!req.auth) return void res.json({ user: null, role: null });
  res.json({ user: req.auth.user, role: req.auth.role });
});

authRouter.post("/auth/cambiar-contrasena", requireAuth, async (req, res) => {
  const { actual, nueva } = z.object({ actual: z.string().min(1), nueva: z.string().min(1) }).parse(req.body);
  const { user } = me(req);
  const row = await one<{ password: string }>("SELECT password FROM usuarios WHERE id = ?", [user.id]);
  if (!row || !(await verifyPassword(row.password, actual))) {
    throw new HttpError(400, "La contraseña actual no es correcta.", "ACTUAL_INCORRECTA");
  }
  const reglas = evaluarContrasena(nueva, user);
  if (!reglas.longitud) throw bad(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  if (!reglas.noComun) throw bad("La contraseña es demasiado común o fácil de adivinar.");
  if (nueva === actual) throw bad("La nueva contraseña debe ser distinta de la actual.");
  await exec("UPDATE usuarios SET password = ? WHERE id = ?", [await hashPassword(nueva), user.id]);
  res.json({ ok: true });
});

// Sin servidor de correo: el código se devuelve en la respuesta ("correo simulado").
authRouter.post("/auth/reset/solicitar", async (req, res) => {
  const { identifier } = z.object({ identifier: z.string().min(1) }).parse(req.body);
  const u = await findUserByIdentifier(identifier);
  if (!u || !u.activo) throw new HttpError(404, "No encontramos una cuenta activa con ese RFC/usuario.");
  const code = String(randomInt(100000, 1000000));
  // Se guarda solo la huella del código; el código en claro únicamente viaja en esta respuesta ("correo simulado").
  await exec("INSERT INTO reset_codes (id, user_id, code) VALUES (?, ?, ?)", [newId("rc_"), u.id, huellaCodigo(code)]);
  res.json({ code, correo: u.correo });
});

authRouter.post("/auth/reset/confirmar", async (req, res) => {
  const { identifier, code, nueva } = z
    .object({ identifier: z.string().min(1), code: z.string().min(1), nueva: z.string().min(1) })
    .parse(req.body);
  if (nueva.length < PASSWORD_MIN_LENGTH) throw bad(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  const u = await findUserByIdentifier(identifier);
  const match = u
    ? await one<{ id: string }>(
        `SELECT id FROM reset_codes
          WHERE user_id = ? AND code = ? AND used = 0
            AND created_at >= DATE_SUB(NOW(3), INTERVAL ${RESET_TTL_MIN} MINUTE)
          ORDER BY created_at DESC LIMIT 1`,
        [u.id, huellaCodigo(code)],
      )
    : undefined;
  if (!u || !match) throw bad("Código inválido o expirado.");
  await exec("UPDATE reset_codes SET used = 1 WHERE id = ?", [match.id]);
  await exec("UPDATE usuarios SET password = ? WHERE id = ?", [await hashPassword(nueva), u.id]);
  res.json({ ok: true });
});

// ───────── Pre-registro: crea la cuenta con acceso al portal, "No Autorizado para Viajar" ─────────
// Aunque puede iniciar sesión, la cuenta no puede crear solicitudes hasta que su jefe inmediato la habilite
// (ver server/routes/preregistros.ts). Finanzas recibe un correo con el alta y asigna al jefe.
const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/;
const preregistroSchema = z.object({
  nombre: z.string().trim().min(1, "Captura tu nombre.").max(120),
  correo: z.string().trim().email("El correo no es válido.").max(150),
  rfc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(RFC_RE, "El RFC no tiene un formato válido (12 o 13 caracteres, sin espacios)."),
  banco: z.string().trim().max(80).optional().default(""),
  cuenta: z.string().trim().max(30).optional().default(""),
  clabe: z
    .string()
    .trim()
    .regex(/^(\d{18})?$/, "La CLABE debe tener 18 dígitos.")
    .optional()
    .default(""),
  sociedad: z.string().trim().min(1, "Selecciona tu sociedad."),
  password: z.string().min(1, "Captura una contraseña."),
});

// Freno básico contra abuso: cada cuenta creada genera un correo a Finanzas. Solo cuentan los pre-registros que
// realmente se crearon (equivocarse en el formulario no gasta el cupo). Nota: detrás del proxy de Vite/Nitro todas
// las peticiones llegan desde la misma IP, por lo que el tope es por servidor; se ajusta con PREREGISTRO_MAX_POR_HORA.
const MAX_PREREGISTROS_POR_HORA = Number(process.env.PREREGISTRO_MAX_POR_HORA || 20);
const creadosPorIp = new Map<string, number[]>();
const recientesDe = (ip: string) => (creadosPorIp.get(ip) ?? []).filter((t) => Date.now() - t < 3_600_000);
function limitarPreregistros(ip: string) {
  if (recientesDe(ip).length >= MAX_PREREGISTROS_POR_HORA) {
    throw new HttpError(429, "Se enviaron demasiados pre-registros desde esta red. Intenta de nuevo más tarde.");
  }
}
function contarPreregistro(ip: string) {
  creadosPorIp.set(ip, [...recientesDe(ip), Date.now()]);
}

const enmascarar = (v: string) => (v ? "****" + v.slice(-4) : "—");
const inicialesDe = (nombre: string) =>
  nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

// Sociedades para el formulario de Pre-Registro (público: quien se registra aún no tiene sesión). Solo nombres.
authRouter.get("/prealtas/sociedades", async (_req, res) => {
  res.json(await rows<{ nombre: string }>("SELECT nombre FROM sociedades ORDER BY id"));
});

authRouter.post("/prealtas", async (req, res) => {
  limitarPreregistros(req.ip ?? "desconocida");
  const f = preregistroSchema.parse(req.body);
  const reglas = evaluarContrasena(f.password, { correo: f.correo, nombre: f.nombre });
  if (!reglas.longitud) throw bad(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  if (!reglas.noComun) throw bad("La contraseña es demasiado común o fácil de adivinar.");

  const sociedad = await one<{ nombre: string }>("SELECT nombre FROM sociedades WHERE nombre = ?", [f.sociedad]);
  if (!sociedad) throw bad("La sociedad seleccionada no existe.");
  const rol = await one<{ id: number }>("SELECT id FROM roles WHERE nombre = 'usuario'");
  if (!rol) throw new HttpError(500, "No existe el rol de usuario; contacta al administrador.");
  const duplicado = await one(
    "SELECT 1 FROM usuarios WHERE LOWER(correo) = LOWER(?) OR LOWER(rfc) = LOWER(?) LIMIT 1",
    [f.correo, f.rfc],
  );
  if (duplicado) {
    throw new HttpError(409, "Ya existe una cuenta con ese correo o RFC. Inicia sesión o recupera tu contraseña.");
  }

  const usuarioId = newId("u_");
  const prealtaId = newId("pa_");
  const hash = await hashPassword(f.password);
  const pendientes = await tx(async (c) => {
    await exec(
      `INSERT INTO usuarios (id, nombre, correo, password, rfc, rol_id, empresa, jefe_id, activo, autorizado_viajar, initials)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, 0, ?)`,
      [usuarioId, f.nombre, f.correo, hash, f.rfc, rol.id, sociedad.nombre, inicialesDe(f.nombre)],
      c,
    );
    await exec(
      `INSERT INTO prealtas (id, nombre, correo, rfc, banco, cuenta, clabe, sociedad, password, status, usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acceso_otorgado', ?)`,
      [prealtaId, f.nombre, f.correo, f.rfc, f.banco, f.cuenta, f.clabe, sociedad.nombre, hash, usuarioId],
      c,
    );
    const finanzas = await rows<{ id: string; correo: string }>(
      `SELECT u.id, u.correo FROM usuarios u JOIN roles r ON r.id = u.rol_id
        WHERE u.activo = 1 AND u.id <> ?
          AND JSON_UNQUOTE(JSON_EXTRACT(r.permisos, '$.gestionar_preregistros')) = 'true'`,
      [usuarioId],
      c,
    );
    await c.query("CALL sp_registrar_log(?, ?, ?, ?, ?)", [
      "preregistro_creado", "usuario", usuarioId, usuarioId,
      JSON.stringify({ nombre: f.nombre, correo: f.correo, sociedad: sociedad.nombre, avisados: finanzas.map((d) => d.correo) }),
    ]);
    return encolarCorreos(c, {
      destinatarios: finanzas,
      asunto: `Nuevo Pre-Registro — ${f.nombre}`,
      referencia: prealtaId,
      cuerpo: [
        "Se registró una nueva cuenta en el Portal de Viáticos CKL.",
        "",
        `Nombre: ${f.nombre}`,
        `Correo: ${f.correo}`,
        `RFC: ${f.rfc}`,
        `Sociedad: ${sociedad.nombre}`,
        `Banco: ${f.banco || "—"}`,
        `Cuenta: ${enmascarar(f.cuenta)}`,
        `CLABE: ${enmascarar(f.clabe)}`,
        "",
        'La cuenta ya puede entrar al portal, pero está "No Autorizado para Viajar" y no podrá crear solicitudes.',
        "Entra a Pre-Registros para asignarle su jefe inmediato; el jefe será quien la habilite para viajar.",
        "Los datos bancarios completos están en esa misma pantalla.",
      ].join("\n"),
    });
  }, usuarioId);
  contarPreregistro(req.ip ?? "desconocida");
  despacharCorreos(pendientes); // después del commit: un fallo de SMTP no impide el registro
  res.status(201).json({ ok: true });
});

export async function listPrealtas() {
  return rows(
    "SELECT id, nombre, correo, rfc, banco, cuenta, clabe, sociedad, status, created_at FROM prealtas ORDER BY created_at DESC",
  );
}
