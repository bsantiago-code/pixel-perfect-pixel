// Desglose contable de un CFDI (3.3 / 4.0): conceptos con sus impuestos, totales y moneda. Es lo que se manda a
// SAP ("IVA directo del XML"). Función pura (sin navegador ni BD): la usan el servidor y las pruebas.
import { XMLParser } from "fast-xml-parser";

import type { ConceptoCfdi, DesgloseCfdi, ImpuestoCfdi } from "./desglose-tipos.ts";

export type { ConceptoCfdi, DesgloseCfdi, ImpuestoCfdi } from "./desglose-tipos.ts";
export { agruparImpuestos } from "./desglose-tipos.ts";

type Nodo = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  processEntities: true,
  isArray: (name) => name === "Concepto" || name === "Traslado" || name === "Retencion",
});

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const lista = (v: unknown): Nodo[] => (Array.isArray(v) ? (v as Nodo[]) : v ? [v as Nodo] : []);

function impuestos(contenedor: unknown, hijo: "Traslado" | "Retencion"): ImpuestoCfdi[] {
  return lista((contenedor as Nodo | undefined)?.[hijo]).map((t) => {
    const factor = String(t["@_TipoFactor"] ?? "Tasa");
    const exento = /^exento$/i.test(factor);
    return {
      impuesto: String(t["@_Impuesto"] ?? "").trim(),
      tipoFactor: exento ? "Exento" : /^cuota$/i.test(factor) ? "Cuota" : "Tasa",
      tasa: exento ? null : num(t["@_TasaOCuota"]),
      base: num(t["@_Base"]),
      importe: exento ? null : num(t["@_Importe"]),
    };
  });
}

/** Lee el desglose del CFDI; null si no es un comprobante legible o no trae Total. */
export function extraerDesgloseCfdi(xmlText: string): DesgloseCfdi | null {
  let doc: Nodo;
  try {
    doc = parser.parse(xmlText) as Nodo;
  } catch {
    return null;
  }
  const c = doc.Comprobante as Nodo | undefined;
  if (!c) return null;
  const total = num(c["@_Total"]);
  if (total === null) return null;

  const conceptos: ConceptoCfdi[] = lista(((c.Conceptos ?? {}) as Nodo).Concepto).map((k) => {
    const imp = (k.Impuestos ?? {}) as Nodo;
    const cantidad = num(k["@_Cantidad"]) ?? 1;
    return {
      claveProdServ: String(k["@_ClaveProdServ"] ?? "").trim(),
      descripcion: String(k["@_Descripcion"] ?? "").trim(),
      cantidad,
      // Todo CFDI válido trae Importe; si falta (XML incompleto) se calcula con el valor unitario.
      importe: num(k["@_Importe"]) ?? r2((num(k["@_ValorUnitario"]) ?? 0) * cantidad),
      descuento: num(k["@_Descuento"]) ?? 0,
      objetoImp: String(k["@_ObjetoImp"] ?? "").trim(),
      traslados: impuestos(imp.Traslados, "Traslado"),
      retenciones: impuestos(imp.Retenciones, "Retencion"),
    };
  });

  const impComp = (c.Impuestos ?? {}) as Nodo;
  const moneda = String(c["@_Moneda"] ?? "MXN").trim().toUpperCase() || "MXN";
  const fecha = String(c["@_Fecha"] ?? "").trim().slice(0, 10);
  const subtotal = num(c["@_SubTotal"]) ?? r2(conceptos.reduce((a, k) => a + k.importe, 0));
  return {
    version: String(c["@_Version"] ?? "").trim(),
    serie: String(c["@_Serie"] ?? "").trim(),
    folio: String(c["@_Folio"] ?? "").trim(),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : null,
    moneda,
    tipoCambio: num(c["@_TipoCambio"]),
    subtotal,
    descuento: num(c["@_Descuento"]) ?? 0,
    total,
    emisor: {
      rfc: String(((c.Emisor ?? {}) as Nodo)["@_Rfc"] ?? "").trim().toUpperCase(),
      nombre: String(((c.Emisor ?? {}) as Nodo)["@_Nombre"] ?? "").trim(),
    },
    receptor: { rfc: String(((c.Receptor ?? {}) as Nodo)["@_Rfc"] ?? "").trim().toUpperCase() },
    conceptos,
    trasladados: impuestos(impComp.Traslados, "Traslado"),
    retenidos: impuestos(impComp.Retenciones, "Retencion"),
  };
}
