// Carga masiva de convenios desde Excel (pestaña "Hoteles" de la hoja de convenios de Compras).
// Funciones puras: las usa la pantalla de Convenios (vista previa) y el servidor (validación final).
import { ESTADOS_MX } from "./store.ts";

/** Campos del convenio que se pueden cargar (mismo nombre que en la tabla `convenios`). */
export type CampoImportable =
  | "tipo_sucursal"
  | "no_sucursal"
  | "destino"
  | "estado"
  | "nombre_comercial"
  | "anio"
  | "costo_sencilla"
  | "costo_doble"
  | "no_proveedor"
  | "razon_social"
  | "telefono"
  | "contacto"
  | "banco"
  | "correo"
  | "direccion"
  | "notas";

/** Encabezados de la plantilla, en el orden de la hoja de Compras (+ Estado, Correo, Dirección y Notas). */
export const PLANTILLA_CONVENIOS: { campo: CampoImportable; encabezado: string }[] = [
  { campo: "tipo_sucursal", encabezado: "Tipo de Sucursal" },
  { campo: "no_sucursal", encabezado: "No. de Sucursal" },
  { campo: "destino", encabezado: "Destino" },
  { campo: "estado", encabezado: "Estado" },
  { campo: "nombre_comercial", encabezado: "Nombre Comercial" },
  { campo: "anio", encabezado: "Año" },
  { campo: "costo_sencilla", encabezado: "Costo Hab. Sencilla" },
  { campo: "costo_doble", encabezado: "Costo Hab. Doble" },
  { campo: "no_proveedor", encabezado: "No. de Proveedor" },
  { campo: "razon_social", encabezado: "Razon Social" },
  { campo: "telefono", encabezado: "Telefono" },
  { campo: "contacto", encabezado: "Contacto" },
  { campo: "banco", encabezado: "Banco" },
  { campo: "correo", encabezado: "Correo" },
  { campo: "direccion", encabezado: "Direccion" },
  { campo: "notas", encabezado: "Notas" },
];

/** Columnas sin las que no se puede cargar el archivo. */
export const COLUMNAS_OBLIGATORIAS: CampoImportable[] = [
  "destino",
  "estado",
  "nombre_comercial",
  "anio",
  "costo_sencilla",
];

export const MAX_FILAS_IMPORTACION = 1000;

/** Minúsculas, sin acentos ni signos, espacios simples. */
export function normalizarTexto(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Campo al que corresponde un encabezado del Excel (o null si no se usa, p. ej. la columna "Su"). */
export function campoDeEncabezado(encabezado: unknown): CampoImportable | null {
  const h = normalizarTexto(encabezado);
  if (!h) return null;
  const tiene = (s: string) => h.includes(s);
  if (tiene("tipo") && tiene("sucursal")) return "tipo_sucursal";
  if (tiene("sucursal")) return "no_sucursal";
  if (h === "destino" || h.startsWith("destino ")) return "destino";
  if (h === "estado" || h.startsWith("estado ")) return "estado";
  if (tiene("nombre comercial")) return "nombre_comercial";
  if (h === "ano" || h === "anio" || h === "año") return "anio";
  if (tiene("sencill")) return "costo_sencilla";
  if (tiene("doble")) return "costo_doble";
  if (tiene("proveedor")) return "no_proveedor";
  if (tiene("razon social")) return "razon_social";
  if (tiene("telefono") || h === "tel") return "telefono";
  if (tiene("contacto")) return "contacto";
  if (tiene("banco") || tiene("clabe")) return "banco";
  if (tiene("correo") || tiene("email") || h === "mail") return "correo";
  if (tiene("direccion") || tiene("domicilio")) return "direccion";
  if (tiene("nota") || tiene("comentario") || tiene("observacion")) return "notas";
  return null;
}

/** Busca la fila de encabezados (la primera, entre las 15 primeras, que trae "Nombre Comercial"). */
export function filaDeEncabezados(filas: unknown[][]): number {
  for (let i = 0; i < Math.min(filas.length, 15); i++) {
    if ((filas[i] ?? []).some((c) => campoDeEncabezado(c) === "nombre_comercial")) return i;
  }
  return -1;
}

/** Columna de cada campo (la primera que coincida). */
export function mapearEncabezados(encabezados: unknown[]): Partial<Record<CampoImportable, number>> {
  const mapa: Partial<Record<CampoImportable, number>> = {};
  encabezados.forEach((h, i) => {
    const campo = campoDeEncabezado(h);
    if (campo && mapa[campo] === undefined) mapa[campo] = i;
  });
  return mapa;
}

// Nombres oficiales largos y abreviaturas comunes → el nombre de ESTADOS_MX.
const ALIAS_ESTADO: Record<string, string> = {
  "ciudad de mexico": "CDMX",
  cdmx: "CDMX",
  df: "CDMX",
  "distrito federal": "CDMX",
  "estado de mexico": "Estado de México",
  "edo mex": "Estado de México",
  "edo de mexico": "Estado de México",
  edomex: "Estado de México",
  "coahuila de zaragoza": "Coahuila",
  "michoacan de ocampo": "Michoacán",
  "veracruz de ignacio de la llave": "Veracruz",
  bc: "Baja California",
  bcs: "Baja California Sur",
  slp: "San Luis Potosí",
  qroo: "Quintana Roo",
  "q roo": "Quintana Roo",
  nl: "Nuevo León",
};

/** Estado de ESTADOS_MX que corresponde al texto ("Nuevo Leon" → "Nuevo León"), o null si no se reconoce. */
export function normalizarEstado(v: unknown): string | null {
  const t = normalizarTexto(v);
  if (!t) return null;
  const exacto = ESTADOS_MX.find((e) => normalizarTexto(e) === t);
  return exacto ?? ALIAS_ESTADO[t] ?? null;
}

/** Monto de una celda: número, o texto como "$1,116.00" / "850". Vacío o ilegible → null. */
export function leerMonto(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v ?? "").replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Texto de una celda (los números grandes, como teléfonos, sin notación científica). */
export function leerTexto(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? v.toFixed(0) : String(v);
  return String(v ?? "").trim();
}

export type ConvenioImportado = {
  tipo_sucursal: string;
  no_sucursal: string;
  destino: string;
  estado: string;
  nombre_comercial: string;
  anio: number;
  costo_sencilla: number;
  costo_doble: number | null;
  no_proveedor: string;
  razon_social: string;
  telefono: string;
  contacto: string;
  banco: string;
  correo: string;
  direccion: string;
  notas: string;
};

export type FilaImportada = {
  fila: number; // número de fila en el Excel (1 = primera fila de la hoja)
  datos: ConvenioImportado;
  errores: string[];
};

/** Convierte una fila del Excel en convenio y lista lo que le falta (no se carga si tiene errores). */
export function leerFila(
  celdas: unknown[],
  mapa: Partial<Record<CampoImportable, number>>,
  fila: number,
): FilaImportada | null {
  const celda = (c: CampoImportable) => (mapa[c] === undefined ? "" : celdas[mapa[c]!]);
  // Fila vacía (o solo con la columna "Su"): se ignora.
  const usadas = Object.values(mapa).map((i) => celdas[i!]);
  if (usadas.every((v) => leerTexto(v) === "")) return null;

  const errores: string[] = [];
  const nombre = leerTexto(celda("nombre_comercial"));
  const destino = leerTexto(celda("destino"));
  const estadoTxt = leerTexto(celda("estado"));
  const estado = normalizarEstado(estadoTxt);
  const anio = leerMonto(celda("anio"));
  const sencilla = leerMonto(celda("costo_sencilla"));
  const doble = leerMonto(celda("costo_doble"));
  const correo = leerTexto(celda("correo"));

  if (!nombre) errores.push("Falta el nombre comercial");
  if (!destino) errores.push("Falta el destino");
  if (!estadoTxt) errores.push("Falta el estado");
  else if (!estado) errores.push(`Estado no reconocido: “${estadoTxt}”`);
  if (!anio || !Number.isInteger(anio) || anio < 2000 || anio > 2100) errores.push("Año inválido");
  if (!(sencilla && sencilla > 0)) errores.push("Falta el costo de habitación sencilla");
  if (doble !== null && !(doble > 0)) errores.push("Costo de habitación doble inválido");
  if (correo && !/^\S+@\S+\.\S+$/.test(correo)) errores.push("Correo con formato inválido");

  return {
    fila,
    errores,
    datos: {
      tipo_sucursal: leerTexto(celda("tipo_sucursal")),
      no_sucursal: leerTexto(celda("no_sucursal")),
      destino,
      estado: estado ?? "",
      nombre_comercial: nombre,
      anio: anio ?? 0,
      costo_sencilla: sencilla ?? 0,
      costo_doble: doble !== null && doble > 0 ? doble : null,
      no_proveedor: leerTexto(celda("no_proveedor")),
      razon_social: leerTexto(celda("razon_social")),
      telefono: leerTexto(celda("telefono")),
      contacto: leerTexto(celda("contacto")),
      banco: leerTexto(celda("banco")),
      correo,
      direccion: leerTexto(celda("direccion")),
      notas: leerTexto(celda("notas")),
    },
  };
}

/** Clave de un convenio: mismo hotel + destino + año (sin distinguir mayúsculas ni acentos, como MySQL). */
export const claveConvenio = (c: { nombre_comercial: string; destino: string; anio: number }) =>
  `${normalizarTexto(c.nombre_comercial)}|${normalizarTexto(c.destino)}|${c.anio}`;
