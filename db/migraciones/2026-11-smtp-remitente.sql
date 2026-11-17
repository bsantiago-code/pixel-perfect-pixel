-- =====================================================================================
-- Migración: Remitente SMTP + envío real de correos            (MySQL 8.4)
--
-- Qué hace:
--   1. correos.estado    → agrega los estados 'pendiente', 'enviado' y 'error'
--                          (antes solo 'simulado' y 'omitido').
--   2. correos.remitente → "Nombre" <correo> con el que salió el correo.
--   3. correos.detalle_error → motivo cuando el envío falla.
--   4. configuracion     → clave 'smtp_remitente' (nombre visible en los correos, opcional).
--
-- Es IDEMPOTENTE: se puede ejecutar varias veces; no borra datos ni pisa un remitente ya guardado.
-- Úsalo en bases que ya existen (con `npm run db:setup` no hace falta: schema.sql ya lo incluye,
-- pero db:setup BORRA todo).
--
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-smtp-remitente.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

-- 1. Nuevos estados (MODIFY es repetible sin efecto si ya están).
ALTER TABLE correos
  MODIFY COLUMN estado ENUM('simulado','omitido','pendiente','enviado','error') NOT NULL DEFAULT 'simulado'
  COMMENT 'simulado: sin servidor SMTP · omitido: correos desactivados · pendiente → enviado | error';

-- 2. correos.remitente (solo si falta; MySQL no soporta ADD COLUMN IF NOT EXISTS).
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'correos' AND COLUMN_NAME = 'remitente') = 0,
  'ALTER TABLE correos ADD COLUMN remitente VARCHAR(200) NULL COMMENT ''"Nombre" <correo> con el que salió (solo enviados)'' AFTER estado',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. correos.detalle_error (solo si falta).
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'correos' AND COLUMN_NAME = 'detalle_error') = 0,
  'ALTER TABLE correos ADD COLUMN detalle_error VARCHAR(500) NULL COMMENT ''motivo cuando estado = error'' AFTER remitente',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE correos COMMENT = 'Cada correo del portal queda registrado aquí (envío real por SMTP o simulado)';

-- 4. Parámetro nuevo (no pisa un valor ya capturado).
INSERT INTO configuracion (clave, valor) VALUES ('smtp_remitente', '""')
  ON DUPLICATE KEY UPDATE clave = clave;

-- Verificación rápida:
--   DESCRIBE correos;
--   SELECT clave, valor FROM configuracion WHERE clave = 'smtp_remitente';
