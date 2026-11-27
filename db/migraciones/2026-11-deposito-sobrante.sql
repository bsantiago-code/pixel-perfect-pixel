-- =====================================================================================
-- Migración: Depósito sobrante (ficha de depósito)             (MySQL 8.4)
--
-- Qué hace:
--   1. depositos_sobrante  → un registro por ficha de depósito (monto + archivo) de un folio. Suma al viático
--                            comprobado del folio (aún sin acción a SAP).
--   2. deposito_archivos   → contenido en BD de la ficha (solo con STORAGE_DRIVER=db), igual que factura_archivos.
--   3. sp_folios_sin_comprobar / sp_recalcular_comprobacion → incluyen los depósitos en lo comprobado.
--
-- Requiere el modelo por folio (migraciones autorizaciones-folio y folio-en-tablas-relacionadas): solicitud_id = folio.
--
-- Es IDEMPOTENTE: se puede ejecutar varias veces; no borra datos.
--
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-deposito-sobrante.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

CREATE TABLE IF NOT EXISTS depositos_sobrante (
  id            VARCHAR(40)   NOT NULL,
  solicitud_id  VARCHAR(10)   NOT NULL COMMENT 'Folio de la solicitud (solicitudes.folio)',
  monto         DECIMAL(12,2) NOT NULL,
  archivo       VARCHAR(255)  NOT NULL,
  ruta          VARCHAR(500)  NULL COMMENT 'Archivo en almacenamiento externo: drive:<fileId> o local:<ruta>. NULL = el contenido está en deposito_archivos',
  creado_por    VARCHAR(40)   NULL,
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_depositos_solicitud (solicitud_id),
  CONSTRAINT fk_dep_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_dep_usuario   FOREIGN KEY (creado_por)   REFERENCES usuarios (id)    ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Fichas de depósito del sobrante de viáticos; suman al comprobado del folio';

CREATE TABLE IF NOT EXISTS deposito_archivos (
  deposito_id VARCHAR(40)  NOT NULL,
  mime        VARCHAR(100) NOT NULL,
  contenido   LONGBLOB     NOT NULL,
  PRIMARY KEY (deposito_id),
  CONSTRAINT fk_darch_deposito FOREIGN KEY (deposito_id) REFERENCES depositos_sobrante (id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Contenido en BD (solo con STORAGE_DRIVER=db); con Drive/carpeta local no hay fila aquí';


-- Si la tabla se creó con una versión anterior de esta migración (solicitud_id = id interno), se convierte al folio.
SET @viejo := (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'depositos_sobrante' AND COLUMN_NAME = 'solicitud_id' AND CHARACTER_MAXIMUM_LENGTH > 10);
SET @sql := IF(@viejo > 0, 'ALTER TABLE depositos_sobrante DROP FOREIGN KEY fk_dep_solicitud', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SET @sql := IF(@viejo > 0, 'UPDATE depositos_sobrante t JOIN solicitudes s ON s.id = t.solicitud_id SET t.solicitud_id = s.folio', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SET @sql := IF(@viejo > 0, 'ALTER TABLE depositos_sobrante MODIFY COLUMN solicitud_id VARCHAR(10) NOT NULL COMMENT ''Folio de la solicitud (solicitudes.folio)''', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SET @sql := IF(@viejo > 0, 'ALTER TABLE depositos_sobrante ADD CONSTRAINT fk_dep_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

DELIMITER $$

DROP PROCEDURE IF EXISTS sp_recalcular_comprobacion$$
DROP PROCEDURE IF EXISTS sp_folios_sin_comprobar$$
-- Equivale a avanceComprobacion(): p_solo_avion = 1 limita el cálculo al concepto "Avión" (gestor de vuelos);
-- los depósitos sobrantes del folio suman al comprobado (no aplican con p_solo_avion).
CREATE PROCEDURE sp_recalcular_comprobacion(IN p_solicitud_id VARCHAR(40), IN p_solo_avion TINYINT(1))
BEGIN
  DECLARE v_folio VARCHAR(10);
  DECLARE v_dep DECIMAL(12,2) DEFAULT 0;
  SELECT folio INTO v_folio FROM solicitudes WHERE id = p_solicitud_id;
  IF p_solo_avion = 0 THEN
    SELECT COALESCE(SUM(monto), 0) INTO v_dep FROM depositos_sobrante WHERE solicitud_id = v_folio;
  END IF;

  SELECT v_folio AS solicitud_id,
         COALESCE(SUM(monto_solicitado), 0) AS solicitado,
         COALESCE(SUM(monto_comprobado), 0) + v_dep AS comprobado,
         (COALESCE(SUM(monto_solicitado), 0) > 0
            AND COALESCE(SUM(monto_comprobado), 0) + v_dep = COALESCE(SUM(monto_solicitado), 0)) AS completo,
         CASE WHEN COALESCE(SUM(monto_solicitado), 0) > 0
              THEN LEAST(100, ROUND((SUM(monto_comprobado) + v_dep) / SUM(monto_solicitado) * 100))
              ELSE 0 END AS pct
    FROM comprobantes_gasto
   WHERE solicitud_id = v_folio
     AND (p_solo_avion = 0 OR concepto = 'Avión');
END$$

-- Folios Cerrado del usuario sin comprobar por completo (depósitos sobrantes incluidos en lo comprobado). Si hay
-- 2 o más (MAX_FOLIOS_SIN_COMPROBAR) no puede generar una nueva solicitud: bloquea_nueva_solicitud = 1.
CREATE PROCEDURE sp_folios_sin_comprobar(IN p_user_id VARCHAR(40))
BEGIN
  SELECT t.id, t.folio, t.monto_total, t.solicitado, t.comprobado,
         (COUNT(*) OVER () >= 2) AS bloquea_nueva_solicitud
    FROM (
      SELECT s.id, s.folio, s.monto_total,
             COALESCE(SUM(c.monto_solicitado), 0) AS solicitado,
             COALESCE(SUM(c.monto_comprobado), 0)
               + COALESCE((SELECT SUM(d.monto) FROM depositos_sobrante d WHERE d.solicitud_id = s.folio), 0) AS comprobado
        FROM solicitudes s
        LEFT JOIN comprobantes_gasto c ON c.solicitud_id = s.folio
       WHERE s.user_id = p_user_id AND s.estatus = 'Cerrado'
       GROUP BY s.id, s.folio, s.monto_total
    ) t
   WHERE NOT (t.solicitado > 0 AND t.comprobado = t.solicitado)
   ORDER BY t.folio;
END$$

DELIMITER ;

-- Verificación rápida:
--   SHOW CREATE TABLE depositos_sobrante;
--   CALL sp_folios_sin_comprobar('<id de usuario>');
