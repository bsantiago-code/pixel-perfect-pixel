-- =====================================================================================
-- Elimina por completo la base de datos del Portal de Viáticos          (MySQL 8.x)
--
-- ¡ATENCIÓN! Borra la base `portal_viaticos` con TODAS sus tablas, vistas, procedimientos, triggers y datos
-- (usuarios, solicitudes, facturas y sus archivos, configuración, bitácora…). No se puede deshacer.
-- Respalda antes si necesitas conservar algo:
--     mysqldump -u root -p --routines --triggers portal_viaticos > respaldo.sql
--
-- Es el PRIMER paso para reinstalar desde cero. El SEGUNDO es db/schema.sql, que crea la base con toda la
-- estructura nueva (solicitud_id = folio, comprobantes_gasto con llave folio + concepto, autorizaciones con
-- llave folio + usuario, compensaciones, etc.) y carga los datos de demostración.
--
-- Ejecución, en este orden (desde la raíz del proyecto):
--     mysql -u root -p --default-character-set=utf8mb4 < db/eliminar_base.sql
--     mysql -u root -p --default-character-set=utf8mb4 < db/schema.sql
-- =====================================================================================

DROP DATABASE IF EXISTS portal_viaticos;
