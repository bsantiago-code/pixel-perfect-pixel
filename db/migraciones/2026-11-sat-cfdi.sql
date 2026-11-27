-- =====================================================================================
-- Migración: Verificación de CFDI ante el SAT                  (MySQL 8.4)
--
-- Qué hace:
--   1. facturas.sat_estado        → estado del CFDI ante el SAT al subirlo (Vigente | Pendiente).
--   2. facturas.sat_verificado_en → cuándo se consultó.
--   3. configuracion              → clave 'sat_validacion_activa' (interruptor en Configuración).
--
-- Es IDEMPOTENTE: se puede ejecutar varias veces; no borra datos ni pisa el interruptor ya guardado.
--
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-sat-cfdi.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facturas' AND COLUMN_NAME = 'sat_estado') = 0,
  'ALTER TABLE facturas ADD COLUMN sat_estado VARCHAR(20) NULL COMMENT ''Estado del CFDI ante el SAT al subirlo (XML): Vigente | Pendiente (SAT sin respuesta) | NULL (no consultado)'' AFTER ruta',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facturas' AND COLUMN_NAME = 'sat_verificado_en') = 0,
  'ALTER TABLE facturas ADD COLUMN sat_verificado_en DATETIME NULL COMMENT ''Cuándo se consultó al SAT'' AFTER sat_estado',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO configuracion (clave, valor) VALUES ('sat_validacion_activa', 'true')
  ON DUPLICATE KEY UPDATE clave = clave;

-- Verificación rápida:
--   DESCRIBE facturas;
--   SELECT clave, valor FROM configuracion WHERE clave = 'sat_validacion_activa';
