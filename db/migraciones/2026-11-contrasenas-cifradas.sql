-- =====================================================================================
-- Migración: contraseñas y secretos cifrados en la base                 (MySQL 8.4)
--
-- Qué hace (solo estructura; los valores se convierten solos al arrancar la API):
--   1. reset_codes.code  → VARCHAR(64): ahora guarda la huella HMAC-SHA256 del código de
--                          recuperación en lugar del código de 6 dígitos en claro.
--   2. Invalida los códigos de recuperación antiguos (en claro, temporales de 10 minutos).
--   3. usuarios.password / prealtas.password → solo se actualiza el comentario (ya eran VARCHAR(255)).
--
-- Lo que NO está aquí (lo hace la API al arrancar, `server/seguridad.ts`, de forma idempotente):
--   · Contraseñas de usuarios o pre-altas que sigan en claro  → hash scrypt.
--   · Contraseña SMTP en claro (configuracion.smtp_password)  → AES-256-GCM con APP_SECRET.
--
-- REQUISITO: cada entorno necesita APP_SECRET en su .env.local (mínimo 16 caracteres).
-- `npm run dev:all` la genera sola si falta. Si cambia, hay que volver a capturar la contraseña SMTP.
--
-- Es IDEMPOTENTE. Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-contrasenas-cifradas.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

-- 2. Antes de ensanchar la columna: los códigos en claro dejan de servir.
DELETE FROM reset_codes WHERE CHAR_LENGTH(code) <= 10;

-- 1. Huella del código de recuperación.
ALTER TABLE reset_codes
  MODIFY COLUMN code VARCHAR(64) NOT NULL
  COMMENT 'HMAC-SHA256 del código de 6 dígitos (el código en claro no se guarda)';

-- 3. Comentarios de las contraseñas de usuarios y pre-altas.
ALTER TABLE usuarios
  MODIFY COLUMN password VARCHAR(255) NOT NULL COMMENT 'Hash scrypt (scrypt$salt$hash); nunca en claro';
ALTER TABLE prealtas
  MODIFY COLUMN password VARCHAR(255) NOT NULL COMMENT 'Hash scrypt (scrypt$salt$hash); nunca en claro';

-- Verificación rápida (después de arrancar la API una vez; no debe devolver filas):
--   SELECT id FROM usuarios WHERE password NOT LIKE 'scrypt$%';
--   SELECT id FROM prealtas WHERE password NOT LIKE 'scrypt$%';
--   SELECT valor FROM configuracion WHERE clave = 'smtp_password';   -- vacío o 'enc:v1:...'
