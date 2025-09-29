import 'dotenv/config'
import { MongoClient } from "mongodb";

const testConnection = async () => {
  const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}` +
              `@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}?authSource=admin`;

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log("✅ Conectado ao MongoDB!");

    // Acessa o banco de dados
    const db = client.db(process.env.DB_NAME);

    // Executa uma consulta simples (pegar data/hora do servidor)
    const result = await db.command({ serverStatus: 1 });
    console.log("Hora do servidor:", result.localTime);

  } catch (err) {
    console.error("❌ Erro na conexão:", err.message);
  } finally {
    await client.close();
  }
};

testConnection();
