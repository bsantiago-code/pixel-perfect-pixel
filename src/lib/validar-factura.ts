// Validación del contenido de un CFDI: rechaza facturas con alcohol, tabaco/vapeadores o higiene personal.
// Función PURA (sin APIs del navegador): la usa el servidor al subir un comprobante (server/routes/comprobacion.ts).
// Los umbrales, rangos SAT y contextos de exclusión viven aquí (gramática del evaluador); las palabras
// prohibidas son política del negocio y se administran en Configuración (tabla `configuracion`).
import { XMLParser } from "fast-xml-parser";

import { normalizar, type ListasProhibidas } from "./palabras-prohibidas.ts";

// ───────── constantes (las cambia Desarrollo) ─────────
/** Alcohol: IEPS por encima de snacks (8 %) y por debajo de tabaco (160 %). */
export const IEPS_ALCOHOL_MIN = 0.25;
export const IEPS_ALCOHOL_MAX = 1;
/** Tabaco: IEPS superior al 100 % (tasa vigente 160 %). */
export const IEPS_TABACO_MIN = 1;

export const SAT_ALCOHOL_RANGO: [number, number] = [50202000, 50202299]; // 50202300-399 = agua y refrescos
export const SAT_TABACO_RANGO: [number, number] = [50210000, 50211599];
export const SAT_HIGIENE_RANGO: [number, number] = [53131600, 53131699];

export const CONTEXTOS_NO_ALCOHOL = [
  "globo", "globos", "decoracion", "decorator", "manualidad", "listones", "porta globo", "porta-globo", "color", "colores",
];
export const CONTEXTOS_NO_TABACO = [
  "chocolate", "extracto", "cacao", "algodon", "jugo", "aceite", "miel", "cafe", "vainilla",
];
export const CONTEXTOS_NO_HIGIENE = [
  "papel higienico", "para manos", "p/manos", "p/ manos", "industrial", "institucional", "para pisos", "para bano",
];

// ───────── lectura del XML ─────────
export type ConceptoCfdi = { descripcion: string; claveProdServ: string; iepsTasas: number[] };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  processEntities: true,
  isArray: (name) => name === "Concepto" || name === "Traslado",
});

type Nodo = Record<string, unknown>;
const comoLista = (x: unknown): Nodo[] => (Array.isArray(x) ? (x as Nodo[]) : x && typeof x === "object" ? [x as Nodo] : []);

/** Conceptos del CFDI con su clave SAT y las tasas de IEPS (Impuesto 003, TipoFactor Tasa). Las cuotas se ignoran. */
export function extraerConceptos(xmlText: string): ConceptoCfdi[] {
  let doc: Nodo;
  try {
    doc = parser.parse(xmlText) as Nodo;
  } catch {
    return [];
  }
  const comprobante = (doc.Comprobante ?? {}) as Nodo;
  const conceptos = comoLista(((comprobante.Conceptos ?? {}) as Nodo).Concepto);
  return conceptos.map((c) => {
    const traslados = comoLista((((c.Impuestos ?? {}) as Nodo).Traslados as Nodo | undefined)?.Traslado);
    const iepsTasas = traslados
      .filter((t) => String(t["@_Impuesto"]) === "003" && String(t["@_TipoFactor"]).toLowerCase() === "tasa")
      .map((t) => Number(t["@_TasaOCuota"]))
      .filter((n) => Number.isFinite(n));
    return {
      descripcion: String(c["@_Descripcion"] ?? ""),
      claveProdServ: String(c["@_ClaveProdServ"] ?? ""),
      iepsTasas,
    };
  });
}

// Formato del UUID (folio fiscal) que asigna el SAT al timbrar: grupos 8-4-4-4-12. El SAT usa hexadecimal; se
// aceptan letras y números para no rechazar los XML de ejemplo de db/schema.sql (p. ej. "S191A7C1-…").
const FORMATO_UUID = /^[0-9A-Z]{8}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{12}$/;

/**
 * UUID (folio fiscal) del Timbre Fiscal Digital del CFDI, en mayúsculas, o null si el XML no está timbrado.
 * Es el identificador único de la factura ante el SAT: sirve para impedir que el mismo XML se compruebe dos veces,
 * aunque se renombre el archivo o se suba en otra solicitud.
 */
export function extraerUuidCfdi(xmlText: string): string | null {
  let doc: Nodo;
  try {
    doc = parser.parse(xmlText) as Nodo;
  } catch {
    return null;
  }
  const comprobante = (doc.Comprobante ?? {}) as Nodo;
  // Un CFDI puede traer varios nodos Complemento (timbre, pagos, etc.); el timbre puede estar en cualquiera.
  for (const complemento of comoLista(comprobante.Complemento)) {
    for (const timbre of comoLista(complemento.TimbreFiscalDigital)) {
      const uuid = String(timbre["@_UUID"] ?? "").trim().toUpperCase();
      if (FORMATO_UUID.test(uuid)) return uuid;
    }
  }
  return null;
}

// ───────── fecha de emisión ─────────
/** Zona horaria con la que se decide cuál es el "mes en curso" (no depende de la del servidor). */
export const ZONA_HORARIA_FACTURAS = "America/Mexico_City";

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** Año y mes (1-12) de la fecha de emisión del CFDI (atributo `Fecha` del Comprobante), o null si no viene. */
export function extraerFechaCfdi(xmlText: string): { anio: number; mes: number } | null {
  let doc: Nodo;
  try {
    doc = parser.parse(xmlText) as Nodo;
  } catch {
    return null;
  }
  const comprobante = (doc.Comprobante ?? {}) as Nodo;
  // Formato del SAT: AAAA-MM-DDThh:mm:ss (hora local del emisor, sin zona).
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(String(comprobante["@_Fecha"] ?? "").trim());
  if (!m) return null;
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  return mes >= 1 && mes <= 12 ? { anio, mes } : null;
}

/** Año y mes (1-12) de `hoy` en la hora de México. */
function mesActualMexico(hoy: Date): { anio: number; mes: number } {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_HORARIA_FACTURAS,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(hoy);
  const val = (t: string) => Number(partes.find((p) => p.type === t)?.value);
  return { anio: val("year"), mes: val("month") };
}

/**
 * Solo se aceptan facturas emitidas en el mes en curso o en el mes anterior (en noviembre: noviembre y octubre;
 * en enero: enero y diciembre del año pasado). Una fecha de un mes posterior tampoco se acepta.
 */
export function validarFechaFactura(xmlText: string, hoy: Date = new Date()): ResultadoFactura {
  const f = extraerFechaCfdi(xmlText);
  if (!f) {
    return { ok: false, motivo: "El XML no trae la fecha de emisión de la factura. No se guardó el comprobante." };
  }
  const actual = mesActualMexico(hoy);
  const indice = (x: { anio: number; mes: number }) => x.anio * 12 + (x.mes - 1);
  const diferencia = indice(actual) - indice(f);
  if (diferencia === 0 || diferencia === 1) return { ok: true };
  const anterior = actual.mes === 1 ? { anio: actual.anio - 1, mes: 12 } : { anio: actual.anio, mes: actual.mes - 1 };
  const nombre = (x: { anio: number; mes: number }) => `${MESES[x.mes - 1]} ${x.anio}`;
  return {
    ok: false,
    motivo: `La factura es de ${nombre(f)}. Solo se aceptan facturas del mes en curso (${nombre(actual)}) o del mes anterior (${nombre(anterior)}). No se guardó el comprobante.`,
  };
}

/** RFC de emisor y receptor y Total del CFDI (lo que pide la consulta de estado al SAT); null si no se puede leer. */
export function extraerDatosCfdi(
  xmlText: string,
): { rfcEmisor: string; rfcReceptor: string; total: number } | null {
  let doc: Nodo;
  try {
    doc = parser.parse(xmlText) as Nodo;
  } catch {
    return null;
  }
  const c = (doc.Comprobante ?? {}) as Nodo;
  const rfcEmisor = String(((c.Emisor ?? {}) as Nodo)["@_Rfc"] ?? "").trim().toUpperCase();
  const rfcReceptor = String(((c.Receptor ?? {}) as Nodo)["@_Rfc"] ?? "").trim().toUpperCase();
  const total = Number(String(c["@_Total"] ?? "").replace(/,/g, ""));
  if (!rfcEmisor || !rfcReceptor || !Number.isFinite(total)) return null;
  return { rfcEmisor, rfcReceptor, total };
}

// ───────── coincidencia de palabras ─────────
const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Palabra simple: con límite de palabra (ron no empata con camarón). Frase: por inclusión. */
function contienePalabra(textoNorm: string, palabra: string): boolean {
  const p = normalizar(palabra);
  if (!p) return false;
  if (/[^a-z0-9]/.test(p)) return textoNorm.includes(p);
  return new RegExp(`(?<![a-z0-9])${escapar(p)}(?![a-z0-9])`).test(textoNorm);
}

const enRango = (clave: string, [min, max]: [number, number]) => {
  const n = Number(clave);
  return Number.isFinite(n) && n >= min && n <= max;
};

const pct = (tasa: number) => String(Math.round(tasa * 10000) / 100);

// ───────── validación ─────────
export type ResultadoFactura = { ok: true } | { ok: false; motivo: string };

function motivoConcepto(c: ConceptoCfdi, listas: ListasProhibidas): string | null {
  const desc = normalizar(c.descripcion);

  // Alcohol
  const tasaAlcohol = c.iepsTasas.find((t) => t > IEPS_ALCOHOL_MIN && t < IEPS_ALCOHOL_MAX);
  if (tasaAlcohol !== undefined) return `bebidas alcohólicas (IEPS de ${pct(tasaAlcohol)} %)`;
  if (enRango(c.claveProdServ, SAT_ALCOHOL_RANGO) && c.iepsTasas.some((t) => t > 0)) {
    return `bebidas alcohólicas (clave SAT ${c.claveProdServ} con IEPS)`;
  }
  if (!CONTEXTOS_NO_ALCOHOL.some((x) => desc.includes(normalizar(x)))) {
    const p = listas.alcohol.find((w) => contienePalabra(desc, w));
    if (p) return `bebidas alcohólicas (contiene "${p}")`;
  }

  // Tabaco y vapeadores
  const tasaTabaco = c.iepsTasas.find((t) => t > IEPS_TABACO_MIN);
  if (tasaTabaco !== undefined) return `tabaco o vapeadores (IEPS de ${pct(tasaTabaco)} %)`;
  if (enRango(c.claveProdServ, SAT_TABACO_RANGO)) return `tabaco o vapeadores (clave SAT ${c.claveProdServ})`;
  if (!CONTEXTOS_NO_TABACO.some((x) => desc.includes(normalizar(x)))) {
    const p = listas.tabaco.find((w) => contienePalabra(desc, w));
    if (p) return `tabaco o vapeadores (contiene "${p}")`;
  }

  // Higiene personal (la limpieza institucional sí se permite)
  if (enRango(c.claveProdServ, SAT_HIGIENE_RANGO)) return `artículos de higiene personal (clave SAT ${c.claveProdServ})`;
  if (!CONTEXTOS_NO_HIGIENE.some((x) => desc.includes(normalizar(x)))) {
    const p = listas.higiene.find((w) => contienePalabra(desc, w));
    if (p) return `artículos de higiene personal (contiene "${p}")`;
  }
  return null;
}

/** Rechaza el XML en cuanto un concepto cae en alcohol, tabaco o higiene personal. Si no se puede leer, no opina. */
export function validarContenidoFactura(xmlText: string, listas: ListasProhibidas): ResultadoFactura {
  for (const c of extraerConceptos(xmlText)) {
    const motivo = motivoConcepto(c, listas);
    if (motivo) {
      return {
        ok: false,
        motivo: `La factura se rechazó: el concepto "${c.descripcion.trim()}" corresponde a ${motivo}, que no está permitido. No se guardó el comprobante.`,
      };
    }
  }
  return { ok: true };
}
