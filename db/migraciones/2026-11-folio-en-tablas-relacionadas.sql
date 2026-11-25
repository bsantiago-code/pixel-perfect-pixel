-- =====================================================================================
-- Migración: solicitud_id = FOLIO en las tablas relacionadas + llave de comprobantes_gasto   (MySQL 8.x)
--
-- Qué hace:
--   1. comprobantes_gasto : se elimina `id`; llave primaria (solicitud_id, concepto); solicitud_id guarda el
--                           FOLIO (solicitudes.folio, p. ej. #0040). `seq` se conserva (orden de captura).
--   2. facturas           : concepto_id → concepto; solicitud_id pasa a folio; la FK al renglón es compuesta
--                           (solicitud_id, concepto) → comprobantes_gasto.
--   3. solicitud_destinos, notas, revisiones_monto, compensaciones : solicitud_id pasa de id interno (s2)
--                           a folio (#0040); sus FK apuntan a solicitudes.folio. Conservan su propio id.
--   4. compensaciones     : se crea si no existe (bases creadas con un schema.sql anterior no la tienen).
--   5. Triggers de facturas, sp_autorizar_solicitud, sp_recalcular_comprobacion, sp_folios_sin_comprobar y la
--      vista v_renglones_gasto se vuelven a crear para usar el folio.
--
-- Es IDEMPOTENTE: cada paso se salta si la tabla ya tiene la forma nueva. No borra datos. Se detiene ANTES de
-- cambiar nada si hubiera dos renglones del mismo concepto en un folio (la llave nueva no lo permite).
-- Requiere la migración 2026-11-autorizaciones-folio.sql (autorizaciones ya usa el folio).
--
-- Ejecución (respalda antes: mysqldump portal_viaticos > respaldo.sql):
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-folio-en-tablas-relacionadas.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

-- ── Estado actual de cada tabla ───────────────────────────────────────────────────────
SET @cg_viejo := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comprobantes_gasto' AND COLUMN_NAME = 'id');
SET @fa_cid := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facturas' AND COLUMN_NAME = 'concepto_id');
SET @fa_sol := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'facturas' AND COLUMN_NAME = 'solicitud_id' AND CHARACTER_MAXIMUM_LENGTH > 10);
SET @de_sol := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'solicitud_destinos' AND COLUMN_NAME = 'solicitud_id' AND CHARACTER_MAXIMUM_LENGTH > 10);
SET @no_sol := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notas' AND COLUMN_NAME = 'solicitud_id' AND CHARACTER_MAXIMUM_LENGTH > 10);
SET @re_sol := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'revisiones_monto' AND COLUMN_NAME = 'solicitud_id' AND CHARACTER_MAXIMUM_LENGTH > 10);
SET @co_sol := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'compensaciones' AND COLUMN_NAME = 'solicitud_id' AND CHARACTER_MAXIMUM_LENGTH > 10);
SET @cg_sol := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comprobantes_gasto' AND COLUMN_NAME = 'solicitud_id' AND CHARACTER_MAXIMUM_LENGTH > 10);

-- ── Verificaciones previas (abortan sin cambiar nada) ──────────────────────────────────
SET @choques := IF(@cg_viejo = 0, 0, (SELECT COUNT(*) FROM (SELECT 1 FROM comprobantes_gasto GROUP BY solicitud_id, concepto HAVING COUNT(*) > 1) x));
SET @sql := IF(@choques > 0, 'SELECT 1 FROM `ERROR_renglones_con_concepto_repetido_en_un_folio`', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@fa_cid > 0 AND @cg_viejo > 0, 'SET @cruzadas := (SELECT COUNT(*) FROM facturas f JOIN comprobantes_gasto c ON c.id = f.concepto_id WHERE c.solicitud_id <> f.solicitud_id)', 'SET @cruzadas := 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SET @sql := IF(@cruzadas > 0, 'SELECT 1 FROM `ERROR_facturas_ligadas_a_un_renglon_de_otro_folio`', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- Los triggers de facturas se recrean al final (mientras tanto no deben mirar columnas que cambian).
DROP TRIGGER IF EXISTS trg_facturas_ai;
DROP TRIGGER IF EXISTS trg_facturas_ad;

-- ── 1. facturas: concepto (texto) a partir del renglón al que apuntaba ─────────────────
SET @sql := IF(@fa_cid > 0, 'ALTER TABLE facturas ADD COLUMN concepto VARCHAR(60) NULL COMMENT ''Renglón de comprobación (solicitud_id + concepto) al que se aplicó el monto'' AFTER status', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@fa_cid > 0, 'UPDATE facturas f JOIN comprobantes_gasto c ON c.id = f.concepto_id SET f.concepto = c.concepto', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@fa_cid > 0, 'ALTER TABLE facturas DROP FOREIGN KEY fk_facturas_concepto', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 2. Se sueltan las FK que apuntaban a solicitudes.id ────────────────────────────────
SET @sql := IF(@fa_sol > 0, 'ALTER TABLE facturas DROP FOREIGN KEY fk_facturas_solicitud', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@cg_sol > 0, 'ALTER TABLE comprobantes_gasto DROP FOREIGN KEY fk_cg_solicitud', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@de_sol > 0, 'ALTER TABLE solicitud_destinos DROP FOREIGN KEY fk_destinos_solicitud', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@no_sol > 0, 'ALTER TABLE notas DROP FOREIGN KEY fk_notas_solicitud', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@re_sol > 0, 'ALTER TABLE revisiones_monto DROP FOREIGN KEY fk_rev_solicitud', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@co_sol > 0, 'ALTER TABLE compensaciones DROP FOREIGN KEY fk_comp_solicitud', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 3. solicitud_id: de id interno (s2) a folio (#0040) ────────────────────────────────
SET @sql := IF(@fa_sol > 0, 'UPDATE facturas t JOIN solicitudes s ON s.id = t.solicitud_id SET t.solicitud_id = s.folio', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@cg_sol > 0, 'UPDATE comprobantes_gasto t JOIN solicitudes s ON s.id = t.solicitud_id SET t.solicitud_id = s.folio', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@de_sol > 0, 'UPDATE solicitud_destinos t JOIN solicitudes s ON s.id = t.solicitud_id SET t.solicitud_id = s.folio', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@no_sol > 0, 'UPDATE notas t JOIN solicitudes s ON s.id = t.solicitud_id SET t.solicitud_id = s.folio', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@re_sol > 0, 'UPDATE revisiones_monto t JOIN solicitudes s ON s.id = t.solicitud_id SET t.solicitud_id = s.folio', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@co_sol > 0, 'UPDATE compensaciones t JOIN solicitudes s ON s.id = t.solicitud_id SET t.solicitud_id = s.folio', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 4. comprobantes_gasto: sin id; llave (solicitud_id, concepto) ──────────────────────
SET @sql := IF(@cg_viejo > 0, 'ALTER TABLE comprobantes_gasto DROP PRIMARY KEY, DROP COLUMN id, DROP INDEX ix_cg_solicitud, MODIFY COLUMN solicitud_id VARCHAR(10) NOT NULL COMMENT ''Folio de la solicitud (solicitudes.folio, p. ej. #0040)'' FIRST, MODIFY COLUMN concepto VARCHAR(60) NOT NULL COMMENT ''Hotel, Avión, Uber, Comida, Vales, Caseta…'' AFTER solicitud_id, MODIFY COLUMN seq BIGINT NOT NULL AUTO_INCREMENT COMMENT ''Orden de captura de los renglones'' AFTER concepto, ADD PRIMARY KEY (solicitud_id, concepto), ADD CONSTRAINT fk_cg_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE, COMMENT = ''Un renglón por concepto de cada folio: la llave es folio + concepto''', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 5. facturas: folio + FK compuesta al renglón ───────────────────────────────────────
SET @sql := IF(@fa_sol > 0, 'ALTER TABLE facturas MODIFY COLUMN solicitud_id VARCHAR(10) NOT NULL COMMENT ''Folio de la solicitud (solicitudes.folio)'', ADD CONSTRAINT fk_facturas_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@fa_cid > 0, 'ALTER TABLE facturas DROP COLUMN concepto_id, ADD KEY ix_facturas_renglon (solicitud_id, concepto), ADD CONSTRAINT fk_facturas_concepto FOREIGN KEY (solicitud_id, concepto) REFERENCES comprobantes_gasto (solicitud_id, concepto) ON DELETE CASCADE ON UPDATE CASCADE', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 6. Resto de tablas: solicitud_id = folio ───────────────────────────────────────────
SET @sql := IF(@de_sol > 0, 'ALTER TABLE solicitud_destinos MODIFY COLUMN solicitud_id VARCHAR(10) NOT NULL COMMENT ''Folio de la solicitud (solicitudes.folio)'', ADD CONSTRAINT fk_destinos_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@no_sol > 0, 'ALTER TABLE notas MODIFY COLUMN solicitud_id VARCHAR(10) NOT NULL COMMENT ''Folio de la solicitud (solicitudes.folio)'', ADD CONSTRAINT fk_notas_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@re_sol > 0, 'ALTER TABLE revisiones_monto MODIFY COLUMN solicitud_id VARCHAR(10) NOT NULL COMMENT ''Folio de la solicitud (solicitudes.folio)'', ADD CONSTRAINT fk_rev_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@co_sol > 0, 'ALTER TABLE compensaciones MODIFY COLUMN solicitud_id VARCHAR(10) NOT NULL COMMENT ''Folio de la solicitud (solicitudes.folio)'', ADD CONSTRAINT fk_comp_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 7. compensaciones: se crea si la base no la tenía ──────────────────────────────────
CREATE TABLE IF NOT EXISTS compensaciones (
  id               VARCHAR(40)   NOT NULL,
  solicitud_id     VARCHAR(10)   NOT NULL COMMENT 'Folio de la solicitud (solicitudes.folio)',
  decision         ENUM('reembolsar','no_reembolsar','sin_excedente') NOT NULL,
  monto_solicitado DECIMAL(12,2) NOT NULL COMMENT 'Fotografía al compensar',
  monto_comprobado DECIMAL(12,2) NOT NULL COMMENT 'Lo aplicado a los renglones (tope = solicitado)',
  monto_excedente  DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Facturado por encima de lo solicitado',
  monto_reembolso  DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Lo que se le reembolsa al viajero (≤ excedente)',
  comentario       TEXT          NULL,
  compensado_por   VARCHAR(40)   NOT NULL,
  compensado_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_compensacion_solicitud (solicitud_id),
  CONSTRAINT fk_comp_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ── 8. Vista, triggers y rutinas que cambian (mismas definiciones que db/schema.sql) ────
CREATE OR REPLACE VIEW v_renglones_gasto AS
  SELECT s.folio AS solicitud_id, s.folio, s.user_id, s.empresa, DATE(s.created_at) AS created_at,
         CASE
           WHEN c.concepto = 'Hotel' THEN 'Hotel'
           WHEN c.concepto IN ('Avión','Autobús','Tren','Otro (foráneo)','Transporte foráneo') THEN 'Transporte foráneo'
           WHEN c.concepto IN ('Uber','Taxi','Metro','Combi','Otro (transporte local)','Transporte local') THEN 'Transporte local'
           WHEN c.concepto = 'Comida' THEN 'Comida'
           WHEN c.concepto = 'Caseta' THEN 'Automóvil'
           WHEN c.concepto IN ('Vales','Otros') THEN 'Vales'
         END AS categoria,
         CASE WHEN c.concepto = 'Otros' THEN 'Vales' ELSE c.concepto END AS subconcepto,
         c.monto_solicitado AS solicitado,
         c.monto_comprobado AS comprobado
    FROM solicitudes s
    JOIN comprobantes_gasto c ON c.solicitud_id = s.folio
   WHERE s.estatus <> 'Rechazado'
     AND c.monto_solicitado > 0
     AND c.concepto IN ('Hotel','Avión','Autobús','Tren','Otro (foráneo)','Transporte foráneo',
                        'Uber','Taxi','Metro','Combi','Otro (transporte local)','Transporte local',
                        'Comida','Caseta','Vales','Otros')
  UNION ALL
  SELECT s.id, s.folio, s.user_id, s.empresa, DATE(s.created_at),
         'Automóvil', 'Gasolina', SUM(d.gasolina), SUM(d.gasolina)
    FROM solicitudes s
    JOIN solicitud_destinos d ON d.solicitud_id = s.folio
   WHERE s.estatus <> 'Rechazado'
   GROUP BY s.id, s.folio, s.user_id, s.empresa, DATE(s.created_at)
  HAVING SUM(d.gasolina) > 0;

DELIMITER $$

DROP TRIGGER IF EXISTS trg_facturas_ai$$
CREATE TRIGGER trg_facturas_ai AFTER INSERT ON facturas FOR EACH ROW
BEGIN
  IF NEW.concepto IS NOT NULL AND NEW.monto_aplicado <> 0 THEN
    UPDATE comprobantes_gasto
       SET monto_comprobado = monto_comprobado + NEW.monto_aplicado
     WHERE solicitud_id = NEW.solicitud_id AND concepto = NEW.concepto;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_facturas_ad$$
CREATE TRIGGER trg_facturas_ad AFTER DELETE ON facturas FOR EACH ROW
BEGIN
  IF OLD.concepto IS NOT NULL AND OLD.monto_aplicado <> 0 THEN
    UPDATE comprobantes_gasto
       SET monto_comprobado = GREATEST(0, monto_comprobado - OLD.monto_aplicado)
     WHERE solicitud_id = OLD.solicitud_id AND concepto = OLD.concepto;
  END IF;
END$$

DROP PROCEDURE IF EXISTS sp_autorizar_solicitud$$
CREATE PROCEDURE sp_autorizar_solicitud(
  IN p_solicitud_id VARCHAR(40), IN p_user_id VARCHAR(40),
  IN p_decision VARCHAR(12), IN p_nota TEXT)
BEGIN
  DECLARE v_existe INT DEFAULT 0;
  DECLARE v_owner VARCHAR(40);
  DECLARE v_estatus VARCHAR(12);
  DECLARE v_jefe VARCHAR(12);
  DECLARE v_fin VARCHAR(12);
  DECLARE v_monto DECIMAL(12,2);
  DECLARE v_folio VARCHAR(10);
  DECLARE v_lte TINYINT(1) DEFAULT 0;
  DECLARE v_gt TINYINT(1) DEFAULT 0;
  DECLARE v_umbral DECIMAL(12,2) DEFAULT 5000;
  DECLARE v_bloquear TINYINT(1) DEFAULT 0;
  DECLARE v_paso VARCHAR(20) DEFAULT NULL;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  IF p_decision NOT IN ('autorizado', 'rechazado') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La decisión debe ser "autorizado" o "rechazado".';
  END IF;

  START TRANSACTION;

  SELECT COUNT(*) INTO v_existe FROM solicitudes WHERE id = p_solicitud_id;
  IF v_existe = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La solicitud no existe.';
  END IF;

  SELECT user_id, estatus, jefe_status, finanzas_status, monto_total, folio
    INTO v_owner, v_estatus, v_jefe, v_fin, v_monto, v_folio
    FROM solicitudes WHERE id = p_solicitud_id FOR UPDATE;

  SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.permisos, '$.autorizar_lte5000')) = 'true', 0),
         COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.permisos, '$.autorizar_gt5000')) = 'true', 0)
    INTO v_lte, v_gt
    FROM usuarios u JOIN roles r ON r.id = u.rol_id
   WHERE u.id = p_user_id AND u.activo = 1;

  SELECT COALESCE(CAST(JSON_UNQUOTE(valor) AS DECIMAL(12,2)), 5000) INTO v_umbral
    FROM configuracion WHERE clave = 'umbral_finanzas';

  IF v_estatus <> 'Abierto' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La solicitud ya no está abierta.';
  END IF;
  IF v_owner = p_user_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Nadie puede autorizar ni rechazar su propia solicitud.';
  END IF;

  IF v_lte = 1 AND v_jefe = 'Pendiente' THEN
    SET v_paso = 'jefe';
  ELSEIF v_gt = 1 AND v_monto > v_umbral AND v_jefe = 'Autorizado' AND v_fin = 'Pendiente' THEN
    SET v_paso = 'finanzas';
  END IF;
  IF v_paso IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No tienes un paso de autorización pendiente en esta solicitud.';
  END IF;

  IF p_decision = 'rechazado' AND (p_nota IS NULL OR TRIM(p_nota) = '') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Captura el motivo del rechazo.';
  END IF;

  -- Bloqueo por monto manual de hotel (parámetro bloquear_folio_monto_hotel).
  IF p_decision = 'autorizado' THEN
    SELECT COALESCE(JSON_UNQUOTE(valor) = 'true', 0) INTO v_bloquear
      FROM configuracion WHERE clave = 'bloquear_folio_monto_hotel';
    IF v_bloquear = 1 AND EXISTS (SELECT 1 FROM revisiones_monto
                                   WHERE solicitud_id = v_folio AND vigente = 1
                                     AND estado IN ('pendiente', 'rechazado')) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Bloqueado: el monto manual de hotel está pendiente o rechazado por Compras.';
    END IF;
  END IF;

  -- La llave de autorizaciones es (folio, usuario): una persona registra una sola decisión por solicitud.
  IF EXISTS (SELECT 1 FROM autorizaciones WHERE solicitud_id = v_folio AND user_id = p_user_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Ya registraste una decisión en esta solicitud; el siguiente paso lo debe dar otra persona.';
  END IF;

  INSERT INTO autorizaciones (solicitud_id, rol_autorizador, user_id, user_nombre, status, fecha, nota)
  VALUES (v_folio, IF(v_paso = 'jefe', 'jefe_inmediato', 'finanzas'), p_user_id,
          (SELECT nombre FROM usuarios WHERE id = p_user_id), p_decision, CURDATE(),
          COALESCE(IF(p_decision = 'rechazado', p_nota, ''), ''));

  IF p_decision = 'rechazado' THEN
    UPDATE solicitudes
       SET estatus = 'Rechazado', nota_rechazo = p_nota,
           jefe_status = IF(v_paso = 'jefe', 'Rechazado', jefe_status),
           finanzas_status = IF(v_paso = 'finanzas', 'Rechazado', finanzas_status)
     WHERE id = p_solicitud_id;
  ELSEIF v_paso = 'jefe' THEN
    UPDATE solicitudes
       SET jefe_status = 'Autorizado',
           estatus = IF(finanzas_status = 'N/A', 'Cerrado', estatus)
     WHERE id = p_solicitud_id;
  ELSE
    UPDATE solicitudes SET finanzas_status = 'Autorizado', estatus = 'Cerrado' WHERE id = p_solicitud_id;
  END IF;

  COMMIT;
  SELECT * FROM solicitudes WHERE id = p_solicitud_id;
END$$

DROP PROCEDURE IF EXISTS sp_recalcular_comprobacion$$
CREATE PROCEDURE sp_recalcular_comprobacion(IN p_solicitud_id VARCHAR(40), IN p_solo_avion TINYINT(1))
BEGIN
  DECLARE v_folio VARCHAR(10);
  SELECT folio INTO v_folio FROM solicitudes WHERE id = p_solicitud_id;

  SELECT v_folio AS solicitud_id,
         COALESCE(SUM(monto_solicitado), 0) AS solicitado,
         COALESCE(SUM(monto_comprobado), 0) AS comprobado,
         (COALESCE(SUM(monto_solicitado), 0) > 0
            AND COALESCE(SUM(monto_comprobado), 0) = COALESCE(SUM(monto_solicitado), 0)) AS completo,
         CASE WHEN COALESCE(SUM(monto_solicitado), 0) > 0
              THEN LEAST(100, ROUND(SUM(monto_comprobado) / SUM(monto_solicitado) * 100))
              ELSE 0 END AS pct
    FROM comprobantes_gasto
   WHERE solicitud_id = v_folio
     AND (p_solo_avion = 0 OR concepto = 'Avión');
END$$

DROP PROCEDURE IF EXISTS sp_folios_sin_comprobar$$
CREATE PROCEDURE sp_folios_sin_comprobar(IN p_user_id VARCHAR(40))
BEGIN
  SELECT t.id, t.folio, t.monto_total, t.solicitado, t.comprobado,
         (COUNT(*) OVER () >= 2) AS bloquea_nueva_solicitud
    FROM (
      SELECT s.id, s.folio, s.monto_total,
             COALESCE(SUM(c.monto_solicitado), 0) AS solicitado,
             COALESCE(SUM(c.monto_comprobado), 0) AS comprobado
        FROM solicitudes s
        LEFT JOIN comprobantes_gasto c ON c.solicitud_id = s.folio
       WHERE s.user_id = p_user_id AND s.estatus = 'Cerrado'
       GROUP BY s.id, s.folio, s.monto_total
    ) t
   WHERE NOT (t.solicitado > 0 AND t.comprobado = t.solicitado)
   ORDER BY t.folio;
END$$

DELIMITER ;
