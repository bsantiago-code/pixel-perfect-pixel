import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Paginación común a todas las tablas/listas del portal: 25 filas por omisión y el usuario elige cuántas ver.
const OPCIONES_POR_PAGINA = [10, 25, 50, 100];
const POR_PAGINA_INICIAL = 25;

/**
 * Corta `items` en páginas. Regresa la página actual (`visibles`) y las props para `<Paginacion>`.
 * Al cambiar los filtros (cambia el número de elementos) vuelve a la página 1.
 */
export function usePaginacion<T>(items: T[], porPaginaInicial = POR_PAGINA_INICIAL) {
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState(porPaginaInicial);
  const total = items.length;
  const paginas = Math.max(1, Math.ceil(total / porPagina));

  useEffect(() => {
    setPagina(1);
  }, [total]);

  // Por si la lista se achica sin cambiar de longitud a tiempo (p. ej. se elimina el último de la página).
  const actual = Math.min(pagina, paginas);
  const inicio = (actual - 1) * porPagina;

  return {
    visibles: items.slice(inicio, inicio + porPagina),
    paginacion: {
      pagina: actual,
      paginas,
      total,
      porPagina,
      onPagina: setPagina,
      onPorPagina: (n: number) => {
        setPorPagina(n);
        setPagina(1);
      },
    },
  };
}

type Props = ReturnType<typeof usePaginacion>["paginacion"] & { className?: string };

/**
 * Variante en componente, para listas que se calculan donde no se puede llamar un hook (p. ej. después de un
 * `return` anticipado): `children` recibe la página actual y la paginación se dibuja debajo.
 */
export function Paginado<T>({
  items,
  children,
  className,
}: {
  items: T[];
  children: (visibles: T[]) => ReactNode;
  className?: string;
}) {
  const { visibles, paginacion } = usePaginacion(items);
  return (
    <>
      {children(visibles)}
      <Paginacion {...paginacion} className={className} />
    </>
  );
}

/** Números de página a mostrar: primera, última y las vecinas de la actual, con "…" en los huecos. */
function numeros(pagina: number, paginas: number): (number | "…")[] {
  const set = new Set([1, paginas, pagina - 1, pagina, pagina + 1]);
  const lista = [...set].filter((n) => n >= 1 && n <= paginas).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  lista.forEach((n, i) => {
    if (i > 0 && n - lista[i - 1] > 1) out.push("…");
    out.push(n);
  });
  return out;
}

export function Paginacion({ pagina, paginas, total, porPagina, onPagina, onPorPagina, className }: Props) {
  if (total === 0) return null;
  const desde = (pagina - 1) * porPagina + 1;
  const hasta = Math.min(pagina * porPagina, total);
  const boton =
    "inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-xs font-medium disabled:opacity-40";

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 px-1 py-3 text-xs text-muted-foreground ${className ?? ""}`}
    >
      <div className="flex items-center gap-2">
        <span>
          Mostrando <b className="text-foreground">{desde}</b>–<b className="text-foreground">{hasta}</b>{" "}
          de <b className="text-foreground">{total}</b>
        </span>
        <label className="flex items-center gap-1">
          <span className="hidden sm:inline">· Filas por página</span>
          <select
            className="rounded-md border bg-white px-1 py-1 text-xs text-foreground"
            value={porPagina}
            onChange={(e) => onPorPagina(Number(e.target.value))}
            aria-label="Filas por página"
          >
            {OPCIONES_POR_PAGINA.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {paginas > 1 && (
        <nav className="flex items-center gap-1" aria-label="Paginación">
          <button
            className={`${boton} bg-white`}
            disabled={pagina <= 1}
            onClick={() => onPagina(pagina - 1)}
            aria-label="Página anterior"
          >
            <ChevronLeft size={14} />
          </button>
          {numeros(pagina, paginas).map((n, i) =>
            n === "…" ? (
              <span key={`h${i}`} className="px-1">
                …
              </span>
            ) : (
              <button
                key={n}
                className={boton}
                style={
                  n === pagina
                    ? { background: "var(--color-primary)", color: "white", borderColor: "var(--color-primary)" }
                    : { background: "white" }
                }
                aria-current={n === pagina ? "page" : undefined}
                onClick={() => onPagina(n)}
              >
                {n}
              </button>
            ),
          )}
          <button
            className={`${boton} bg-white`}
            disabled={pagina >= paginas}
            onClick={() => onPagina(pagina + 1)}
            aria-label="Página siguiente"
          >
            <ChevronRight size={14} />
          </button>
        </nav>
      )}
    </div>
  );
}
