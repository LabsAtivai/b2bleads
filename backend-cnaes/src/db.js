// src/db.js
import 'dotenv/config'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(process.cwd(), '../.env') })


const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_HOST}:${process.env.DB_PORT || 27017}/${process.env.DB_NAME}?authSource=admin`

export async function connectMongo() {
  try {
    await mongoose.connect(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000
    })
    console.log("✅ Conectado ao MongoDB com Mongoose!")
  } catch (err) {
    console.error("❌ Erro na conexão:", err.message)
    throw err
  }
}
