import mongoose from 'mongoose'
import { buildMongoUri } from './mongoConfig.js'

// A URI é montada dentro da função (não no topo do módulo): imports estáticos
// são avaliados antes do código do módulo que importa, então se isso ficasse
// no topo, o dotenv.config() do server.js ainda não teria rodado e as
// variáveis de ambiente estariam todas undefined.
const buildUri = buildMongoUri

export async function connectMongo() {
  try {
    mongoose.set('autoIndex', process.env.NODE_ENV !== 'production')

    await mongoose.connect(buildUri(), {
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
