import 'dotenv/config'
import { createPool } from 'mysql2/promise'

export const pool = createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 30000,   // 15s
  enableKeepAlive: true
})
