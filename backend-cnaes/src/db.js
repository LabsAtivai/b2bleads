import mongoose from 'mongoose'

const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_HOST}:${process.env.DB_PORT || 27017}/${process.env.DB_NAME}?authSource=admin`

export async function connectMongo() {
  try {
    mongoose.set('autoIndex', process.env.NODE_ENV !== 'production')

    await mongoose.connect(uri, {
      maxPoolSize: 20,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 0,
      compressors: ['zlib'],
    })

    console.log('✅ Conectado ao MongoDB com Mongoose!')
  } catch (err) {
    console.error('❌ Erro na conexão:', err.message)
    throw err
  }
}
