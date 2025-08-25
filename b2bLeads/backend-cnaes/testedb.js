import mysql from "mysql2/promise";

const testConnection = async () => {
  try {
    const conn = await mysql.createConnection({
      host: "207.244.249.157",
      port: 3306,
      user: "labs",
      password: "Z@ri1148",
      database: "receitafederaldados"
    });
    console.log("✅ Conectado ao MySQL!");
    const [rows] = await conn.query("SELECT NOW() as hora;");
    console.log(rows);
    await conn.end();
  } catch (err) {
    console.error("❌ Erro na conexão:", err.message);
  }
};

testConnection();