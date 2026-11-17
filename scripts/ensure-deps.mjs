// Se ejecuta solo antes de `npm run dev:all` (hook predev:all).
// Instala las dependencias si faltan o si package-lock.json cambió, y avisa si falta .env.local.
// Solo usa módulos internos de Node: corre antes de que exista node_modules.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import process from "node:process";

const falta = !existsSync("node_modules/.bin/concurrently") && !existsSync("node_modules/.bin/concurrently.cmd");
const lockViejo =
  existsSync("node_modules/.package-lock.json") &&
  statSync("package-lock.json").mtimeMs > statSync("node_modules/.package-lock.json").mtimeMs;

if (falta || lockViejo) {
  console.log("Instalando dependencias (npm install)...");
  const r = spawnSync("npm install", { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error("No se pudieron instalar las dependencias. Revisa el error de arriba.");
    process.exit(1);
  }
}

if (!existsSync(".env.local")) {
  console.error("Falta .env.local. Copia .env.example a .env.local y escribe tu contraseña de MySQL.");
  process.exit(1);
}

// APP_SECRET cifra la contraseña SMTP guardada en la base (AES-256-GCM). Vive solo en .env.local, nunca en
// la base ni en git. Si falta se genera una; si se pierde o cambia, hay que volver a capturar la contraseña SMTP.
const env = readFileSync(".env.local", "utf8");
if (!/^APP_SECRET=.{16,}/m.test(env)) {
  const sep = env.endsWith("\n") || env === "" ? "" : "\n";
  appendFileSync(
    ".env.local",
    `${sep}\n# Llave para cifrar la contraseña SMTP en la base (no la compartas ni la subas a git)\nAPP_SECRET=${randomBytes(32).toString("hex")}\n`,
  );
  console.log("Se generó APP_SECRET en .env.local (cifra la contraseña SMTP guardada en la base).");
}
