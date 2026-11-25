-- =====================================================================================
-- Migración: Presupuestos por departamento                                       (MySQL 8.4)
--
-- Qué hace:
--   1. departamentos            → catálogo nuevo (Comercial, Auditoría, Calidad, Apoyo, Movilidad: los de la
--                                 hoja de pagos a hoteles; se editan en la pantalla Presupuestos).
--   2. usuarios.departamento_id → departamento del usuario (se asigna en Usuarios).
--   3. solicitudes.departamento_id → departamento con que nació el folio (lo copia trg_solicitudes_bi).
--   4. presupuestos             → bolsas por departamento y rango de fechas (por omisión un mes).
--   5. v_presupuestos           → asignado / ejercido (folios autorizados) / disponible / por autorizar.
--   6. sp_autorizar_solicitud   → avisa (bitácora) o bloquea al autorizar un folio que excede su presupuesto.
--   7. Triggers                 → validación sin empalmes y bitácora de presupuestos; departamento del folio;
--                                 al asignar departamento a un usuario sin él, sus folios sin departamento lo toman.
--   8. configuracion            → bloquear_autorizacion_sin_presupuesto = false (si falta).
--   9. roles.permisos           → "gestionar_presupuestos": true para administrador y finanzas, solo si aún no
--                                 tienen la clave (no pisa lo que se haya definido en Permisos).
--
-- Es IDEMPOTENTE: se puede ejecutar varias veces; no borra datos.
-- Úsalo en bases que ya existen (con `npm run db:setup` no hace falta: schema.sql ya lo incluye,
-- pero db:setup BORRA todo).
--
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-presupuestos-departamento.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

-- 1. Catálogo de departamentos.
CREATE TABLE IF NOT EXISTS departamentos (
  id      INT          NOT NULL AUTO_INCREMENT,
  nombre  VARCHAR(80)  NOT NULL,
  activo  TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_departamentos_nombre (nombre)
) ENGINE=InnoDB;

INSERT IGNORE INTO departamentos (nombre) VALUES ('Comercial'), ('Auditoría'), ('Calidad'), ('Apoyo'), ('Movilidad');

-- 2. usuarios.departamento_id (solo si falta).
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'departamento_id') = 0,
  'ALTER TABLE usuarios ADD COLUMN departamento_id INT NULL COMMENT ''Departamento cuyo presupuesto descuentan sus viajes'' AFTER initials, ADD KEY ix_usuarios_depto (departamento_id), ADD CONSTRAINT fk_usuarios_depto FOREIGN KEY (departamento_id) REFERENCES departamentos (id) ON DELETE RESTRICT',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. solicitudes.departamento_id (solo si falta).
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'solicitudes' AND COLUMN_NAME = 'departamento_id') = 0,
  'ALTER TABLE solicitudes ADD COLUMN departamento_id INT NULL COMMENT ''Departamento del solicitante al crear el folio (lo copia trg_solicitudes_bi); su presupuesto es el que descuenta'' AFTER nota_rechazo, ADD KEY ix_solicitudes_depto (departamento_id, estatus, fecha), ADD CONSTRAINT fk_solicitudes_depto FOREIGN KEY (departamento_id) REFERENCES departamentos (id) ON DELETE RESTRICT',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Bolsas de presupuesto.
CREATE TABLE IF NOT EXISTS presupuestos (
  id               VARCHAR(40)   NOT NULL,
  departamento_id  INT           NOT NULL,
  fecha_inicio     DATE          NOT NULL,
  fecha_fin        DATE          NOT NULL,
  monto            DECIMAL(12,2) NOT NULL COMMENT 'Monto asignado a la bolsa',
  notas            VARCHAR(500)  NULL,
  creado_por       VARCHAR(40)   NULL,
  creado_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actualizado_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_presupuestos_depto (departamento_id, fecha_inicio, fecha_fin),
  CONSTRAINT fk_presupuestos_depto FOREIGN KEY (departamento_id) REFERENCES departamentos (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- 5. Vista (copia exacta de db/schema.sql).
DROP VIEW IF EXISTS v_presupuestos;
-- Estado de cada bolsa de presupuesto. Un folio cuenta en la bolsa de su departamento cuyo rango cubre la
-- fecha de la solicitud. ejercido = monto total de los folios autorizados (Cerrado); por_autorizar = folios aún
-- Abiertos (informativo, no descuenta); comprobado = lo comprobado con facturas de los folios autorizados.
CREATE VIEW v_presupuestos AS
  SELECT p.id, p.departamento_id, d.nombre AS departamento, d.activo AS departamento_activo,
         p.fecha_inicio, p.fecha_fin, p.monto, p.notas, p.creado_por, p.creado_at, p.actualizado_at,
         COALESCE(a.ejercido, 0)                AS ejercido,
         COALESCE(a.folios, 0)                  AS folios_autorizados,
         COALESCE(a.comprobado, 0)              AS comprobado,
         COALESCE(pa.por_autorizar, 0)          AS por_autorizar,
         COALESCE(pa.folios, 0)                 AS folios_por_autorizar,
         p.monto - COALESCE(a.ejercido, 0)      AS disponible
    FROM presupuestos p
    JOIN departamentos d ON d.id = p.departamento_id
    LEFT JOIN (
      SELECT p2.id AS presupuesto_id, SUM(s.monto_total) AS ejercido, COUNT(*) AS folios,
             SUM((SELECT COALESCE(SUM(c.monto_comprobado), 0) FROM comprobantes_gasto c
                   WHERE c.solicitud_id = s.id)) AS comprobado
        FROM presupuestos p2
        JOIN solicitudes s ON s.departamento_id = p2.departamento_id
                          AND s.fecha BETWEEN p2.fecha_inicio AND p2.fecha_fin
       WHERE s.estatus = 'Cerrado'
       GROUP BY p2.id
    ) a ON a.presupuesto_id = p.id
    LEFT JOIN (
      SELECT p3.id AS presupuesto_id, SUM(s.monto_total) AS por_autorizar, COUNT(*) AS folios
        FROM presupuestos p3
        JOIN solicitudes s ON s.departamento_id = p3.departamento_id
                          AND s.fecha BETWEEN p3.fecha_inicio AND p3.fecha_fin
       WHERE s.estatus = 'Abierto'
       GROUP BY p3.id
    ) pa ON pa.presupuesto_id = p.id;

-- 6 y 7. Procedimientos y triggers (copias exactas de db/schema.sql).
DROP PROCEDURE IF EXISTS sp_autorizar_solicitud;
DROP PROCEDURE IF EXISTS sp_validar_presupuesto;
DROP TRIGGER IF EXISTS trg_usuarios_au;
DROP TRIGGER IF EXISTS trg_solicitudes_bi;
DROP TRIGGER IF EXISTS trg_presupuestos_bi;
DROP TRIGGER IF EXISTS trg_presupuestos_bu;
DROP TRIGGER IF EXISTS trg_presupuestos_ai;
DROP TRIGGER IF EXISTS trg_presupuestos_au;
DROP TRIGGER IF EXISTS trg_presupuestos_ad;
DELIMITER $$

-- Autoriza o rechaza el paso que le corresponda al usuario (jefe o finanzas).
-- p_decision: 'autorizado' | 'rechazado'. Reglas de estatus.tsx:
--   · nadie autoriza ni rechaza su propia solicitud;
--   · paso jefe: permiso autorizar_lte5000 y jefe_status = Pendiente (sin importar el monto);
--   · paso finanzas: permiso autorizar_gt5000, monto > umbral_finanzas, jefe ya autorizó;
--   · la solicitud pasa a Cerrado al completar los pasos requeridos; el rechazo exige nota.
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
  DECLARE v_depto INT DEFAULT NULL;
  DECLARE v_depto_nombre VARCHAR(80) DEFAULT NULL;
  DECLARE v_fecha DATE;
  DECLARE v_presupuesto VARCHAR(40) DEFAULT NULL;
  DECLARE v_disponible DECIMAL(14,2) DEFAULT NULL;
  DECLARE v_bloquear_pres TINYINT(1) DEFAULT 0;
  DECLARE v_msg VARCHAR(255);

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

  SELECT user_id, estatus, jefe_status, finanzas_status, monto_total, folio, departamento_id, fecha
    INTO v_owner, v_estatus, v_jefe, v_fin, v_monto, v_folio, v_depto, v_fecha
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

  -- Presupuesto del departamento: el folio aún está Abierto, así que no está contado en lo ejercido.
  -- Si no hay bolsa que cubra la fecha o el disponible no alcanza, se registra en la bitácora y, con el
  -- parámetro bloquear_autorizacion_sin_presupuesto activo, no se autoriza. Folios sin departamento no aplican.
  IF p_decision = 'autorizado' AND v_depto IS NOT NULL THEN
    SELECT nombre INTO v_depto_nombre FROM departamentos WHERE id = v_depto;
    SELECT id, disponible INTO v_presupuesto, v_disponible
      FROM v_presupuestos
     WHERE departamento_id = v_depto AND v_fecha BETWEEN fecha_inicio AND fecha_fin
     LIMIT 1;
    IF v_presupuesto IS NULL OR v_disponible < v_monto THEN
      SELECT COALESCE(JSON_UNQUOTE(valor) = 'true', 0) INTO v_bloquear_pres
        FROM configuracion WHERE clave = 'bloquear_autorizacion_sin_presupuesto';
      IF v_bloquear_pres = 1 THEN
        SET v_msg = IF(v_presupuesto IS NULL,
          CONCAT('Bloqueado: el departamento ', v_depto_nombre, ' no tiene presupuesto para el ',
                 DATE_FORMAT(v_fecha, '%d/%m/%Y'), '.'),
          CONCAT('Bloqueado: el folio ', v_folio, ' ($', FORMAT(v_monto, 0), ') excede el presupuesto disponible de ',
                 v_depto_nombre, ' ($', FORMAT(v_disponible, 0), ').'));
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
      END IF;
      CALL sp_registrar_log('autorizacion_sobre_presupuesto', 'solicitud', p_solicitud_id, p_user_id,
        JSON_OBJECT('folio', v_folio, 'departamento', v_depto_nombre, 'paso', v_paso, 'monto', v_monto,
                    'presupuesto_id', v_presupuesto, 'disponible', v_disponible));
    END IF;
  END IF;

  INSERT INTO autorizaciones (id, solicitud_id, rol_autorizador, user_id, status, fecha, nota)
  VALUES (CONCAT('a_', SUBSTRING(REPLACE(UUID(), '-', ''), 1, 10)), p_solicitud_id,
          IF(v_paso = 'jefe', 'jefe_inmediato', 'finanzas'), p_user_id, p_decision, CURDATE(),
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

-- Reglas de una bolsa de presupuesto (las llaman trg_presupuestos_bi/bu): fechas en orden, monto no negativo,
-- departamento existente y sin empalme con otra bolsa del mismo departamento.
CREATE PROCEDURE sp_validar_presupuesto(
  IN p_id VARCHAR(40), IN p_depto INT, IN p_inicio DATE, IN p_fin DATE, IN p_monto DECIMAL(12,2))
BEGIN
  DECLARE v_ini DATE DEFAULT NULL;
  DECLARE v_fin DATE DEFAULT NULL;
  DECLARE v_msg VARCHAR(255);
  IF p_inicio IS NULL OR p_fin IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Captura la fecha inicial y la final del presupuesto.';
  END IF;
  IF p_fin < p_inicio THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La fecha final del presupuesto no puede ser anterior a la inicial.';
  END IF;
  IF p_monto IS NULL OR p_monto < 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'El monto del presupuesto no puede ser negativo.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM departamentos WHERE id = p_depto) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'El departamento no existe.';
  END IF;
  SELECT fecha_inicio, fecha_fin INTO v_ini, v_fin
    FROM presupuestos
   WHERE departamento_id = p_depto AND id <> p_id AND fecha_inicio <= p_fin AND fecha_fin >= p_inicio
   ORDER BY fecha_inicio
   LIMIT 1;
  IF v_ini IS NOT NULL THEN
    SET v_msg = CONCAT('Las fechas se empalman con otro presupuesto del mismo departamento (',
                       DATE_FORMAT(v_ini, '%d/%m/%Y'), ' al ', DATE_FORMAT(v_fin, '%d/%m/%Y'), ').');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;
END$$

-- Usuarios: al asignarle departamento a quien no tenía, sus folios sin departamento pasan a ese departamento
-- (para que cuenten en su presupuesto). Un cambio de departamento NO mueve los folios ya registrados.
CREATE TRIGGER trg_usuarios_au AFTER UPDATE ON usuarios FOR EACH ROW
BEGIN
  IF OLD.departamento_id IS NULL AND NEW.departamento_id IS NOT NULL THEN
    UPDATE solicitudes SET departamento_id = NEW.departamento_id
     WHERE user_id = NEW.id AND departamento_id IS NULL;
  END IF;
  IF NOT (OLD.departamento_id <=> NEW.departamento_id) THEN
    CALL sp_registrar_log('usuario_departamento', 'usuario', NEW.id, @ckl_usuario_id,
      JSON_OBJECT('usuario', NEW.nombre,
                  'antes', (SELECT nombre FROM departamentos WHERE id = OLD.departamento_id),
                  'despues', (SELECT nombre FROM departamentos WHERE id = NEW.departamento_id)));
  END IF;
END$$

-- Solicitudes: el folio toma el departamento de su solicitante al crearse (y ya no cambia).
CREATE TRIGGER trg_solicitudes_bi BEFORE INSERT ON solicitudes FOR EACH ROW
BEGIN
  IF NEW.departamento_id IS NULL THEN
    SET NEW.departamento_id = (SELECT departamento_id FROM usuarios WHERE id = NEW.user_id);
  END IF;
END$$

-- Presupuestos: validación y bitácora (alta, modificación con antes/después, baja).
CREATE TRIGGER trg_presupuestos_bi BEFORE INSERT ON presupuestos FOR EACH ROW
BEGIN
  CALL sp_validar_presupuesto(NEW.id, NEW.departamento_id, NEW.fecha_inicio, NEW.fecha_fin, NEW.monto);
END$$

CREATE TRIGGER trg_presupuestos_bu BEFORE UPDATE ON presupuestos FOR EACH ROW
BEGIN
  CALL sp_validar_presupuesto(NEW.id, NEW.departamento_id, NEW.fecha_inicio, NEW.fecha_fin, NEW.monto);
END$$

CREATE TRIGGER trg_presupuestos_ai AFTER INSERT ON presupuestos FOR EACH ROW
BEGIN
  CALL sp_registrar_log('presupuesto_alta', 'presupuesto', NEW.id, @ckl_usuario_id,
    JSON_OBJECT('departamento', (SELECT nombre FROM departamentos WHERE id = NEW.departamento_id),
                'fecha_inicio', NEW.fecha_inicio, 'fecha_fin', NEW.fecha_fin, 'monto', NEW.monto,
                'notas', NEW.notas));
END$$

CREATE TRIGGER trg_presupuestos_au AFTER UPDATE ON presupuestos FOR EACH ROW
BEGIN
  IF NOT (OLD.fecha_inicio <=> NEW.fecha_inicio AND OLD.fecha_fin <=> NEW.fecha_fin
          AND OLD.monto <=> NEW.monto AND OLD.notas <=> NEW.notas
          AND OLD.departamento_id <=> NEW.departamento_id) THEN
    CALL sp_registrar_log('presupuesto_modificacion', 'presupuesto', NEW.id, @ckl_usuario_id,
      JSON_OBJECT('departamento', (SELECT nombre FROM departamentos WHERE id = NEW.departamento_id),
                  'antes', JSON_OBJECT('fecha_inicio', OLD.fecha_inicio, 'fecha_fin', OLD.fecha_fin,
                                       'monto', OLD.monto, 'notas', OLD.notas),
                  'despues', JSON_OBJECT('fecha_inicio', NEW.fecha_inicio, 'fecha_fin', NEW.fecha_fin,
                                         'monto', NEW.monto, 'notas', NEW.notas)));
  END IF;
END$$

CREATE TRIGGER trg_presupuestos_ad AFTER DELETE ON presupuestos FOR EACH ROW
BEGIN
  CALL sp_registrar_log('presupuesto_baja', 'presupuesto', OLD.id, @ckl_usuario_id,
    JSON_OBJECT('departamento', (SELECT nombre FROM departamentos WHERE id = OLD.departamento_id),
                'fecha_inicio', OLD.fecha_inicio, 'fecha_fin', OLD.fecha_fin, 'monto', OLD.monto));
END$$
DELIMITER ;

-- 8. Parámetro del bloqueo (apagado por omisión).
INSERT IGNORE INTO configuracion (clave, valor) VALUES ('bloquear_autorizacion_sin_presupuesto', 'false');

-- 9. Permiso nuevo (solo donde falta la clave).
UPDATE roles
   SET permisos = JSON_SET(permisos, '$.gestionar_presupuestos', CAST('true' AS JSON))
 WHERE nombre IN ('administrador', 'finanzas')
   AND JSON_EXTRACT(permisos, '$.gestionar_presupuestos') IS NULL;

-- Verificación rápida:
--   SELECT * FROM departamentos;
--   SHOW COLUMNS FROM usuarios LIKE 'departamento_id';
--   SELECT nombre, JSON_EXTRACT(permisos, '$.gestionar_presupuestos') AS gestionar_presupuestos FROM roles;
