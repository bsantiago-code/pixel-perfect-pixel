// Cliente del servicio de SAP para contabilizar el asiento de un viaje.
// El contrato real del servicio aún no está definido: aquí queda una interfaz mínima (POST JSON) detrás de la que se
// conectará después. Nunca lanza: devuelve { ok: false, error } con un mensaje en español.
//   SAP_URL        base del servicio (p. ej. https://sap.cklass.net/api). Sin ella:
//                    · modo "simulado" → responde éxito sin salir de la red (documento SIM-<referencia>);
//                    · modo "real"     → error "no configurado".
//   SAP_TOKEN      (opcional) se manda como Bearer.
//   SAP_TIMEOUT_MS (opcional) tiempo máximo de espera; 15 s por omisión.
// La referencia (folio sin "#") viaja también como Idempotency-Key para que SAP no contabilice dos veces.
import type { PayloadSap } from "../../src/lib/sap.ts";

export type ModoSap = "simulado" | "real";

export type ResultadoSap =
  | { ok: true; documento: string; respuesta: unknown }
  | { ok: false; error: string };

const timeoutMs = () => Number(process.env.SAP_TIMEOUT_MS) || 15000;

function cabeceras(referencia: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", "Idempotency-Key": referencia };
  if (process.env.SAP_TOKEN) h.Authorization = `Bearer ${process.env.SAP_TOKEN}`;
  return h;
}

async function post(ruta: string, referencia: string, cuerpo: unknown): Promise<ResultadoSap> {
  const base = process.env.SAP_URL!.replace(/\/+$/, "");
  try {
    const resp = await fetch(`${base}${ruta}`, {
      method: "POST",
      headers: cabeceras(referencia),
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    let datos: Record<string, unknown> = {};
    try {
      datos = (await resp.json()) as Record<string, unknown>;
    } catch {
      /* respuesta sin JSON */
    }
    const documento = datos.documento ?? datos.documentoSap ?? datos.document;
    if (resp.ok && documento) return { ok: true, documento: String(documento), respuesta: datos };
    const detalle = String(datos.error ?? datos.mensaje ?? datos.message ?? "").trim();
    return { ok: false, error: detalle || `SAP respondió HTTP ${resp.status} sin número de documento.` };
  } catch (e) {
    const nombre = e instanceof Error ? e.name : "";
    console.error("Envío a SAP sin respuesta:", e instanceof Error ? e.message : e);
    return {
      ok: false,
      error: nombre === "TimeoutError" ? "SAP no respondió a tiempo." : "No se pudo comunicar con SAP.",
    };
  }
}

export async function contabilizarEnSap(payload: PayloadSap, modo: ModoSap): Promise<ResultadoSap> {
  if (!process.env.SAP_URL) {
    if (modo === "simulado") {
      return { ok: true, documento: `SIM-${payload.referencia}`, respuesta: { simulado: true } };
    }
    return { ok: false, error: "El servicio de SAP no está configurado (falta SAP_URL en el servidor)." };
  }
  return post("/contabilizar", payload.referencia, payload);
}

/** Punto de integración para la cancelación (la desarrolla otra persona): hoy solo manda la petición. */
export async function cancelarEnSap(referencia: string, documento: string, modo: ModoSap): Promise<ResultadoSap> {
  if (!process.env.SAP_URL) {
    if (modo === "simulado") return { ok: true, documento, respuesta: { simulado: true, cancelado: true } };
    return { ok: false, error: "El servicio de SAP no está configurado (falta SAP_URL en el servidor)." };
  }
  return post("/cancelar", referencia, { referencia, documento });
}
