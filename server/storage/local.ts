// Almacén en una carpeta del servidor. Sirve para una ruta de red, o para la carpeta que Google Drive para
// escritorio sincroniza (p. ej. G:\Mi unidad\Viaticos), y es el que permite probar sin credenciales de Google.
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { carpetasDe, sanear } from "./ruta.ts";
import { AlmacenError, type Almacen, type ArchivoEntrada } from "./tipos.ts";

const PREFIJO = "local:";

export class AlmacenLocal implements Almacen {
  readonly driver = "local" as const;
  readonly destino: string;
  private raiz: string;

  constructor(raiz: string) {
    this.raiz = resolve(raiz);
    this.destino = this.raiz;
  }

  /** Ruta absoluta dentro de la raíz; rechaza cualquier intento de salirse de ella. */
  private absoluta(relativa: string): string {
    const abs = resolve(this.raiz, ...relativa.split("/"));
    if (abs !== this.raiz && !abs.startsWith(this.raiz + sep)) {
      throw new AlmacenError("La ruta del archivo no es válida.", 400);
    }
    return abs;
  }

  private ref(ref: string): string {
    if (!ref.startsWith(PREFIJO)) throw new AlmacenError("La referencia del archivo no es de almacenamiento local.", 500);
    return ref.slice(PREFIJO.length);
  }

  private async escribir(relativa: string, buffer: Buffer): Promise<string> {
    let rel = relativa;
    for (let n = 1; ; n++) {
      const abs = this.absoluta(rel);
      await mkdir(dirname(abs), { recursive: true });
      try {
        await writeFile(abs, buffer, { flag: "wx" }); // nunca pisa un archivo existente
        return rel;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const punto = relativa.lastIndexOf(".");
        rel = punto > relativa.lastIndexOf("/") ? `${relativa.slice(0, punto)} (${n})${relativa.slice(punto)}` : `${relativa} (${n})`;
      }
    }
  }

  async guardar(a: ArchivoEntrada): Promise<string> {
    try {
      const rel = [...carpetasDe(a), sanear(a.nombre)].join("/");
      return PREFIJO + (await this.escribir(rel, a.buffer));
    } catch (e) {
      if (e instanceof AlmacenError) throw e;
      throw new AlmacenError(`No se pudo guardar el archivo en la carpeta de almacenamiento (${(e as Error).message}).`);
    }
  }

  async leer(ref: string): Promise<{ buffer: Buffer }> {
    try {
      return { buffer: await readFile(this.absoluta(this.ref(ref))) };
    } catch (e) {
      if (e instanceof AlmacenError) throw e;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new AlmacenError("El archivo ya no está en el almacenamiento.", 404);
      throw new AlmacenError(`No se pudo leer el archivo del almacenamiento (${(e as Error).message}).`);
    }
  }

  async eliminar(ref: string): Promise<void> {
    const rel = this.ref(ref);
    const origen = this.absoluta(rel);
    const sello = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const destino = this.absoluta(`_papelera/${sello}_${rel.replace(/\//g, "__")}`);
    try {
      await mkdir(dirname(destino), { recursive: true });
      await rename(origen, destino);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new AlmacenError(`No se pudo mover el archivo a la papelera (${(e as Error).message}).`);
    }
  }

  async probar(): Promise<{ detalle: string }> {
    const contenido = Buffer.from(`Prueba de almacenamiento ${new Date().toISOString()}`);
    const rel = `_prueba/prueba-${Date.now()}.txt`;
    try {
      await access(this.raiz, constants.W_OK).catch(async () => mkdir(this.raiz, { recursive: true }));
      await this.escribir(rel, contenido);
      const leido = await readFile(this.absoluta(rel));
      await unlink(this.absoluta(rel));
      if (!leido.equals(contenido)) throw new AlmacenError("El archivo de prueba se leyó distinto de como se escribió.");
    } catch (e) {
      if (e instanceof AlmacenError) throw e;
      throw new AlmacenError(`La carpeta de almacenamiento no es utilizable (${(e as Error).message}).`);
    }
    return { detalle: `Carpeta local ${this.raiz}: escritura, lectura y borrado correctos.` };
  }

  /** Para pruebas: ruta relativa a la raíz de un archivo guardado. */
  relativaDe(ref: string) {
    return relative(this.raiz, this.absoluta(this.ref(ref))).split(sep).join("/");
  }
}
