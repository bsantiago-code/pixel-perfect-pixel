// Uso:  npm run smtp:configurar -- [--servidor=smtp.gmail.com] [--puerto=587] [--cifrado=TLS|SSL]
//                                  [--usuario=smtp@cklass.com] [--remitente="Nombre visible"] [--probar=correo@dominio]
//
// Deja configurado el servidor SMTP del portal (Configuración → Parámetros SMTP) en la base que apunte .env.local.
// Es lo mismo que capturar los datos en la pantalla, para que todo el equipo tenga la misma configuración.
//
// La CONTRASEÑA nunca va en este archivo ni en git: se toma de la variable de entorno SMTP_PASSWORD o se pide al
// ejecutar. Se guarda cifrada (AES-256-GCM) con la APP_SECRET de TU .env.local, por eso cada persona debe correr el
// script en su máquina (un valor cifrado por otra persona no se podría descifrar aquí).
//   PowerShell:  $env:SMTP_PASSWORD = "xxxx xxxx xxxx xxxx"; npm run smtp:configurar
//   bash:        SMTP_PASSWORD="xxxx xxxx xxxx xxxx" npm run smtp:configurar
//
// Valores por omisión: Gmail (smtp.gmail.com, 587, TLS) con el usuario smtp@cklass.com. Gmail pide una "contraseña de
// aplicación" (Cuenta de Google → Seguridad → Verificación en 2 pasos → Contraseñas de aplicaciones).
// Es idempotente: se puede correr las veces que haga falta.
import process from "node:process";
import { createInterface } from "node:readline";

import { exec, getPool } from "../server/db.ts";
import { enviarCorreo, limpiarNombre, type SmtpCfg } from "../server/services/correo.ts";
import { cifrarSecreto, hayLlave } from "../server/secretos.ts";

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const i = a.indexOf("=");
      return i < 0 ? [a.slice(2), "true"] : [a.slice(2, i), a.slice(i + 1)];
    }),
);

const servidor = (args.get("servidor") ?? "smtp.gmail.com").trim();
const puerto = Number(args.get("puerto") ?? 587);
const cifrado = (args.get("cifrado") ?? "TLS").trim().toUpperCase();
const usuario = (args.get("usuario") ?? "smtp@cklass.com").trim();
const remitente = limpiarNombre(args.get("remitente") ?? "");
const probar = args.get("probar")?.trim();

function salir(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

if (!servidor) salir("Falta el servidor SMTP (--servidor=).");
if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) salir("El puerto debe ser un número entre 1 y 65535.");
if (cifrado !== "TLS" && cifrado !== "SSL") salir('La seguridad debe ser "TLS" (STARTTLS) o "SSL" (conexión directa).');
if (!usuario.includes("@")) salir("El usuario SMTP debe ser un correo electrónico (es también la dirección de salida).");
if (!hayLlave()) salir("Falta APP_SECRET en .env.local (mínimo 16 caracteres); sin ella no se puede cifrar la contraseña.");
if (cifrado === "SSL" && puerto === 587) {
  console.warn("⚠ SSL con el puerto 587 no funciona en Gmail: 587 usa STARTTLS (--cifrado=TLS) y SSL va con el 465.");
}
if (cifrado === "TLS" && puerto === 465) {
  console.warn("⚠ TLS con el puerto 465 no funciona en Gmail: 465 usa SSL (--cifrado=SSL) y STARTTLS va con el 587.");
}

async function pedirPassword(): Promise<string> {
  const deEntorno = process.env.SMTP_PASSWORD?.trim();
  if (deEntorno) return deEntorno;
  if (!process.stdin.isTTY) salir("Define SMTP_PASSWORD (o ejecuta el script en una terminal para que la pida).");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`Contraseña SMTP de ${usuario} (de aplicación, se guarda cifrada): `, (r) => {
      rl.close();
      resolve(r.trim());
    });
  });
}

const password = await pedirPassword();
if (!password) salir("La contraseña SMTP no puede estar vacía.");

const valores: [string, unknown][] = [
  ["smtp_servidor", servidor],
  ["smtp_puerto", puerto],
  ["smtp_usuario", usuario],
  ["smtp_password", cifrarSecreto(password)], // enc:v1:… nunca en claro
  ["smtp_cifrado", cifrado],
  ["smtp_remitente", remitente],
];

try {
  for (const [clave, valor] of valores) {
    await exec(
      "INSERT INTO configuracion (clave, valor) VALUES (?, CAST(? AS JSON)) ON DUPLICATE KEY UPDATE valor = VALUES(valor)",
      [clave, JSON.stringify(valor)],
    );
  }
  // Bitácora sin la contraseña.
  await getPool().query("CALL sp_registrar_log(?, ?, ?, ?, ?)", [
    "config_smtp", "config", "smtp", null, JSON.stringify({ servidor, puerto, cifrado, usuario, remitente, origen: "script smtp:configurar" }),
  ]);
} catch (e) {
  salir(`No se pudo guardar en la base de datos: ${e instanceof Error ? e.message : String(e)}`);
}

console.log(`✔ SMTP configurado: ${usuario} vía ${servidor}:${puerto} (${cifrado}). Contraseña guardada cifrada.`);

if (probar) {
  const cfg: SmtpCfg = { servidor, puerto, usuario, password, cifrado, remitente };
  try {
    const r = await enviarCorreo(
      {
        para: probar,
        asunto: "Correo de prueba — Portal de Viáticos CKL",
        cuerpo: "Este es un correo de prueba enviado por el script smtp:configurar.\n\nSi lo recibes, la configuración SMTP funciona.",
      },
      cfg,
    );
    console.log(`✔ Correo de prueba aceptado por el servidor (de ${typeof r.remitente === "string" ? r.remitente : usuario} a ${probar}).`);
  } catch (e) {
    console.error(`✖ La configuración se guardó, pero el envío de prueba falló: ${e instanceof Error ? e.message : String(e)}`);
    await getPool().end();
    process.exit(2);
  }
}
await getPool().end();
