// Secretos que se guardan en la base de datos: nunca en texto plano.
//  · Contraseñas de usuarios y pre-altas → hash scrypt irreversible (server/auth.ts).
//  · Contraseña SMTP → cifrado AES-256-GCM (reversible: el servidor la necesita para autenticarse).
//  · Códigos de recuperación → HMAC-SHA256.
// La llave (APP_SECRET) vive en .env.local, fuera de la base: quien solo tenga un respaldo de la BD
// no puede descifrar nada.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";
import process from "node:process";

const PREFIJO = "enc:v1:";
const MIN_LONGITUD = 16;

let llave: Buffer | null = null;
let llaveDe = "";

export const hayLlave = () => (process.env.APP_SECRET ?? "").length >= MIN_LONGITUD;

function obtenerLlave(): Buffer {
  const secreto = process.env.APP_SECRET ?? "";
  if (secreto.length < MIN_LONGITUD) {
    throw new Error(`Falta APP_SECRET en .env.local (mínimo ${MIN_LONGITUD} caracteres). Ver .env.example.`);
  }
  if (!llave || llaveDe !== secreto) {
    llave = scryptSync(secreto, "ckl-portal-viaticos:v1", 32);
    llaveDe = secreto;
  }
  return llave;
}

export const esCifrado = (v: unknown): v is string => typeof v === "string" && v.startsWith(PREFIJO);

export function cifrarSecreto(plano: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", obtenerLlave(), iv);
  const datos = Buffer.concat([c.update(plano, "utf8"), c.final()]);
  return PREFIJO + [iv, c.getAuthTag(), datos].map((b) => b.toString("base64")).join(".");
}

/** Lanza si la llave no es la que cifró el valor o si el dato fue alterado. */
export function descifrarSecreto(valor: string): string {
  const [iv, tag, datos] = valor.slice(PREFIJO.length).split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", obtenerLlave(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(datos), d.final()]).toString("utf8");
}

/** Huella de un código de recuperación (se guarda en lugar del código). */
export function huellaCodigo(codigo: string): string {
  return createHmac("sha256", obtenerLlave()).update(codigo.trim()).digest("hex");
}
