// src/db.js
// [FIX] dotenv é carregado UMA vez no entry point (server.js) antes deste import.
// Não importar dotenv/config aqui para evitar sobreposição de variáveis.
import mongoose from 'mongoose'

const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_HOST}:${process.env.DB_PORT || 27017}/${process.env.DB_NAME}?authSource=admin`

export async function connectMongo() {
  try {
    // [FIX] autoIndex configurado UMA vez aqui, não repetido em server.js
    mongoose.set('autoIndex', process.env.NODE_ENV !== 'production')

    await mongoose.connect(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
    })

    console.log('✅ Conectado ao MongoDB com Mongoose!')
  } catch (err) {
    console.error('❌ Erro na conexão:', err.message)
    throw err
  }
}
