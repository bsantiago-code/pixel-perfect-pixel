// Selección y configuración del almacén de archivos de comprobantes.
//   STORAGE_DRIVER=db     (por omisión) el contenido va en la base de datos (factura_archivos).
//   STORAGE_DRIVER=local  carpeta del servidor: STORAGE_LOCAL_DIR.
//   STORAGE_DRIVER=drive  Google Drive: GDRIVE_CREDENTIALS_FILE | GDRIVE_CREDENTIALS_JSON, GDRIVE_ROOT_FOLDER_ID
//                         (opcional GDRIVE_IMPERSONATE). Ver docs/almacenamiento-google-drive.md.
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

import { AlmacenDrive, crearClienteDrive } from "./drive.ts";
import { AlmacenLocal } from "./local.ts";
import { AlmacenError, type Almacen } from "./tipos.ts";

export { AlmacenError, type Almacen } from "./tipos.ts";
export { mimePorNombre } from "./ruta.ts";

export type DriverNombre = "db" | "local" | "drive";

export function driverConfigurado(): DriverNombre {
  const d = (process.env.STORAGE_DRIVER ?? "db").trim().toLowerCase();
  if (d === "" || d === "db") return "db";
  if (d === "local" || d === "drive") return d;
  throw new AlmacenError(`STORAGE_DRIVER inválido ("${d}"). Usa db, local o drive.`, 500);
}

function credencialesDrive(): { json: string; impersonar?: string } {
  const archivo = process.env.GDRIVE_CREDENTIALS_FILE?.trim();
  const json = process.env.GDRIVE_CREDENTIALS_JSON?.trim();
  if (archivo) {
    if (!existsSync(archivo)) throw new AlmacenError(`No existe el archivo de credenciales GDRIVE_CREDENTIALS_FILE (${archivo}).`, 500);
    return { json: readFileSync(archivo, "utf8"), impersonar: process.env.GDRIVE_IMPERSONATE?.trim() || undefined };
  }
  if (json) return { json, impersonar: process.env.GDRIVE_IMPERSONATE?.trim() || undefined };
  throw new AlmacenError("Falta GDRIVE_CREDENTIALS_FILE (ruta al JSON de la cuenta de servicio) o GDRIVE_CREDENTIALS_JSON.", 500);
}

const instancias = new Map<string, Almacen>();

function construir(driver: "local" | "drive"): Almacen {
  if (driver === "local") {
    const dir = process.env.STORAGE_LOCAL_DIR?.trim();
    if (!dir) throw new AlmacenError("Falta STORAGE_LOCAL_DIR (carpeta raíz del almacenamiento local).", 500);
    return new AlmacenLocal(dir);
  }
  const raiz = process.env.GDRIVE_ROOT_FOLDER_ID?.trim();
  if (!raiz) throw new AlmacenError("Falta GDRIVE_ROOT_FOLDER_ID (ID de la carpeta raíz en Google Drive).", 500);
  return new AlmacenDrive(crearClienteDrive(credencialesDrive()), raiz);
}

/** Almacén de un driver concreto (se construye una sola vez). */
export function almacenDe(driver: "local" | "drive"): Almacen {
  const clave = driver + "|" + (driver === "local" ? process.env.STORAGE_LOCAL_DIR : process.env.GDRIVE_ROOT_FOLDER_ID);
  let a = instancias.get(clave);
  if (!a) {
    a = construir(driver);
    instancias.set(clave, a);
  }
  return a;
}

/** Almacén activo para nuevos archivos; `null` cuando el driver es `db`. */
export function almacenActivo(): Almacen | null {
  const d = driverConfigurado();
  return d === "db" ? null : almacenDe(d);
}

/** Almacén al que pertenece una referencia guardada en facturas.ruta (`local:…` / `drive:…`). */
export function almacenDeRef(ref: string): Almacen {
  if (ref.startsWith("local:")) return almacenDe("local");
  if (ref.startsWith("drive:")) return almacenDe("drive");
  throw new AlmacenError("La referencia del archivo tiene un formato desconocido.", 500);
}

/** Validación de arranque (sin red): falla con un mensaje claro si la configuración está incompleta. */
export function validarConfigAlmacen(): string {
  const d = driverConfigurado();
  if (d === "db") return "Almacenamiento de facturas: base de datos (STORAGE_DRIVER=db).";
  return `Almacenamiento de facturas: ${almacenDe(d).destino}.`;
}
