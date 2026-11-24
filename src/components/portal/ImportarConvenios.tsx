import { useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, Upload, X } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { showErrorDialog } from "@/components/ErrorDialog";
import { Paginado } from "@/components/portal/Paginacion";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/queries";
import {
  claveConvenio,
  COLUMNAS_OBLIGATORIAS,
  filaDeEncabezados,
  leerFila,
  mapearEncabezados,
  MAX_FILAS_IMPORTACION,
  normalizarTexto,
  PLANTILLA_CONVENIOS,
  type CampoImportable,
  type FilaImportada,
} from "@/lib/importar-convenios";
import { ESTADOS_MX, fmtTarifa, type Convenio } from "@/lib/store";

// Carga masiva de convenios (Compras): plantilla descargable + lectura del Excel con vista previa por fila.
// Las filas con error no se cargan; un convenio que ya existe (mismo hotel + destino + año) se actualiza.

type Resultado = FilaImportada & { estatus: "nuevo" | "actualiza" | "error" };
type Lectura = {
  archivo: string;
  hojas: string[];
  hoja: string;
  libro: XLSX.WorkBook;
  columnas: CampoImportable[];
  errorArchivo: string | null;
  filas: Resultado[];
};

const etiquetaCampo = (c: CampoImportable) =>
  PLANTILLA_CONVENIOS.find((p) => p.campo === c)?.encabezado ?? c;

function descargarPlantilla() {
  const libro = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet([PLANTILLA_CONVENIOS.map((p) => p.encabezado)]);
  hoja["!cols"] = PLANTILLA_CONVENIOS.map((p) => ({ wch: Math.max(14, p.encabezado.length + 2) }));
  XLSX.utils.book_append_sheet(libro, hoja, "Hoteles");
  const estados = XLSX.utils.aoa_to_sheet([["Estados válidos (columna Estado)"], ...ESTADOS_MX.map((e) => [e])]);
  estados["!cols"] = [{ wch: 34 }];
  XLSX.utils.book_append_sheet(libro, estados, "Estados");
  XLSX.writeFile(libro, "Plantilla_convenios_hoteles.xlsx");
}

/** Lee una hoja del libro y la convierte en filas con su resultado esperado. */
function leerHoja(libro: XLSX.WorkBook, hoja: string, archivo: string, convenios: Convenio[]): Lectura {
  const base = { archivo, hojas: libro.SheetNames, hoja, libro, columnas: [], filas: [] };
  const datos = XLSX.utils.sheet_to_json<unknown[]>(libro.Sheets[hoja], { header: 1, raw: true, defval: "" });
  const ie = filaDeEncabezados(datos);
  if (ie < 0) {
    return { ...base, errorArchivo: "No se encontró la fila de encabezados (debe tener la columna “Nombre Comercial”)." };
  }
  const mapa = mapearEncabezados(datos[ie]);
  const columnas = Object.keys(mapa) as CampoImportable[];
  const faltan = COLUMNAS_OBLIGATORIAS.filter((c) => mapa[c] === undefined);
  if (faltan.length) {
    return {
      ...base,
      columnas,
      errorArchivo: `Al archivo le faltan columnas obligatorias: ${faltan.map(etiquetaCampo).join(", ")}. Descarga la plantilla para ver el formato.`,
    };
  }
  const leidas = datos
    .slice(ie + 1)
    .map((celdas, i) => leerFila(celdas, mapa, ie + 2 + i))
    .filter((f): f is FilaImportada => f !== null);
  if (leidas.length > MAX_FILAS_IMPORTACION) {
    return { ...base, columnas, errorArchivo: `Se pueden cargar hasta ${MAX_FILAS_IMPORTACION} convenios por archivo.` };
  }

  // Repetidas dentro del archivo: vale la última; las anteriores se marcan.
  const ultima = new Map<string, number>();
  leidas.forEach((f) => !f.errores.length && ultima.set(claveConvenio(f.datos), f.fila));
  const existentes = new Set(convenios.map((c) => claveConvenio(c)));
  const filas: Resultado[] = leidas.map((f) => {
    if (f.errores.length) return { ...f, estatus: "error" };
    const k = claveConvenio(f.datos);
    if (ultima.get(k) !== f.fila) {
      return { ...f, estatus: "error", errores: [`Repetida más abajo en el archivo (fila ${ultima.get(k)})`] };
    }
    return { ...f, estatus: existentes.has(k) ? "actualiza" : "nuevo" };
  });
  return { ...base, columnas, errorArchivo: null, filas };
}

export function ImportarConvenios({ convenios }: { convenios: Convenio[] }) {
  const input = useRef<HTMLInputElement>(null);
  const [lectura, setLectura] = useState<Lectura | null>(null);
  const [verSolo, setVerSolo] = useState<"todas" | "error">("todas");

  const abrir = async (archivo: File) => {
    try {
      const libro = XLSX.read(await archivo.arrayBuffer(), { type: "array" });
      // Por omisión la pestaña "Hoteles" (o la primera).
      const hoja = libro.SheetNames.find((n) => normalizarTexto(n).includes("hotel")) ?? libro.SheetNames[0];
      setVerSolo("todas");
      setLectura(leerHoja(libro, hoja, archivo.name, convenios));
    } catch {
      showErrorDialog("No se pudo leer el archivo. Verifica que sea un Excel (.xlsx o .xls).");
    }
  };

  const cargar = useApiMutation(
    (l: Lectura) =>
      api.post<{ nuevos: number; actualizados: number; errores: { fila: number; motivo: string }[] }>(
        "/convenios/importar",
        {
          archivo: l.archivo,
          columnas: l.columnas,
          filas: l.filas.filter((f) => f.estatus !== "error").map((f) => ({ fila: f.fila, datos: f.datos })),
        },
      ),
    {
      onSuccess: (r) => {
        setLectura(null);
        toast.success(`Carga terminada: ${r.nuevos} convenio(s) nuevo(s) y ${r.actualizados} actualizado(s).`);
        if (r.errores.length) {
          showErrorDialog(
            `${r.errores.length} fila(s) no se cargaron: ` +
              r.errores.slice(0, 8).map((e) => `fila ${e.fila} (${e.motivo})`).join("; ") +
              (r.errores.length > 8 ? "…" : "."),
          );
        }
      },
    },
  );

  const resumen = useMemo(() => {
    const f = lectura?.filas ?? [];
    return {
      nuevos: f.filter((x) => x.estatus === "nuevo").length,
      actualiza: f.filter((x) => x.estatus === "actualiza").length,
      error: f.filter((x) => x.estatus === "error").length,
    };
  }, [lectura]);
  const visibles = (lectura?.filas ?? []).filter((f) => verSolo === "todas" || f.estatus === "error");
  const aCargar = resumen.nuevos + resumen.actualiza;

  return (
    <>
      <button onClick={descargarPlantilla} className="ckl-btn-outline" title="Excel con las columnas que lee la carga">
        <Download size={14} /> Descargar plantilla
      </button>
      <button onClick={() => input.current?.click()} className="ckl-btn-outline">
        <Upload size={14} /> Cargar Excel
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // permite volver a elegir el mismo archivo
          if (f) void abrir(f);
        }}
      />

      {lectura && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setLectura(null)}>
          <div
            className="ckl-card relative flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Vista previa de la carga de convenios"
          >
            <div className="flex items-start justify-between gap-3 border-b p-5">
              <div>
                <h3 className="flex items-center gap-2 text-lg font-semibold">
                  <FileSpreadsheet size={20} style={{ color: "var(--color-primary)" }} /> Vista previa de la carga
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{lectura.archivo}</p>
              </div>
              <button onClick={() => setLectura(null)} className="rounded p-1 hover:bg-secondary" aria-label="Cerrar">
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3 overflow-y-auto p-5">
              {lectura.hojas.length > 1 && (
                <label className="flex items-center gap-2 text-sm">
                  <span className="ckl-label mb-0">Pestaña</span>
                  <select
                    className="ckl-input max-w-xs"
                    value={lectura.hoja}
                    onChange={(e) => setLectura(leerHoja(lectura.libro, e.target.value, lectura.archivo, convenios))}
                  >
                    {lectura.hojas.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </select>
                </label>
              )}

              {lectura.errorArchivo ? (
                <div className="rounded-md p-3 text-sm" style={{ background: "#FEE9EA", color: "#B5040F" }}>
                  {lectura.errorArchivo}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="ckl-badge" style={{ background: "#D8F3DC", color: "#2D6A4F" }}>
                      {resumen.nuevos} nuevo(s)
                    </span>
                    <span className="ckl-badge" style={{ background: "#E0E7FF", color: "#3730A3" }}>
                      {resumen.actualiza} se actualizan
                    </span>
                    <span className="ckl-badge" style={{ background: "#FEE9EA", color: "#B5040F" }}>
                      {resumen.error} con error (no se cargan)
                    </span>
                    <select
                      className="ckl-input ml-auto max-w-[200px]"
                      value={verSolo}
                      onChange={(e) => setVerSolo(e.target.value as "todas" | "error")}
                      aria-label="Filas a mostrar"
                    >
                      <option value="todas">Todas las filas</option>
                      <option value="error">Solo con error</option>
                    </select>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Columnas reconocidas: {lectura.columnas.map(etiquetaCampo).join(", ")}. Lo que el archivo no
                    trae no se borra de los convenios que ya existen.
                  </p>
                  <div className="overflow-x-auto rounded-lg border">
                    <Paginado items={visibles} className="border-t px-3">
                      {(pagina) => (
                        <table className="w-full text-xs">
                          <thead className="bg-secondary text-left text-muted-foreground">
                            <tr>
                              <th className="p-2">Fila</th>
                              <th className="p-2">Hotel</th>
                              <th className="p-2">Destino</th>
                              <th className="p-2">Estado</th>
                              <th className="p-2">Año</th>
                              <th className="p-2 text-right">Sencilla</th>
                              <th className="p-2 text-right">Doble</th>
                              <th className="p-2">Resultado</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pagina.map((f) => (
                              <tr key={f.fila} className="border-t align-top">
                                <td className="p-2 text-muted-foreground">{f.fila}</td>
                                <td className="p-2 font-medium">{f.datos.nombre_comercial || "—"}</td>
                                <td className="p-2">{f.datos.destino || "—"}</td>
                                <td className="p-2">{f.datos.estado || "—"}</td>
                                <td className="p-2">{f.datos.anio || "—"}</td>
                                <td className="p-2 text-right">
                                  {f.datos.costo_sencilla ? fmtTarifa(f.datos.costo_sencilla) : "—"}
                                </td>
                                <td className="p-2 text-right">
                                  {f.datos.costo_doble ? fmtTarifa(f.datos.costo_doble) : "—"}
                                </td>
                                <td className="p-2">
                                  {f.estatus === "error" ? (
                                    <span style={{ color: "#B5040F" }}>{f.errores.join(" · ")}</span>
                                  ) : f.estatus === "actualiza" ? (
                                    <span style={{ color: "#3730A3" }}>Se actualiza</span>
                                  ) : (
                                    <span style={{ color: "#2D6A4F" }}>Nuevo</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                            {visibles.length === 0 && (
                              <tr>
                                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                                  Sin filas
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      )}
                    </Paginado>
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t p-4">
              <button onClick={() => setLectura(null)} className="ckl-btn-ghost">
                Cancelar
              </button>
              <button
                onClick={() => cargar.mutate(lectura)}
                disabled={!!lectura.errorArchivo || aCargar === 0 || cargar.isPending}
                className="ckl-btn-primary"
              >
                <Upload size={14} /> Cargar {aCargar} convenio(s)
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
