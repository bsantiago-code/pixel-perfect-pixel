// Contrato común de los almacenes de archivos de comprobantes (XML/PDF/foto).
// La referencia que se guarda en `facturas.ruta` lleva prefijo: `drive:<fileId>` o `local:<ruta relativa>`.
// Sin referencia (NULL) el contenido está en la base de datos (`factura_archivos`).

export type ArchivoEntrada = {
  sociedad: string;
  anio: string | number;
  folio: string; // "#0036" o "0036"
  nombre: string; // nombre original del archivo
  mime: string;
  buffer: Buffer;
};

export interface Almacen {
  readonly driver: "local" | "drive";
  /** Resumen legible del destino (sin secretos). */
  readonly destino: string;
  guardar(archivo: ArchivoEntrada): Promise<string>;
  leer(ref: string): Promise<{ buffer: Buffer }>;
  /** Manda el archivo a la papelera (no lo borra definitivamente). Si ya no existe, no falla. */
  eliminar(ref: string): Promise<void>;
  /** Escribe, lee y elimina un archivo de prueba. Lanza AlmacenError si algo falla. */
  probar(): Promise<{ detalle: string }>;
}

/** Error de almacenamiento con mensaje en español listo para mostrar. */
export class AlmacenError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}
