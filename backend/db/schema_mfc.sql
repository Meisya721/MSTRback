CREATE DATABASE IF NOT EXISTS mstr
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE mstr;

CREATE TABLE IF NOT EXISTS substrates (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(10) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_substrates_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  substrate_id INT UNSIGNED NOT NULL,
  replicate SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('running', 'stopped', 'aborted') NOT NULL DEFAULT 'running',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME NULL,
  interval_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  ph DECIMAL(4,2) NULL,
  temperature_c DECIMAL(5,2) NULL,
  volume_ml DECIMAL(8,2) NULL,
  anode_area_cm2 DECIMAL(8,2) NULL,
  load_resistor_ohm DECIMAL(10,2) NULL,
  voltage_threshold_v DECIMAL(5,3) NOT NULL DEFAULT 0.300,
  notes TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  running_flag TINYINT GENERATED ALWAYS AS (IF(status = 'running', 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_substrate_replicate (substrate_id, replicate),
  UNIQUE KEY uq_sessions_one_running (running_flag),
  KEY idx_sessions_status (status),
  CONSTRAINT fk_sessions_substrate
    FOREIGN KEY (substrate_id) REFERENCES substrates (id)
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS measurements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id INT UNSIGNED NOT NULL,
  elapsed_seconds INT UNSIGNED NOT NULL,
  voltage_v DECIMAL(8,4) NOT NULL,
  current_ma DECIMAL(10,4) NOT NULL,
  power_mw DECIMAL(12,4) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_meas_session_elapsed (session_id, elapsed_seconds),
  KEY idx_meas_session (session_id),
  CONSTRAINT fk_meas_session
    FOREIGN KEY (session_id) REFERENCES sessions (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_status (
  device_id VARCHAR(50) NOT NULL,
  status ENUM('online', 'offline') NOT NULL DEFAULT 'offline',
  last_seen_at DATETIME NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;