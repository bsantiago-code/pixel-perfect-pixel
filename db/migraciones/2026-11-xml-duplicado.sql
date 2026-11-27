-- =====================================================================================
-- Migración: Una misma factura (XML) no se puede comprobar dos veces            (MySQL 8.4)
--
-- Qué hace:
--   1. facturas.uuid_xml → columna calculada: el UUID fiscal solo en las filas tipo XML (NULL en PDF/foto).
--   2. uq_facturas_uuid_xml → índice único sobre esa columna: la base rechaza un segundo XML con el mismo UUID
--      en cualquier solicitud (la API ya lo valida antes; esto cubre cargas simultáneas).
--
-- Es IDEMPOTENTE: se puede ejecutar varias veces; no borra datos.
-- Si ya hubiera XML repetidos en la base, NO crea el índice y muestra cuáles son para revisarlos a mano.
-- Úsalo en bases que ya existen (con `npm run db:setup` no hace falta: schema.sql ya lo incluye,
-- pero db:setup BORRA todo).
--
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-xml-duplicado.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

-- 1. Columna calculada (solo si falta).
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facturas' AND COLUMN_NAME = 'uuid_xml') = 0,
  'ALTER TABLE facturas ADD COLUMN uuid_xml VARCHAR(60) GENERATED ALWAYS AS (IF(tipo = ''XML'' AND uuid <> '''', uuid, NULL)) VIRTUAL COMMENT ''UUID fiscal solo en los XML: el índice único impide comprobar dos veces la misma factura''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- XML repetidos que ya existan (si aparece alguna fila, el índice no se crea).
SELECT f.uuid_xml AS uuid_repetido, COUNT(*) AS veces, GROUP_CONCAT(s.folio ORDER BY s.folio) AS folios
  FROM facturas f JOIN solicitudes s ON s.folio = f.solicitud_id
 WHERE f.uuid_xml IS NOT NULL
 GROUP BY f.uuid_xml
HAVING COUNT(*) > 1;

-- 2. Índice único (solo si falta y no hay repetidos).
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facturas' AND INDEX_NAME = 'uq_facturas_uuid_xml') = 0
  AND (SELECT COUNT(*) FROM (SELECT uuid_xml FROM facturas WHERE uuid_xml IS NOT NULL
                              GROUP BY uuid_xml HAVING COUNT(*) > 1) d) = 0,
  'ALTER TABLE facturas ADD UNIQUE KEY uq_facturas_uuid_xml (uuid_xml)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Verificación rápida:
--   SHOW INDEX FROM facturas WHERE Key_name = 'uq_facturas_uuid_xml';
