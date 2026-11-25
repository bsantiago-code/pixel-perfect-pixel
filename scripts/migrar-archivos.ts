// Uso:  npm run storage:migrar -- [--dry-run] [--conservar] [--limite=N]
// Mueve al almacén externo configurado (STORAGE_DRIVER=local|drive) los archivos de comprobantes que todavía
// están en la base de datos (factura_archivos). Por cada archivo: lo sube, lo vuelve a leer para comprobar que
// es idéntico, guarda la referencia en facturas.ruta y borra el blob (salvo --conservar).
// Es idempotente: solo procesa las facturas sin ruta; se puede interrumpir y repetir.
import process from "node:process";

import { exec, getPool, one, rows } from "../server/db.ts";
import { almacenActivo, mimePorNombre } from "../server/storage/index.ts";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const conservar = args.includes("--conservar");
const limite = Number(args.find((a) => a.startsWith("--limite="))?.split("=")[1] ?? 0) || 0;

const almacen = almacenActivo();
if (!almacen) {
  console.error("STORAGE_DRIVER=db: no hay un almacén externo configurado. Define STORAGE_DRIVER=local|drive en .env.local.");
  process.exit(1);
}

const pendientes = await rows<{ id: string; archivo: string; folio: string; empresa: string; fecha: string }>(
  `SELECT f.id, f.archivo, s.folio, s.empresa, s.fecha
     FROM facturas f
     JOIN factura_archivos a ON a.factura_id = f.id
     JOIN solicitudes s ON s.folio = f.solicitud_id
    WHERE f.ruta IS NULL
    ORDER BY f.created_at, f.id ${limite ? `LIMIT ${limite}` : ""}`,
);

console.log(`${dry ? "[simulacro] " : ""}${pendientes.length} archivo(s) por mover a: ${almacen.destino}`);
let ok = 0;
let fallos = 0;
for (const p of pendientes) {
  const ruta = `${p.empresa}/${String(p.fecha).slice(0, 4)}/${String(p.folio).replace(/^#/, "")}/${p.archivo}`;
  if (dry) {
    console.log(`  · ${ruta}`);
    continue;
  }
  try {
    const blob = await one<{ mime: string; contenido: Buffer }>("SELECT mime, contenido FROM factura_archivos WHERE factura_id = ?", [p.id]);
    if (!blob) continue;
    const ref = await almacen.guardar({
      sociedad: p.empresa,
      anio: String(p.fecha).slice(0, 4),
      folio: String(p.folio),
      nombre: p.archivo,
      mime: blob.mime || mimePorNombre(p.archivo),
      buffer: blob.contenido,
    });
    const leido = await almacen.leer(ref);
    if (!leido.buffer.equals(blob.contenido)) {
      await almacen.eliminar(ref).catch(() => undefined);
      throw new Error("el archivo leído de vuelta no coincide con el original");
    }
    await exec("UPDATE facturas SET ruta = ? WHERE id = ? AND ruta IS NULL", [ref, p.id]);
    if (!conservar) await exec("DELETE FROM factura_archivos WHERE factura_id = ?", [p.id]);
    ok++;
    console.log(`  ✓ ${ruta}`);
  } catch (e) {
    fallos++;
    console.error(`  ✗ ${ruta}: ${e instanceof Error ? e.message : e}`);
  }
}

if (!dry) console.log(`\nListo: ${ok} movido(s), ${fallos} con error.${conservar ? " (blobs conservados en la BD)" : ""}`);
await getPool().end();
process.exit(fallos ? 1 : 0);
