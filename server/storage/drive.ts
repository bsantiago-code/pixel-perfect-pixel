// Almacén en Google Drive (API v3, cuenta de servicio). Los archivos son privados: la API los entrega a los
// usuarios autorizados (GET /api/facturas/:id/archivo); nunca se comparten con enlaces.
// El cliente `drive` se inyecta para poder probar el flujo sin credenciales reales.
import { Readable } from "node:stream";

import { auth, drive as crearDrive, type drive_v3 } from "@googleapis/drive";

import { carpetasDe, mimePorNombre, sanear } from "./ruta.ts";
import { AlmacenError, type Almacen, type ArchivoEntrada } from "./tipos.ts";

const PREFIJO = "drive:";
const CARPETA = "application/vnd.google-apps.folder";
const ALCANCE = "https://www.googleapis.com/auth/drive";
// Necesario para unidades compartidas (también funciona con "Mi unidad").
const COMPARTIDAS = { supportsAllDrives: true } as const;

export type DriveCliente = Pick<drive_v3.Drive, "files">;

const escaparQ = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Traduce errores de la API de Google a mensajes en español. */
function traducir(e: unknown, durante: string): AlmacenError {
  if (e instanceof AlmacenError) return e;
  const err = e as { code?: number | string; status?: number; message?: string };
  const codigo = Number(err.code ?? err.status);
  if (codigo === 401 || codigo === 403) {
    return new AlmacenError(
      `Google Drive rechazó el acceso al ${durante}. Revisa las credenciales y que la carpeta raíz esté compartida con la cuenta de servicio como Editor.`,
    );
  }
  if (codigo === 404) {
    return new AlmacenError(`Google Drive no encontró el recurso al ${durante}. Revisa GDRIVE_ROOT_FOLDER_ID.`, 404);
  }
  if (typeof err.code === "string" && ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(err.code)) {
    return new AlmacenError(`No se pudo conectar con Google Drive al ${durante}. Revisa la conexión a internet del servidor.`);
  }
  return new AlmacenError(`Google Drive devolvió un error al ${durante}: ${err.message ?? "error desconocido"}`);
}

export class AlmacenDrive implements Almacen {
  readonly driver = "drive" as const;
  readonly destino: string;
  private carpetas = new Map<string, Promise<string>>();

  constructor(
    private drive: DriveCliente,
    private raizId: string,
  ) {
    this.destino = `Google Drive (carpeta raíz ${raizId})`;
  }

  /** Busca o crea la subcarpeta `nombre` dentro de `padre`; los ids se cachean (también los intentos en curso). */
  private carpeta(padre: string, nombre: string): Promise<string> {
    const clave = `${padre}/${nombre}`;
    let p = this.carpetas.get(clave);
    if (!p) {
      p = (async () => {
        const q = `'${escaparQ(padre)}' in parents and name = '${escaparQ(nombre)}' and mimeType = '${CARPETA}' and trashed = false`;
        const lista = await this.drive.files.list({
          q, fields: "files(id)", pageSize: 1, corpora: "allDrives", includeItemsFromAllDrives: true, ...COMPARTIDAS,
        });
        const existente = lista.data.files?.[0]?.id;
        if (existente) return existente;
        const creada = await this.drive.files.create({
          requestBody: { name: nombre, mimeType: CARPETA, parents: [padre] }, fields: "id", ...COMPARTIDAS,
        });
        if (!creada.data.id) throw new AlmacenError("Google Drive no devolvió el id de la carpeta creada.");
        return creada.data.id;
      })();
      this.carpetas.set(clave, p);
      p.catch(() => this.carpetas.delete(clave)); // un fallo no se queda en el caché
    }
    return p;
  }

  private async ruta(nombres: string[]): Promise<string> {
    let id = this.raizId;
    for (const n of nombres) id = await this.carpeta(id, n);
    return id;
  }

  private fileId(ref: string): string {
    if (!ref.startsWith(PREFIJO)) throw new AlmacenError("La referencia del archivo no es de Google Drive.", 500);
    return ref.slice(PREFIJO.length);
  }

  async guardar(a: ArchivoEntrada): Promise<string> {
    try {
      const padre = await this.ruta(carpetasDe(a));
      const r = await this.drive.files.create({
        requestBody: { name: sanear(a.nombre), parents: [padre] },
        media: { mimeType: a.mime || mimePorNombre(a.nombre), body: Readable.from(a.buffer) },
        fields: "id",
        ...COMPARTIDAS,
      });
      if (!r.data.id) throw new AlmacenError("Google Drive no devolvió el id del archivo subido.");
      return PREFIJO + r.data.id;
    } catch (e) {
      throw traducir(e, "guardar el archivo");
    }
  }

  async leer(ref: string): Promise<{ buffer: Buffer }> {
    try {
      const r = await this.drive.files.get({ fileId: this.fileId(ref), alt: "media", ...COMPARTIDAS }, { responseType: "arraybuffer" });
      return { buffer: Buffer.from(r.data as unknown as ArrayBuffer) };
    } catch (e) {
      const err = traducir(e, "leer el archivo");
      if (err.status === 404) throw new AlmacenError("El archivo ya no está en Google Drive.", 404);
      throw err;
    }
  }

  async eliminar(ref: string): Promise<void> {
    try {
      await this.drive.files.update({ fileId: this.fileId(ref), requestBody: { trashed: true }, fields: "id", ...COMPARTIDAS });
    } catch (e) {
      const err = traducir(e, "mandar el archivo a la papelera");
      if (err.status === 404) return;
      throw err;
    }
  }

  async probar(): Promise<{ detalle: string }> {
    const contenido = Buffer.from(`Prueba de almacenamiento ${new Date().toISOString()}`);
    let ref = "";
    try {
      const padre = await this.carpeta(this.raizId, "_prueba");
      const r = await this.drive.files.create({
        requestBody: { name: `prueba-${Date.now()}.txt`, parents: [padre] },
        media: { mimeType: "text/plain", body: Readable.from(contenido) },
        fields: "id",
        ...COMPARTIDAS,
      });
      ref = PREFIJO + (r.data.id ?? "");
    } catch (e) {
      throw traducir(e, "escribir en la carpeta raíz");
    }
    try {
      const leido = await this.leer(ref);
      if (!leido.buffer.equals(contenido)) throw new AlmacenError("El archivo de prueba se leyó distinto de como se escribió.");
    } finally {
      await this.eliminar(ref).catch(() => undefined);
    }
    return { detalle: `Google Drive (carpeta raíz ${this.raizId}): escritura, lectura y papelera correctas.` };
  }
}

export type CredencialesDrive = { json: string; impersonar?: string };

/** Cliente real de Google Drive con una cuenta de servicio (JSON de credenciales). */
export function crearClienteDrive({ json, impersonar }: CredencialesDrive): DriveCliente {
  let cred: { client_email?: string; private_key?: string };
  try {
    cred = JSON.parse(json);
  } catch {
    throw new AlmacenError("Las credenciales de Google Drive no son un JSON válido.", 500);
  }
  if (!cred.client_email || !cred.private_key) {
    throw new AlmacenError("Las credenciales de Google Drive no son de una cuenta de servicio (faltan client_email o private_key).", 500);
  }
  // JWT sirve para la cuenta de servicio y, con `subject`, para la delegación de dominio.
  const cliente = new auth.JWT({ email: cred.client_email, key: cred.private_key, scopes: [ALCANCE], subject: impersonar || undefined });
  return crearDrive({ version: "v3", auth: cliente });
}
