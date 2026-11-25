import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Lock, PiggyBank, Wallet } from "lucide-react";
import {
  fmtFechaIso,
  fmtMoney,
  type PresupuestoFolio,
  type Solicitud,
  type evaluarPresupuestoFolio,
} from "@/lib/store";

type Evaluacion = NonNullable<ReturnType<typeof evaluarPresupuestoFolio>>;

// Semáforo de la tarjeta: verde alcanza, ámbar la bolsa queda arriba del 80 %, rojo excede o no hay bolsa.
const TONOS = {
  ok: {
    fondo: "#F0FDF4",
    borde: "#86EFAC",
    texto: "#166534",
    fuerte: "#16A34A",
    etiqueta: "Alcanza",
  },
  justo: {
    fondo: "#FFFBEB",
    borde: "#FCD34D",
    texto: "#92400E",
    fuerte: "#D97706",
    etiqueta: "Queda justo",
  },
  excede: {
    fondo: "#FEF2F2",
    borde: "#FCA5A5",
    texto: "#991B1B",
    fuerte: "#E30613",
    etiqueta: "Excede",
  },
  sinBolsa: {
    fondo: "#FEF2F2",
    borde: "#FCA5A5",
    texto: "#991B1B",
    fuerte: "#E30613",
    etiqueta: "Sin presupuesto",
  },
  neutro: {
    fondo: "#F8FAFC",
    borde: "#CBD5E1",
    texto: "#334155",
    fuerte: "#64748B",
    etiqueta: "No aplica",
  },
} as const;

const COLOR_EJERCIDO = "#64748B";

/**
 * Presupuesto del departamento del folio, en el detalle de Estatus (solo lo reciben quienes autorizan o
 * administran presupuestos). Muestra cómo queda la bolsa si se autoriza: barra de consumo, cifras y semáforo.
 */
export function PresupuestoFolioCard({
  info,
  folio,
  evaluacion,
  puedeGestionar,
}: {
  info: PresupuestoFolio;
  folio: Pick<Solicitud, "monto_total" | "estatus" | "fecha">;
  evaluacion: Evaluacion;
  puedeGestionar: boolean;
}) {
  const p = info.presupuesto;
  const abierto = folio.estatus === "Abierto";

  // ── Sin departamento o sin bolsa: aviso sin cifras ──
  if (info.departamento_id == null || !p) {
    const tono = info.departamento_id == null ? TONOS.neutro : TONOS.sinBolsa;
    return (
      <div
        className="mt-4 rounded-lg border-2 border-dashed p-4"
        style={{ background: tono.fondo, borderColor: tono.borde, color: tono.texto }}
      >
        <Encabezado departamento={info.departamento} tono={tono} bloqueado={!!evaluacion.bloqueo} />
        <div className="mt-3 flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
            style={{ background: "white", color: tono.fuerte }}
          >
            <Wallet size={20} />
          </div>
          <div className="text-sm">
            <div className="font-medium">{evaluacion.bloqueo ?? evaluacion.mensaje}</div>
            {info.departamento_id != null && (
              <div className="mt-1 text-xs opacity-80">
                Este folio ({fmtMoney(folio.monto_total)}) no descuenta de ninguna bolsa mientras no
                exista un presupuesto de {info.departamento} que cubra su fecha.
              </div>
            )}
            {info.departamento_id != null && puedeGestionar && (
              <Link to="/presupuestos" className="ckl-btn-outline mt-3 inline-flex text-xs">
                <PiggyBank size={14} /> Ir a Presupuestos
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Con bolsa ──
  // Un folio Abierto aún no está en lo ejercido; uno Cerrado ya está dentro.
  const ejercidoOtros = abierto ? p.ejercido : Math.max(p.ejercido - folio.monto_total, 0);
  const esteFolio = folio.monto_total;
  const usadoTotal = ejercidoOtros + esteFolio;
  const restante = p.monto - usadoTotal;
  const pct = p.monto > 0 ? (usadoTotal / p.monto) * 100 : usadoTotal > 0 ? 101 : 0;
  const tono = restante < 0 ? TONOS.excede : pct > 80 ? TONOS.justo : TONOS.ok;

  // La barra se escala al mayor entre la bolsa y lo usado, para que un exceso se vea fuera del límite.
  const escala = Math.max(p.monto, usadoTotal, 1);
  const w = (n: number) => `${Math.max((n / escala) * 100, 0)}%`;
  const libre = Math.max(restante, 0);
  const limite = (p.monto / escala) * 100;

  return (
    <div
      className="mt-4 rounded-lg border p-4"
      style={{ background: tono.fondo, borderColor: tono.borde, color: tono.texto }}
    >
      <Encabezado
        departamento={info.departamento}
        tono={tono}
        bloqueado={!!evaluacion.bloqueo}
        periodo={`${fmtFechaIso(p.fecha_inicio)} – ${fmtFechaIso(p.fecha_fin)}`}
      />

      {/* Barra de consumo */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between text-xs">
          <span>
            {abierto ? "Si se autoriza, la bolsa queda al" : "Bolsa ejercida al"}{" "}
            <b className="text-base" style={{ color: tono.fuerte }}>
              {Math.round(pct)}%
            </b>
          </span>
          <span className="opacity-80">de {fmtMoney(p.monto)}</span>
        </div>
        <div
          className="relative mt-1.5 flex h-4 w-full overflow-hidden rounded-full bg-white"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-label="Consumo del presupuesto"
        >
          <div
            style={{ width: w(ejercidoOtros), background: COLOR_EJERCIDO }}
            title="Ya ejercido"
          />
          <div
            style={{
              width: w(esteFolio),
              background: tono.fuerte,
              backgroundImage: abierto
                ? "repeating-linear-gradient(45deg, rgba(255,255,255,.35) 0 6px, transparent 6px 12px)"
                : undefined,
            }}
            title="Este folio"
          />
          {usadoTotal > p.monto && (
            <div
              className="absolute inset-y-0 w-0.5"
              style={{ left: `${limite}%`, background: "#111827" }}
              title="Límite de la bolsa"
            />
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          <Leyenda color={COLOR_EJERCIDO} texto={`Ejercido ${fmtMoney(ejercidoOtros)}`} />
          <Leyenda
            color={tono.fuerte}
            rayado={abierto}
            texto={`${abierto ? "Este folio" : "Este folio (ya descontado)"} ${fmtMoney(esteFolio)}`}
          />
          <Leyenda color="#FFFFFF" borde texto={`Libre ${fmtMoney(libre)}`} />
        </div>
      </div>

      {/* Cifras */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Cifra titulo="Asignado" valor={fmtMoney(p.monto)} />
        <Cifra
          titulo="Ejercido"
          valor={fmtMoney(ejercidoOtros)}
          sub={`${p.folios_autorizados} folio(s)`}
        />
        <Cifra titulo="Este folio" valor={fmtMoney(esteFolio)} color={tono.fuerte} />
        <Cifra
          titulo={abierto ? "Disponible después" : "Disponible"}
          valor={fmtMoney(restante)}
          color={restante < 0 ? TONOS.excede.fuerte : tono.texto}
          destacado
        />
      </div>

      {/* Mensaje */}
      <div className="mt-3 flex items-start gap-2 text-xs">
        {evaluacion.bloqueo ? (
          <Lock size={14} className="mt-0.5 shrink-0" />
        ) : evaluacion.excede ? (
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        ) : (
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
        )}
        <span className="font-medium">{evaluacion.bloqueo ?? evaluacion.mensaje}</span>
      </div>
      {abierto && p.folios_por_autorizar > 1 && (
        <div className="mt-1 pl-[22px] text-[11px] opacity-75">
          Hay {p.folios_por_autorizar} folios pendientes de autorizar en esta bolsa (incluido este)
          por {fmtMoney(p.por_autorizar)}.
        </div>
      )}
    </div>
  );
}

function Encabezado({
  departamento,
  tono,
  bloqueado,
  periodo,
}: {
  departamento: string | null;
  tono: (typeof TONOS)[keyof typeof TONOS];
  bloqueado: boolean;
  periodo?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full text-white"
          style={{ background: tono.fuerte }}
        >
          <PiggyBank size={16} />
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight">
            Presupuesto {departamento ? `de ${departamento}` : "del departamento"}
          </div>
          {periodo && <div className="text-[11px] opacity-75">Periodo {periodo}</div>}
        </div>
      </div>
      <span
        className="ckl-badge"
        style={{ background: tono.fuerte, color: "white", fontSize: 12, padding: "3px 10px" }}
      >
        {bloqueado ? "Bloqueado" : tono.etiqueta}
      </span>
    </div>
  );
}

function Cifra({
  titulo,
  valor,
  sub,
  color,
  destacado,
}: {
  titulo: string;
  valor: string;
  sub?: string;
  color?: string;
  destacado?: boolean;
}) {
  return (
    <div
      className="rounded-md bg-white p-2.5"
      style={destacado ? { boxShadow: `inset 0 0 0 2px ${color ?? "transparent"}` } : undefined}
    >
      <div className="text-[11px] opacity-75">{titulo}</div>
      <div className="text-base font-semibold leading-tight" style={{ color }}>
        {valor}
      </div>
      {sub && <div className="text-[10px] opacity-60">{sub}</div>}
    </div>
  );
}

function Leyenda({
  color,
  texto,
  rayado,
  borde,
}: {
  color: string;
  texto: string;
  rayado?: boolean;
  borde?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-2.5 rounded-sm"
        style={{
          background: color,
          backgroundImage: rayado
            ? "repeating-linear-gradient(45deg, rgba(255,255,255,.45) 0 2px, transparent 2px 4px)"
            : undefined,
          border: borde ? "1px solid #94A3B8" : undefined,
        }}
      />
      {texto}
    </span>
  );
}
