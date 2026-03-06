CREATE DATABASE crm_demo;
\c crm_demo;

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
);

CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  email VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE client_categories (
  client_id INT REFERENCES clients(id) ON DELETE CASCADE,
  category_id INT REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, category_id)
);

CREATE TABLE sms_logs (
  id SERIAL PRIMARY KEY,
  client_id INT REFERENCES clients(id),
  message TEXT,
  status VARCHAR(50),
  sent_at TIMESTAMP DEFAULT NOW()
);

-- Seed a default user (admin / admin1234)
INSERT INTO users (username, password) VALUES ('admin', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi');
-- default password is "admin1234" - change this hash with bcrypt if needed