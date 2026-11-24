import { Router } from "express";
import multer from "multer";
import { z } from "zod";

import { conceptoRequierePar } from "../../src/lib/store.ts";
import { extraerUuidCfdi, validarContenidoFactura } from "../../src/lib/validar-factura.ts";
import { me, requireAuth, requirePerm } from "../auth.ts";
import { exec, newId, one, rows, tx } from "../db.ts";
import { bad, forbidden, HttpError, notFound } from "../http.ts";
import { comprobanteOut, facturaOut } from "../mappers.ts";
import { exigirAlcance } from "../services/solicitudes.ts";
import { almacenActivo, almacenDeRef, AlmacenError, mimePorNombre, type Almacen } from "../storage/index.ts";
import { cargarListasProhibidas } from "./admin.ts";
import { exigirNoCompensado } from "./compensaciones.ts";

export const comprobacionRouter = Router();
comprobacionRouter.use(requireAuth);

type R = Record<string, unknown>;

// RFC de TRANSPORTES DE PERSONAL Y MERCANCIA: receptor obligatorio de las facturas de Caseta (cualquier sociedad).
const RFC_CASETAS = "DCK150601XY1";

// Los errores del almacén (Drive/carpeta) llegan al usuario con su mensaje en español.
const aHttp = (e: unknown) => (e instanceof AlmacenError ? new HttpError(e.status, e.message) : e);

/** Manda a la papelera los archivos ya guardados (compensación o baja). Nunca lanza. */
async function quitarArchivos(refs: string[]) {
  await Promise.allSettled(
    refs.map(async (ref) => {
      try {
        await almacenDeRef(ref).eliminar(ref);
      } catch (e) {
        console.error("No se pudo mandar a la papelera el archivo", ref, e instanceof Error ? e.message : e);
      }
    }),
  );
}

/** Folio y concepto donde ya está cargado un XML con ese UUID (o null si no se ha cargado). */
async function xmlYaCargado(uuid: string) {
  return one<R>(
    `SELECT s.folio, cg.concepto
       FROM facturas f
       JOIN solicitudes s ON s.id = f.solicitud_id
       LEFT JOIN comprobantes_gasto cg ON cg.id = f.concepto_id
      WHERE f.tipo = 'XML' AND f.uuid = ?
      LIMIT 1`,
    [uuid],
  );
}

function mensajeDuplicado(uuid: string, previo: R) {
  const concepto = previo.concepto ? ` (concepto ${previo.concepto})` : "";
  return `Esta factura (UUID ${uuid}) ya fue cargada en el folio ${previo.folio}${concepto}. Una misma factura no se puede comprobar dos veces. No se guardó el comprobante.`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 2 },
});

// ───────── consulta ─────────
comprobacionRouter.get("/facturas", async (req, res) => {
  const solicitudId = typeof req.query.solicitud_id === "string" ? req.query.solicitud_id : "";
  if (!solicitudId) throw bad("Indica la solicitud.");
  await exigirAlcance(me(req), solicitudId);
  const list = await rows<R>(
    "SELECT * FROM facturas WHERE solicitud_id = ? ORDER BY created_at DESC, id",
    [solicitudId],
  );
  res.json(list.map(facturaOut));
});

// Archivo (XML/PDF/foto) para abrirlo desde el navegador: del almacén externo (facturas.ruta) o, si no hay
// ruta, del contenido guardado en la BD. Siempre pasa por la autorización de la solicitud.
comprobacionRouter.get("/facturas/:id/archivo", async (req, res) => {
  const f = await one<R>(
    `SELECT f.solicitud_id, f.archivo, f.ruta, a.mime, a.contenido
       FROM facturas f LEFT JOIN factura_archivos a ON a.factura_id = f.id WHERE f.id = ?`,
    [req.params.id],
  );
  if (!f) throw notFound("El archivo no existe.");
  await exigirAlcance(me(req), String(f.solicitud_id));
  let contenido: Buffer;
  let mime: string;
  if (f.ruta) {
    try {
      contenido = (await almacenDeRef(String(f.ruta)).leer(String(f.ruta))).buffer;
    } catch (e) {
      throw aHttp(e);
    }
    mime = mimePorNombre(String(f.archivo));
  } else if (f.contenido) {
    contenido = f.contenido as Buffer;
    mime = String(f.mime);
  } else {
    throw notFound("El archivo no existe.");
  }
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(String(f.archivo))}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(contenido);
});

// ───────── subir comprobante (par XML + PDF; Vales: un solo archivo) ─────────
comprobacionRouter.post(
  "/comprobacion/renglones/:id/facturas",
  requirePerm("comprobar"),
  upload.fields([{ name: "xml", maxCount: 1 }, { name: "pdf", maxCount: 1 }]),
  async (req, res) => {
    const auth = me(req);
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const xml = files.xml?.[0];
    const pdf = files.pdf?.[0];

    const reng = await one<R>("SELECT * FROM comprobantes_gasto WHERE id = ?", [req.params.id]);
    if (!reng) throw notFound("El renglón de comprobación no existe.");
    const sol = await exigirAlcance(auth, String(reng.solicitud_id));
    if (sol.estatus !== "Cerrado") throw new HttpError(409, "Solo se comprueban solicitudes autorizadas.");
    await exigirNoCompensado(String(reng.solicitud_id));
    if (auth.role.nombre === "gestor_vuelos" && reng.concepto !== "Avión") {
      throw forbidden("Solo puedes comprobar el concepto Avión.");
    }

    const esVales = !conceptoRequierePar(String(reng.concepto));
    if (esVales ? !pdf : !xml || !pdf) {
      throw bad(
        esVales
          ? "Sube una foto o un PDF de los vales."
          : "Para comprobar este concepto debes subir el XML y el PDF juntos.",
      );
    }

    for (const f of [xml, pdf]) {
      if (!f) continue;
      const nombre = Buffer.from(f.originalname, "latin1").toString("utf8");
      f.originalname = nombre;
      const dup = await one("SELECT 1 FROM facturas WHERE solicitud_id = ? AND archivo = ?", [reng.solicitud_id, nombre]);
      if (dup) throw bad(`El archivo "${nombre}" ya fue cargado para esta solicitud.`);
    }

    // UUID fiscal del timbre del SAT (solo comprobantes con XML; los Vales no tienen folio fiscal).
    let uuid = "";
    // Monto del comprobante: el Total del XML (obligatorio). Los Vales aún no piden el importe al usuario y
    // conservan el monto simulado del prototipo (200–999): PENDIENTE de definir cómo capturarlo.
    let total = Math.floor(Math.random() * 800) + 200;
    if (!esVales && xml) {
      const text = xml.buffer.toString("utf8");
      if (!text.includes("cfdi:Emisor") && !text.toLowerCase().includes("emisor")) {
        throw bad("El XML no es un CFDI válido (falta el Emisor). No se guardó el comprobante.");
      }
      const soc = await one<R>("SELECT rfc FROM sociedades WHERE nombre = ?", [sol.empresa]);
      const rfcMatch = text.match(/Receptor[^>]*Rfc=["']([^"']+)["']/i);
      // Las casetas siempre se facturan a TRANSPORTES DE PERSONAL Y MERCANCIA (DCK150601XY1), sea cual sea la
      // sociedad de la solicitud; el resto de los conceptos van a la sociedad de la solicitud.
      if (reng.concepto === "Caseta") {
        if (rfcMatch && String(rfcMatch[1]).toUpperCase() !== RFC_CASETAS) {
          throw bad(
            `Las casetas se facturan a TRANSPORTES DE PERSONAL Y MERCANCIA (${RFC_CASETAS}); el RFC del receptor del XML no coincide. No se guardó el comprobante.`,
          );
        }
      } else if (rfcMatch && soc && String(rfcMatch[1]).toUpperCase() !== String(soc.rfc).toUpperCase()) {
        throw bad(`El RFC del receptor del XML no coincide con la sociedad (${soc.rfc}). No se guardó el comprobante.`);
      }
      // Duplicidad: el mismo CFDI (mismo UUID del timbre) no se acepta dos veces en todo el portal, aunque se
      // renombre el archivo o se suba en otra solicitud. Un XML sin timbre no es una factura válida ante el SAT.
      const leidoUuid = extraerUuidCfdi(text);
      if (!leidoUuid) {
        throw bad("El XML no está timbrado ante el SAT (no trae el folio fiscal UUID). No se guardó el comprobante.");
      }
      uuid = leidoUuid;
      const previo = await xmlYaCargado(uuid);
      if (previo) throw new HttpError(409, mensajeDuplicado(uuid, previo));
      const v = validarContenidoFactura(text, await cargarListasProhibidas());
      if (!v.ok) throw bad(v.motivo);
      const t = text.match(/\sTotal=["']([0-9][0-9.,]*)["']/i);
      const leido = t ? parseFloat(t[1].replace(/,/g, "")) : NaN;
      // Antes se inventaba un monto si faltaba el Total; ahora se rechaza (todo CFDI válido lo trae).
      if (!(leido > 0)) throw bad("El XML no trae el Total de la factura. No se guardó el comprobante.");
      total = leido;
    }

    // Con almacenamiento externo (Drive/carpeta) los archivos se suben antes de la transacción y la BD solo guarda
    // la referencia. Si la transacción falla, lo subido se manda a la papelera; si el almacén falla, no se guarda nada.
    let almacen: Almacen | null;
    try {
      almacen = almacenActivo();
    } catch (e) {
      throw aHttp(e);
    }
    const refs = new Map<Express.Multer.File, string>();
    if (almacen) {
      try {
        for (const f of [xml, pdf]) {
          if (!f) continue;
          refs.set(
            f,
            await almacen.guardar({
              sociedad: String(sol.empresa),
              anio: String(sol.fecha).slice(0, 4),
              folio: String(sol.folio),
              nombre: f.originalname,
              mime: f.mimetype || mimePorNombre(f.originalname),
              buffer: f.buffer,
            }),
          );
        }
      } catch (e) {
        await quitarArchivos([...refs.values()]);
        throw aHttp(e);
      }
    }

    let excedente = 0;
    try {
    await tx(async (c) => {
      // Se bloquea el renglón para calcular el pendiente sin carreras.
      // (Si dos personas suben el mismo XML al mismo tiempo, el índice único uq_facturas_uuid_xml rechaza la segunda.)
      const r = await one<R>("SELECT monto_solicitado, monto_comprobado, validado FROM comprobantes_gasto WHERE id = ? FOR UPDATE", [req.params.id], c);
      const pendiente = Number(r!.monto_solicitado) - Number(r!.monto_comprobado);
      // Lo que exceda lo solicitado no suma al comprobado (tope = solicitado), pero la factura se guarda completa:
      // ese excedente se decide al "Compensar viaje" (reembolsar o no). Con el concepto ya cubierto, la factura
      // entra solo como gasto excedente (aplica 0). Los Vales no admiten excedente (aún no se captura su importe).
      if (pendiente <= 0 && (esVales || !(Number(r!.monto_solicitado) > 0))) {
        throw new HttpError(409, "Este concepto ya está comprobado por completo.");
      }
      const aplicado = Math.max(0, Math.min(total, pendiente));
      excedente = esVales ? 0 : Math.round((total - aplicado) * 100) / 100;
      // Una factura nueva en un concepto ya validado debe volver a revisarla Compras.
      if (Number(r!.validado)) {
        await exec(
          "UPDATE comprobantes_gasto SET validado = 0, validado_por = NULL, validado_fecha = NULL WHERE id = ?",
          [req.params.id],
          c,
        );
      }

      const parId = esVales ? null : newId("par_");
      const insertar = async (f: Express.Multer.File, tipo: string, montoAplicado: number) => {
        const id = newId("f_");
        await exec(
          `INSERT INTO facturas (id, solicitud_id, tipo, fecha, uuid, archivo, total, status, concepto_id, monto_aplicado, par_id, ruta)
           VALUES (?, ?, ?, CURDATE(), ?, ?, ?, 'Verificado', ?, ?, ?, ?)`,
          [id, reng.solicitud_id, tipo, uuid, f.originalname, total, reng.id, montoAplicado, parId, refs.get(f) ?? null],
          c,
        );
        // Solo en modo BD el contenido va en factura_archivos; con almacén externo no se duplica.
        if (!refs.has(f)) {
          await exec("INSERT INTO factura_archivos (factura_id, mime, contenido) VALUES (?, ?, ?)", [id, f.mimetype || "application/octet-stream", f.buffer], c);
        }
      };
      // El trigger trg_facturas_ai suma monto_aplicado al renglón y recalcula su status.
      if (!esVales && xml) await insertar(xml, "XML", aplicado);
      if (pdf) {
        const tipo = esVales && /\.(jpe?g|png)$/i.test(pdf.originalname) ? "FOTO" : "PDF";
        await insertar(pdf, tipo, esVales ? aplicado : 0);
      }
    }, auth.user.id);
    } catch (e) {
      await quitarArchivos([...refs.values()]);
      if (uuid && (e as { code?: string })?.code === "ER_DUP_ENTRY") {
        const previo = await xmlYaCargado(uuid);
        if (previo) throw new HttpError(409, mensajeDuplicado(uuid, previo));
      }
      throw e;
    }

    const r = await one<R>("SELECT * FROM comprobantes_gasto WHERE id = ?", [req.params.id]);
    res.status(201).json({ renglon: comprobanteOut(r!), uuid, total, excedente });
  },
);

// ───────── eliminar comprobante completo (par o archivo suelto); el trigger revierte el monto ─────────
comprobacionRouter.delete("/comprobacion/facturas/:key", requirePerm("comprobar"), async (req, res) => {
  const auth = me(req);
  const items = await rows<R>("SELECT id, solicitud_id, ruta FROM facturas WHERE par_id = ? OR id = ?", [req.params.key, req.params.key]);
  if (!items.length) throw notFound("El comprobante no existe.");
  await exigirAlcance(auth, String(items[0].solicitud_id));
  await exigirNoCompensado(String(items[0].solicitud_id));
  await tx((c) => exec("DELETE FROM facturas WHERE par_id = ? OR id = ?", [req.params.key, req.params.key], c), auth.user.id);
  // Ya sin la fila en BD: los archivos físicos van a la papelera (mejor esfuerzo; un fallo no rompe la baja).
  await quitarArchivos(items.map((i) => i.ruta).filter((r): r is string => typeof r === "string" && r !== ""));
  res.json({ ok: true, eliminados: items.length });
});

// ───────── validación de Compras Corporativas ─────────
comprobacionRouter.patch("/comprobacion/renglones/:id/validacion", requirePerm("validar_comprobacion"), async (req, res) => {
  const auth = me(req);
  const body = z.object({ validado: z.boolean().optional(), nota: z.string().optional() }).parse(req.body);
  const r = await one<R>("SELECT * FROM comprobantes_gasto WHERE id = ?", [req.params.id]);
  if (!r) throw notFound("El renglón no existe.");
  await exigirAlcance(auth, String(r.solicitud_id));
  await exigirNoCompensado(String(r.solicitud_id));

  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.validado === true) {
    if (!(Number(r.monto_solicitado) > 0) || r.status_renglon !== "comprobado") {
      throw new HttpError(409, "Solo se puede validar un renglón ya comprobado.");
    }
    sets.push("validado = 1", "validado_por = ?", "validado_fecha = CURDATE()");
    params.push(auth.user.id);
  } else if (body.validado === false) {
    sets.push("validado = 0", "validado_por = NULL", "validado_fecha = NULL");
  }
  if (body.nota !== undefined) {
    sets.push("nota_validacion = ?");
    params.push(body.nota.trim() || null);
  }
  if (sets.length) await exec(`UPDATE comprobantes_gasto SET ${sets.join(", ")} WHERE id = ?`, [...params, req.params.id]);
  res.json(comprobanteOut((await one<R>("SELECT * FROM comprobantes_gasto WHERE id = ?", [req.params.id]))!));
});
