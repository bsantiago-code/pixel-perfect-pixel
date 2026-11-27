-- =====================================================================================
-- Migración: autorizaciones con llave (folio, usuario) + user_nombre            (MySQL 8.x)
--
-- Qué hace:
--   1. autorizaciones.solicitud_id  → ahora guarda el FOLIO (solicitudes.folio, p. ej. #0040) y no el id
--                                     interno (s2); la FK apunta a solicitudes.folio.
--   2. autorizaciones.id            → se elimina.
--   3. Llave primaria               → (solicitud_id, user_id).
--   4. autorizaciones.user_nombre   → nuevo, después de user_id; se llena desde usuarios.nombre.
--   5. Triggers                     → trg_autorizaciones_bi (fija user_nombre al insertar) y
--                                     trg_usuarios_au (propaga el cambio de nombre del usuario).
--   6. Triggers de solicitudes y los procedimientos sp_autorizar_solicitud / sp_revertir_autorizaciones
--      se vuelven a crear para usar el folio.
--
-- Es IDEMPOTENTE: si autorizaciones ya no tiene la columna `id`, la parte de la tabla no hace nada.
-- No borra autorizaciones. Si hubiera dos filas del mismo usuario en un mismo folio, se detiene ANTES de
-- cambiar nada (la llave nueva no lo permite).
--
-- Ejecución (respalda antes: mysqldump portal_viaticos > respaldo.sql):
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-autorizaciones-folio.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

SET @tiene_id := (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'autorizaciones' AND COLUMN_NAME = 'id');

-- Aborta si la llave nueva chocaría (mismo usuario con dos decisiones en un mismo folio).
SET @choques := IF(@tiene_id = 0, 0,
  (SELECT COUNT(*) FROM (SELECT 1 FROM autorizaciones GROUP BY solicitud_id, user_id HAVING COUNT(*) > 1) x));
SET @sql := IF(@choques > 0, 'SELECT 1 FROM `ERROR_autorizaciones_con_usuario_repetido_en_un_folio`', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- user_nombre (después de user_id).
SET @sql := IF(@tiene_id = 0, 'DO 0',
  'ALTER TABLE autorizaciones ADD COLUMN user_nombre VARCHAR(120) NULL COMMENT ''Nombre de user_id; lo mantienen sincronizado trg_autorizaciones_bi y trg_usuarios_au'' AFTER user_id');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@tiene_id = 0, 'DO 0',
  'UPDATE autorizaciones a JOIN usuarios u ON u.id = a.user_id SET a.user_nombre = u.nombre');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- solicitud_id: de id interno a folio.
SET @sql := IF(@tiene_id = 0, 'DO 0', 'ALTER TABLE autorizaciones DROP FOREIGN KEY fk_aut_solicitud');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(@tiene_id = 0, 'DO 0',
  'UPDATE autorizaciones a JOIN solicitudes s ON s.id = a.solicitud_id SET a.solicitud_id = s.folio');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- Quita id y el índice por solicitud, estrecha solicitud_id y crea la llave nueva.
SET @sql := IF(@tiene_id = 0, 'DO 0',
  'ALTER TABLE autorizaciones
     DROP PRIMARY KEY,
     DROP COLUMN id,
     DROP INDEX ix_aut_solicitud,
     MODIFY COLUMN solicitud_id VARCHAR(10) NOT NULL COMMENT ''Folio de la solicitud (solicitudes.folio, p. ej. #0040)'',
     MODIFY COLUMN user_nombre VARCHAR(120) NOT NULL COMMENT ''Nombre de user_id; lo mantienen sincronizado trg_autorizaciones_bi y trg_usuarios_au'',
     ADD PRIMARY KEY (solicitud_id, user_id),
     ADD CONSTRAINT fk_aut_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- Triggers y rutinas que cambian (mismas definiciones que db/schema.sql).
DELIMITER $$

DROP TRIGGER IF EXISTS trg_autorizaciones_bi$$
CREATE TRIGGER trg_autorizaciones_bi BEFORE INSERT ON autorizaciones FOR EACH ROW
BEGIN
  SET NEW.user_nombre = (SELECT nombre FROM usuarios WHERE id = NEW.user_id);
END$$

DROP TRIGGER IF EXISTS trg_usuarios_au$$
CREATE TRIGGER trg_usuarios_au AFTER UPDATE ON usuarios FOR EACH ROW
BEGIN
  IF NOT (NEW.nombre <=> OLD.nombre) THEN
    UPDATE autorizaciones SET user_nombre = NEW.nombre WHERE user_id = NEW.id;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_solicitudes_bu$$
CREATE TRIGGER trg_solicitudes_bu BEFORE UPDATE ON solicitudes FOR EACH ROW
BEGIN
  -- Con autorizaciones registradas ya no se puede cambiar el monto (edición solo si no hay ninguna).
  IF NEW.monto_total <> OLD.monto_total
     AND EXISTS (SELECT 1 FROM autorizaciones WHERE solicitud_id = OLD.folio) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'No se puede modificar el monto: la solicitud ya tiene autorizaciones.';
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_solicitudes_bd$$
CREATE TRIGGER trg_solicitudes_bd BEFORE DELETE ON solicitudes FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM autorizaciones WHERE solicitud_id = OLD.folio) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'No se puede eliminar: la solicitud ya tiene autorizaciones.';
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
                                   WHERE solicitud_id = p_solicitud_id AND vigente = 1
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

DROP PROCEDURE IF EXISTS sp_revertir_autorizaciones$$
CREATE PROCEDURE sp_revertir_autorizaciones(IN p_solicitud_id VARCHAR(40), IN p_admin_id VARCHAR(40))
BEGIN
  DECLARE v_es_admin INT DEFAULT 0;
  DECLARE v_folio VARCHAR(10);

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SELECT COUNT(*) INTO v_es_admin
    FROM usuarios u JOIN roles r ON r.id = u.rol_id
   WHERE u.id = p_admin_id AND u.activo = 1 AND r.nombre = 'administrador';
  IF v_es_admin = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Solo un administrador puede revertir autorizaciones.';
  END IF;

  SELECT folio INTO v_folio FROM solicitudes WHERE id = p_solicitud_id;
  IF v_folio IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La solicitud no existe.';
  END IF;

  START TRANSACTION;
  DELETE FROM autorizaciones WHERE solicitud_id = v_folio;
  UPDATE solicitudes
     SET estatus = 'Abierto', jefe_status = 'Pendiente',
         finanzas_status = IF(finanzas_status = 'N/A', 'N/A', 'Pendiente'), nota_rechazo = NULL
   WHERE id = p_solicitud_id;
  CALL sp_registrar_log('autorizaciones_revertidas', 'solicitud', p_solicitud_id, p_admin_id,
                        JSON_OBJECT('folio', v_folio));
  COMMIT;
END$$

DELIMITER ;
