import express from "express";
import bodyParser from "body-parser";
import neo4j from "neo4j-driver";
import dotenv from "dotenv";

dotenv.config();
console.log('Neo4j URI:', process.env.NEO4J_URI);
const app = express();
app.use(bodyParser.json());

console.log('NEO4J_URI:', process.env.NEO4J_URI);
console.log('NEO4J_USERNAME:', process.env.NEO4J_USERNAME);
console.log('NEO4J_PASSWORD exists:', !!process.env.NEO4J_PASSWORD);

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD)
);

const db = process.env.neo4jDatabase || "neo4j";

// --- Write structured memory ---
app.post("/write", async (req, res) => {
  const { text, context = {}, relationships = [] } = req.body;
  const session = driver.session({ database: db });

  try {
    const result = await session.run(
      `
      CREATE (n:Memory {text: $text, context: $contextString, createdAt: datetime()})
      RETURN id(n) as nodeId
      `,
      { text, contextString: JSON.stringify(context) }
    );

    const nodeId = result.records[0].get("nodeId").toString();

    for (const rel of relationships) {
      await session.run(
        `
        MATCH (a), (b)
        WHERE id(a) = toInteger($from) AND id(b) = toInteger($to)
        CREATE (a)-[r:${rel.type}]->(b)
        RETURN r
        `,
        { from: rel.from, to: rel.to }
      );
    }

    res.json({ status: "ok", nodeId });
  } catch (error) {
    console.error("Write error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
});

// --- Query memories ---
app.post("/query", async (req, res) => {
  const { cypher } = req.body;
  const session = driver.session({ database: db });

  try {
    const result = await session.run(cypher);

    const results = result.records.map(record => {
      const obj = record.toObject();

      // Try to parse any JSON string contexts
      for (const key in obj) {
        if (obj[key] && obj[key].context && typeof obj[key].context === 'string') {
          try {
            obj[key].context = JSON.parse(obj[key].context);
          } catch {
            // leave as-is if parsing fails
          }
        }
      }

      return obj;
    });

    res.json({ results });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
});

// --- Health check ---
app.get("/health", async (_req, res) => {
  try {
    await driver.verifyConnectivity();
    res.json({ status: "ok" });
  } catch (error) {
    res.status(500).json({ status: "error", error: error.message });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 8089;
app.listen(PORT, () => {
  console.log(`Neo4j Memory Builder API running on port ${PORT}`);
});
