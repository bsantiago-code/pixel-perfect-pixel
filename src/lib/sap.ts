// Contabilización a SAP: catálogo de cuentas configurables y armado del asiento a partir del XML de cada factura.
// Todo es puro (sin BD ni red): lo usan el servidor (envío y vista previa), la pantalla de Configuración y las pruebas.
// El IVA, las retenciones y los importes salen del XML; la cuenta del gasto sale del concepto del viático
// (Hotel, Comida…) según lo que el administrador capture en Configuración.
import { agruparImpuestos, type DesgloseCfdi, type ImpuestoCfdi } from "./desglose-tipos.ts";

/** Conceptos de comprobación que pueden tener una cuenta contable. */
export const CONCEPTOS_CONTABLES = [
  "Hotel",
  "Avión",
  "Autobús",
  "Tren",
  "Otro (foráneo)",
  "Uber",
  "Taxi",
  "Metro",
  "Combi",
  "Otro (transporte local)",
  "Comida",
  "Caseta",
  "Vales",
] as const;

/** Cuentas que no dependen del concepto. */
export const CUENTAS_FIJAS: { clave: string; etiqueta: string }[] = [
  { clave: "iva_trasladado_16", etiqueta: "IVA acreditable 16 %" },
  { clave: "iva_trasladado_8", etiqueta: "IVA acreditable 8 %" },
  { clave: "iva_trasladado_0", etiqueta: "IVA tasa 0 %" },
  { clave: "ieps_trasladado", etiqueta: "IEPS trasladado" },
  { clave: "iva_retenido", etiqueta: "IVA retenido" },
  { clave: "isr_retenido", etiqueta: "ISR retenido" },
  { clave: "contrapartida", etiqueta: "Contrapartida (acreedor / viajero)" },
];

export const claveCuentaConcepto = (concepto: string) => `concepto:${concepto}`;

/** Claves válidas del mapa de cuentas (concepto:<Concepto> y las fijas). */
export const CLAVES_CUENTAS = new Set<string>([
  ...CONCEPTOS_CONTABLES.map(claveCuentaConcepto),
  ...CUENTAS_FIJAS.map((c) => c.clave),
]);

const etiquetaClave = (clave: string) =>
  clave.startsWith("concepto:")
    ? `Cuenta del concepto ${clave.slice(9)}`
    : (CUENTAS_FIJAS.find((c) => c.clave === clave)?.etiqueta ?? clave);

/** El folio viaja a SAP como texto y sin el caracter "#" (#0045 → "0045"). */
export const folioTexto = (folio: string) => folio.replace(/#/g, "").trim();

export type Cuentas = Record<string, string>;

export type LineaSap = {
  tipo: "gasto" | "iva" | "ieps" | "retencion" | "contrapartida";
  clave: string;
  cuenta: string | null;
  descripcion: string;
  debe: number;
  haber: number;
  uuid?: string;
  concepto?: string;
  tasa?: number | null;
  base?: number | null;
};

export type PayloadSap = {
  /** Folio como texto, sin "#": también sirve de llave de idempotencia en SAP. */
  referencia: string;
  sociedad: string;
  rfcSociedad?: string;
  moneda: string;
  fechaContabilizacion: string;
  viajero: { id: string; nombre: string };
  facturas: { uuid: string; archivo: string; concepto: string; emisorRfc: string; emisorNombre: string; total: number }[];
  lineas: LineaSap[];
  totales: { debe: number; haber: number };
};

export type FacturaContable = { uuid: string; archivo: string; concepto: string; desglose: DesgloseCfdi };

export type ResultadoPayload = { payload: PayloadSap; faltantes: string[]; advertencias: string[] };

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Arma el asiento del folio: por cada XML una línea de gasto por concepto (cuenta del concepto del viático), el IVA
 * agrupado por tasa, el IEPS, las retenciones y, al final, la contrapartida por la diferencia.
 * `faltantes` = cuentas sin configurar que el asiento necesita; `advertencias` = detalles a revisar.
 */
export function armarPayloadSap(input: {
  folio: string;
  empresa: string;
  rfcSociedad?: string;
  fecha: string;
  viajero: { id: string; nombre: string };
  facturas: FacturaContable[];
  cuentas: Cuentas;
}): ResultadoPayload {
  const faltantes = new Set<string>();
  const advertencias: string[] = [];
  const lineas: LineaSap[] = [];
  const cuenta = (clave: string, usada: boolean): string | null => {
    const v = (input.cuentas[clave] ?? "").trim();
    if (!v && usada) faltantes.add(etiquetaClave(clave));
    return v || null;
  };

  for (const f of input.facturas) {
    const d = f.desglose;
    const tc = d.moneda !== "MXN" && d.tipoCambio ? d.tipoCambio : 1;
    if (d.moneda !== "MXN") {
      advertencias.push(
        d.tipoCambio
          ? `La factura ${f.uuid} está en ${d.moneda}: se convirtió a MXN con tipo de cambio ${d.tipoCambio}.`
          : `La factura ${f.uuid} está en ${d.moneda} y no trae tipo de cambio: se envía sin convertir.`,
      );
    }
    const m = (n: number) => r2(n * tc);

    let debe = 0;
    let haber = 0;
    for (const k of d.conceptos) {
      const neto = m(k.importe - k.descuento);
      if (neto === 0) continue;
      const clave = claveCuentaConcepto(f.concepto);
      lineas.push({
        tipo: "gasto",
        clave,
        cuenta: cuenta(clave, true),
        descripcion: k.descripcion || f.concepto,
        debe: neto,
        haber: 0,
        uuid: f.uuid,
        concepto: f.concepto,
      });
      debe += neto;
    }

    // Impuestos: del desglose de cada concepto; si no lo traen, del resumen del comprobante.
    const traslados = agruparImpuestos(
      d.conceptos.some((k) => k.traslados.length) ? d.conceptos.flatMap((k) => k.traslados) : d.trasladados,
    );
    const retenciones = agruparImpuestos(
      d.conceptos.some((k) => k.retenciones.length) ? d.conceptos.flatMap((k) => k.retenciones) : d.retenidos,
    );
    for (const t of traslados) {
      if (t.tipoFactor === "Exento") {
        advertencias.push(`La factura ${f.uuid} trae conceptos exentos de IVA (sin línea de impuesto).`);
        continue;
      }
      const importe = m(t.importe ?? 0);
      if (t.impuesto === "002") {
        const pct = Math.round((t.tasa ?? 0) * 10000) / 100;
        const clave = `iva_trasladado_${pct}`;
        const conocida = CLAVES_CUENTAS.has(clave);
        if (!conocida && importe > 0) advertencias.push(`IVA a tasa ${pct} % en ${f.uuid}: no hay cuenta definida para esa tasa.`);
        lineas.push({
          tipo: "iva", clave, cuenta: conocida ? cuenta(clave, importe > 0) : null,
          descripcion: `IVA ${pct} %`, debe: importe, haber: 0, uuid: f.uuid, tasa: t.tasa, base: t.base === null ? null : m(t.base),
        });
        debe += importe;
      } else if (t.impuesto === "003") {
        lineas.push({
          tipo: "ieps", clave: "ieps_trasladado", cuenta: cuenta("ieps_trasladado", importe > 0),
          descripcion: "IEPS", debe: importe, haber: 0, uuid: f.uuid, tasa: t.tasa, base: t.base === null ? null : m(t.base),
        });
        debe += importe;
      } else {
        advertencias.push(`Traslado del impuesto ${t.impuesto} en ${f.uuid} no se contabiliza.`);
      }
    }
    for (const t of retenciones) {
      const importe = m(t.importe ?? 0);
      const clave = t.impuesto === "001" ? "isr_retenido" : t.impuesto === "002" ? "iva_retenido" : "";
      if (!clave) {
        advertencias.push(`Retención del impuesto ${t.impuesto} en ${f.uuid} no se contabiliza.`);
        continue;
      }
      lineas.push({
        tipo: "retencion", clave, cuenta: cuenta(clave, importe > 0),
        descripcion: t.impuesto === "001" ? "ISR retenido" : "IVA retenido",
        debe: 0, haber: importe, uuid: f.uuid, tasa: t.tasa, base: t.base === null ? null : m(t.base),
      });
      haber += importe;
    }

    const calculado = r2(debe - haber);
    const esperado = m(d.total);
    if (Math.abs(calculado - esperado) > 0.05) {
      advertencias.push(
        `El asiento de la factura ${f.uuid} (${calculado.toFixed(2)}) no coincide con el total del XML (${esperado.toFixed(2)}): revisa impuestos locales u otros conceptos.`,
      );
    }
  }

  const sumaDebe = r2(lineas.reduce((a, l) => a + l.debe, 0));
  const sumaHaber = r2(lineas.reduce((a, l) => a + l.haber, 0));
  const contra = r2(sumaDebe - sumaHaber);
  lineas.push({
    tipo: "contrapartida", clave: "contrapartida", cuenta: cuenta("contrapartida", input.facturas.length > 0),
    descripcion: `Contrapartida viaje ${folioTexto(input.folio)}`, debe: 0, haber: contra,
  });

  return {
    payload: {
      referencia: folioTexto(input.folio),
      sociedad: input.empresa,
      rfcSociedad: input.rfcSociedad,
      moneda: "MXN",
      fechaContabilizacion: input.fecha,
      viajero: input.viajero,
      facturas: input.facturas.map((f) => ({
        uuid: f.uuid,
        archivo: f.archivo,
        concepto: f.concepto,
        emisorRfc: f.desglose.emisor.rfc,
        emisorNombre: f.desglose.emisor.nombre,
        total: f.desglose.total,
      })),
      lineas,
      totales: { debe: sumaDebe, haber: r2(sumaHaber + contra) },
    },
    faltantes: [...faltantes],
    advertencias,
  };
}

export type { ImpuestoCfdi };
