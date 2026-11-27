// Tipos del desglose contable de un CFDI y utilidades puras sin dependencias (seguras para el navegador).

export type ImpuestoCfdi = {
  /** Clave SAT: 001 ISR, 002 IVA, 003 IEPS. */
  impuesto: string;
  tipoFactor: "Tasa" | "Cuota" | "Exento";
  /** Tasa o cuota decimal (0.16 = 16 %); null si es Exento. */
  tasa: number | null;
  base: number | null;
  /** null si es Exento (no hay importe de impuesto). */
  importe: number | null;
};

export type ConceptoCfdi = {
  claveProdServ: string;
  descripcion: string;
  cantidad: number;
  importe: number;
  descuento: number;
  objetoImp: string;
  traslados: ImpuestoCfdi[];
  retenciones: ImpuestoCfdi[];
};

export type DesgloseCfdi = {
  version: string;
  serie: string;
  folio: string;
  fecha: string | null;
  moneda: string;
  tipoCambio: number | null;
  subtotal: number;
  descuento: number;
  total: number;
  emisor: { rfc: string; nombre: string };
  receptor: { rfc: string };
  conceptos: ConceptoCfdi[];
  /** Impuestos a nivel comprobante (resumen). Sirven si los conceptos no traen su desglose. */
  trasladados: ImpuestoCfdi[];
  retenidos: ImpuestoCfdi[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Suma impuestos iguales (mismo impuesto, factor y tasa): una línea por tasa. */
export function agruparImpuestos(lst: ImpuestoCfdi[]): ImpuestoCfdi[] {
  const m = new Map<string, ImpuestoCfdi>();
  for (const i of lst) {
    const k = `${i.impuesto}|${i.tipoFactor}|${i.tasa ?? ""}`;
    const a = m.get(k);
    if (!a) m.set(k, { ...i });
    else {
      a.base = a.base === null && i.base === null ? null : r2((a.base ?? 0) + (i.base ?? 0));
      a.importe = a.importe === null && i.importe === null ? null : r2((a.importe ?? 0) + (i.importe ?? 0));
    }
  }
  return [...m.values()];
}
