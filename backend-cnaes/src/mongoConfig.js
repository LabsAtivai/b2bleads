// Configuração única de conexão MongoDB, compartilhada pela API (src/db.js)
// e pelo ETL (etl/*). Evita divergência de URI/DB_NAME entre os dois.

export function getDbName() {
  return process.env.DB_NAME || 'receitafederal'
}

// Lê as variáveis em tempo de chamada (não no topo do módulo) para que o
// dotenv.config() do entrypoint já tenha rodado.
export function buildMongoUri() {
  if (process.env.MONGO_URI) return process.env.MONGO_URI

  const { DB_USER, DB_PASS, DB_HOST, DB_PORT } = process.env
  if (!DB_HOST) return 'mongodb://localhost:27017'

  const auth = DB_USER ? `${DB_USER}:${DB_PASS}@` : ''
  const authSource = DB_USER ? '?authSource=admin' : ''
  return `mongodb://${auth}${DB_HOST}:${DB_PORT || 27017}/${getDbName()}${authSource}`
}
