// Estructura de carpetas: <raíz>/<Sociedad>/<Año>/<Folio sin #>/<archivo>
import type { ArchivoEntrada } from "./tipos.ts";

/** Nombre seguro para carpeta/archivo: sin separadores ni caracteres reservados, sin "..", máx. 120 caracteres. */
export function sanear(nombre: string): string {
  const limpio = nombre
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120)
    .trim();
  return limpio === "" ? "_" : limpio;
}

/** Carpetas (sin el archivo): [sociedad, año, folio]. */
export function carpetasDe(a: Pick<ArchivoEntrada, "sociedad" | "anio" | "folio">): string[] {
  return [sanear(a.sociedad), sanear(String(a.anio)), sanear(a.folio.replace(/^#/, ""))];
}

const MIMES: Record<string, string> = {
  xml: "text/xml",
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

/** El tipo del archivo se deduce de su extensión (con almacenamiento externo no hay fila con el mime). */
export function mimePorNombre(nombre: string): string {
  return MIMES[nombre.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
