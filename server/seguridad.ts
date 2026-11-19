// Al arrancar la API: deja todo secreto guardado en la base cifrado, aunque venga de datos antiguos
// (contraseñas demo en claro, contraseña SMTP en claro, códigos de recuperación sin huella).
// Es idempotente: si no hay nada pendiente no toca nada.
import process from "node:process";

import { hashPassword } from "./auth.ts";
import { exec, rows } from "./db.ts";
import { cifrarSecreto, esCifrado, hayLlave } from "./secretos.ts";

export function exigirLlave() {
  if (!hayLlave()) {
    console.error(
      "Falta APP_SECRET en .env.local (mínimo 16 caracteres). Se usa para cifrar la contraseña SMTP.\n" +
        "Corre `npm run dev:all` (la genera sola) o agrega una línea APP_SECRET=<texto largo y aleatorio>; ver .env.example.",
    );
    process.exit(1);
  }
}

export async function cifrarSecretosPendientes() {
  let n = 0;
  for (const tabla of ["usuarios", "prealtas"] as const) {
    const pendientes = await rows<{ id: string; password: string }>(
      `SELECT id, password FROM ${tabla} WHERE password NOT LIKE 'scrypt$%'`,
    );
    for (const p of pendientes) {
      await exec(`UPDATE ${tabla} SET password = ? WHERE id = ?`, [await hashPassword(p.password), p.id]);
      n++;
    }
  }

  const smtp = await rows<{ valor: unknown }>("SELECT valor FROM configuracion WHERE clave = 'smtp_password'");
  const valor = smtp[0]?.valor;
  if (typeof valor === "string" && valor !== "" && !esCifrado(valor)) {
    await exec("UPDATE configuracion SET valor = CAST(? AS JSON) WHERE clave = 'smtp_password'", [
      JSON.stringify(cifrarSecreto(valor)),
    ]);
    n++;
  }

  // Códigos de recuperación antiguos (6 dígitos en claro): son temporales, se invalidan.
  const codigos = await exec("DELETE FROM reset_codes WHERE CHAR_LENGTH(code) <= 10");
  n += codigos.affectedRows;

  if (n) console.log(`Seguridad: ${n} secreto(s) antiguo(s) cifrados o invalidados.`);
}
