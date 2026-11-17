// Palabras prohibidas en facturas (alcohol, tabaco, higiene). Archivo ligero y sin dependencias:
// lo usan el navegador (Configuración) y el servidor (src/lib/validar-factura.ts).

export type ListasProhibidas = { alcohol: string[]; tabaco: string[]; higiene: string[] };

/** Valores iniciales; Control los edita en Configuración (claves `palabras_prohibidas_*`). */
export const PALABRAS_DEFAULT: ListasProhibidas = {
  alcohol: [
    "cerveza", "vino", "tequila", "mezcal", "whisky", "whiskey", "ron", "vodka", "ginebra", "brandy",
    "coñac", "cognac", "licor", "sidra", "champagne", "champaña", "aguardiente", "bacardi", "destilado",
  ],
  tabaco: ["cigarro", "cigarrillo", "cigarrillos", "vape", "vapeador", "tabaco", "puro", "nicotina", "habano"],
  higiene: [
    "shampoo", "champu", "pasta dental", "desodorante", "maquillaje", "cepillo dental", "enjuague bucal",
    "rastrillo", "crema corporal", "toalla sanitaria", "tampon", "perfume", "rimel", "labial",
  ],
};

/** Minúsculas, sin acentos y con espacios colapsados (ñ → n). */
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Limpia una lista editable: solo textos, sin espacios sobrantes, sin vacíos ni duplicados. */
export function normalizarListaPalabras(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  const vistos = new Set<string>();
  const salida: string[] = [];
  for (const v of valor) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    const k = normalizar(t);
    if (!t || vistos.has(k)) continue;
    vistos.add(k);
    salida.push(t);
  }
  return salida;
}
