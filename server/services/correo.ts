// Envío real de correos por SMTP (Configuración → Parámetros SMTP).
// Los correos de monto manual de hotel se registran en `correos` con estado `pendiente` y se despachan
// después de guardar la solicitud, fuera de la transacción: un fallo del SMTP nunca rompe el flujo.
import nodemailer from "nodemailer";

import { exec, newId, one, rows, type Db } from "../db.ts";
import { descifrarSecreto, esCifrado } from "../secretos.ts";

export type SmtpCfg = {
  servidor: string;
  puerto: number;
  usuario: string;
  password: string;
  cifrado: string; // "SSL" (conexión directa) | "TLS" (STARTTLS)
  remitente: string; // nombre visible, opcional
};

export class CorreoError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Nombre visible del remitente: una sola línea (evita inyectar cabeceras) y máx. 100 caracteres. */
export function limpiarNombre(v: unknown): string {
  return str(v).replace(/\s+/g, " ").replace(/["<>]/g, "").trim().slice(0, 100);
}

/** La contraseña SMTP se guarda cifrada (AES-256-GCM); aquí se descifra solo para autenticarse. */
function leerPassword(valor: unknown): string {
  const v = str(valor);
  if (!esCifrado(v)) return v;
  try {
    return descifrarSecreto(v);
  } catch {
    throw new CorreoError(
      "No se pudo descifrar la contraseña SMTP guardada (cambió APP_SECRET). Captura la contraseña SMTP de nuevo en Configuración.",
      409,
    );
  }
}

export async function cargarSmtp(opciones: { ignorarPassword?: boolean } = {}): Promise<SmtpCfg> {
  const list = await rows<{ clave: string; valor: unknown }>(
    `SELECT clave, valor FROM configuracion
      WHERE clave IN ('smtp_servidor','smtp_puerto','smtp_usuario','smtp_password','smtp_cifrado','smtp_remitente')`,
  );
  const m: Record<string, unknown> = Object.fromEntries(list.map((r) => [r.clave, r.valor]));
  return {
    servidor: str(m.smtp_servidor).trim(),
    puerto: Number(m.smtp_puerto) || 587,
    usuario: str(m.smtp_usuario).trim(),
    password: opciones.ignorarPassword ? "" : leerPassword(m.smtp_password),
    cifrado: str(m.smtp_cifrado) || "TLS",
    remitente: limpiarNombre(m.smtp_remitente),
  };
}

/** "Nombre" <correo> si hay nombre; solo el correo si no. */
export function armarRemitente(cfg: SmtpCfg): { name: string; address: string } | string {
  if (!cfg.usuario.includes("@")) {
    throw new CorreoError("El usuario SMTP debe ser un correo electrónico para usarlo como remitente.", 400);
  }
  return cfg.remitente ? { name: cfg.remitente, address: cfg.usuario } : cfg.usuario;
}

const textoRemitente = (cfg: SmtpCfg) => (cfg.remitente ? `${cfg.remitente} <${cfg.usuario}>` : cfg.usuario);

function crearTransporte(cfg: SmtpCfg) {
  return nodemailer.createTransport({
    host: cfg.servidor,
    port: cfg.puerto,
    secure: cfg.cifrado === "SSL",
    requireTLS: cfg.cifrado === "TLS",
    auth: cfg.usuario ? { user: cfg.usuario, pass: cfg.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

function traducirError(e: unknown, cfg: SmtpCfg): string {
  const err = e as { code?: string; message?: string };
  switch (err.code) {
    case "EAUTH":
      return "El servidor SMTP rechazó el usuario o la contraseña.";
    case "ECONNREFUSED":
    case "ENOTFOUND":
    case "ETIMEDOUT":
    case "ECONNECTION":
    case "ESOCKET":
    case "EDNS":
      return `No se pudo conectar con el servidor SMTP (${cfg.servidor}:${cfg.puerto}). Revisa el servidor, el puerto y el cifrado.`;
    case "EENVELOPE":
      return "La dirección del destinatario no es válida.";
    default:
      return `No se pudo enviar el correo: ${err.message ?? "error desconocido"}`;
  }
}

/** Envía un correo con la configuración dada. Lanza CorreoError con un mensaje en español. */
export async function enviarCorreo(
  msg: { para: string; asunto: string; cuerpo: string },
  cfg: SmtpCfg,
): Promise<{ remitente: string }> {
  if (!cfg.servidor) throw new CorreoError("Captura el servidor SMTP antes de enviar.", 400);
  const from = armarRemitente(cfg);
  const transporte = crearTransporte(cfg);
  try {
    await transporte.sendMail({ from, to: msg.para, subject: msg.asunto, text: msg.cuerpo });
  } catch (e) {
    throw new CorreoError(traducirError(e, cfg));
  } finally {
    transporte.close();
  }
  return { remitente: textoRemitente(cfg) };
}

/**
 * Estado con el que se registra un correo nuevo según la configuración actual:
 *  omitido = correos desactivados · simulado = no hay servidor SMTP · pendiente = se enviará al terminar la transacción.
 */
export async function estadoCorreoActual(db: Db): Promise<"omitido" | "simulado" | "pendiente"> {
  const cfg = await rows<{ clave: string; valor: unknown }>(
    "SELECT clave, valor FROM configuracion WHERE clave IN ('notif_email_activo', 'smtp_servidor')",
    [],
    db,
  );
  const valor = (k: string) => cfg.find((r) => r.clave === k)?.valor;
  const activo = valor("notif_email_activo") === undefined || String(valor("notif_email_activo")) !== "false";
  const hayServidor = typeof valor("smtp_servidor") === "string" && String(valor("smtp_servidor")).trim() !== "";
  return !activo ? "omitido" : hayServidor ? "pendiente" : "simulado";
}

/**
 * Registra en `correos` un mismo mensaje para varios destinatarios (dentro de la transacción `db`) y devuelve los ids
 * `pendiente`: pásalos a despacharCorreos() DESPUÉS de confirmar la transacción.
 */
export async function encolarCorreos(
  db: Db,
  m: { destinatarios: { id: string; correo: string }[]; asunto: string; cuerpo: string; referencia: string },
): Promise<string[]> {
  const estado = await estadoCorreoActual(db);
  const pendientes: string[] = [];
  for (const d of m.destinatarios) {
    const id = newId("mail_");
    await exec(
      `INSERT INTO correos (id, fecha, para, usuario_id, asunto, cuerpo, referencia, estado)
       VALUES (?, NOW(3), ?, ?, ?, ?, ?, ?)`,
      [id, d.correo, d.id, m.asunto, m.cuerpo, m.referencia, estado],
      db,
    );
    if (estado === "pendiente") pendientes.push(id);
  }
  return pendientes;
}

/** Despacha en segundo plano los correos `pendiente`; deja `enviado` o `error` (con el motivo) en cada fila. */
export function despacharCorreos(ids: string[]): void {
  if (!ids.length) return;
  void (async () => {
    let cfg: SmtpCfg;
    try {
      cfg = await cargarSmtp();
    } catch (e) {
      const motivo = (e instanceof Error ? e.message : "No se pudo leer la configuración SMTP.").slice(0, 500);
      await exec("UPDATE correos SET estado = 'error', detalle_error = ? WHERE id IN (?) AND estado = 'pendiente'", [motivo, ids]);
      return;
    }
    for (const id of ids) {
      const m = await one<{ para: string; asunto: string; cuerpo: string }>(
        "SELECT para, asunto, cuerpo FROM correos WHERE id = ? AND estado = 'pendiente'",
        [id],
      );
      if (!m) continue;
      try {
        const r = await enviarCorreo(m, cfg);
        await exec("UPDATE correos SET estado = 'enviado', remitente = ?, detalle_error = NULL WHERE id = ?", [r.remitente, id]);
      } catch (e) {
        const motivo = e instanceof Error ? e.message : "Error desconocido al enviar.";
        await exec("UPDATE correos SET estado = 'error', detalle_error = ? WHERE id = ?", [motivo.slice(0, 500), id]);
      }
    }
  })().catch((e) => console.error("Error al despachar correos:", e));
}
