// Consulta del estado de un CFDI ante el SAT (servicio público "Consulta de CFDI", SOAP).
// Nunca lanza: si el SAT no responde (red, tiempo agotado, HTTP ≠ 200, respuesta ilegible) devuelve 'Pendiente'
// para que la factura se acepte y se reverifique después.
import { XMLParser } from "fast-xml-parser";

export type EstadoSat = "Vigente" | "Cancelado" | "No Encontrado" | "Pendiente";

export type ResultadoSat = {
  estado: EstadoSat;
  esCancelable?: string;
  estatusCancelacion?: string;
};

const URL_SAT =
  process.env.SAT_CONSULTA_URL ?? "https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc";
const TIMEOUT_MS = Number(process.env.SAT_TIMEOUT_MS) || 8000;

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

const escXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Total con el formato de la expresión impresa del SAT: 10 enteros + 6 decimales. */
const totalSat = (t: number) => t.toFixed(6).padStart(17, "0");

type Nodo = Record<string, unknown>;

export async function consultarEstadoCfdi(datos: {
  rfcEmisor: string;
  rfcReceptor: string;
  total: number;
  uuid: string;
}): Promise<ResultadoSat> {
  const expresion = `?re=${datos.rfcEmisor}&rr=${datos.rfcReceptor}&tt=${totalSat(datos.total)}&id=${datos.uuid}`;
  const sobre =
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">` +
    `<soapenv:Header/><soapenv:Body><tem:Consulta><tem:expresionImpresa>${escXml(expresion)}</tem:expresionImpresa>` +
    `</tem:Consulta></soapenv:Body></soapenv:Envelope>`;
  try {
    const resp = await fetch(URL_SAT, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: '"http://tempuri.org/IConsultaCFDIService/Consulta"',
      },
      body: sobre,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return { estado: "Pendiente" };
    const doc = parser.parse(await resp.text()) as Nodo;
    const res = ((((doc.Envelope as Nodo)?.Body as Nodo)?.ConsultaResponse as Nodo)?.ConsultaResult ?? {}) as Nodo;
    const estado = String(res.Estado ?? "").trim();
    const detalle = {
      esCancelable: res.EsCancelable ? String(res.EsCancelable) : undefined,
      estatusCancelacion: res.EstatusCancelacion ? String(res.EstatusCancelacion) : undefined,
    };
    if (/^vigente$/i.test(estado)) return { estado: "Vigente", ...detalle };
    if (/^cancelado$/i.test(estado)) return { estado: "Cancelado", ...detalle };
    if (/no encontrado/i.test(estado)) return { estado: "No Encontrado", ...detalle };
    return { estado: "Pendiente" }; // respuesta que no se entiende (p. ej. "N - 601 expresión impresa inválida")
  } catch (e) {
    console.error("Consulta al SAT sin respuesta:", e instanceof Error ? e.message : e);
    return { estado: "Pendiente" };
  }
}
