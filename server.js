import express from "express";
import bodyParser from "body-parser";
import neo4j from "neo4j-driver";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

console.log("Neo4j URI:", process.env.NEO4J_URI);
const app = express();
app.use(bodyParser.json());
app.use(cors()); // ✅ must come BEFORE routes

// Neo4j driver setup
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD)
);
const db = process.env.neo4jDatabase || "neo4j";

// Resolve paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Serve OpenAPI and GPT Plugin Manifest ---
app.get("/.well-known/ai-plugin.json", (req, res) => {
  const filePath = path.join(__dirname, ".well-known", "ai-plugin.json");
  console.log("Serving:", filePath);
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error("Error serving ai-plugin.json:", err);
      res.status(404).send("ai-plugin.json not found");
    }
  });
});

app.get("/openapi.yaml", (req, res) => {
  const filePath = path.join(__dirname, "openapi.yaml");
  console.log("Serving:", filePath);
  res.type("text/yaml");
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error("Error serving openapi.yaml:", err);
      res.status(404).send("openapi.yaml not found");
    }
  });
});

// --- Write structured memory with mode support ---
app.post("/write", async (req, res) => {
  const { text, context = {}, relationships = [], mode = "create" } = req.body;
  const session = driver.session({ database: db });

  try {
    let result;
    const contextString = JSON.stringify(context);
    const timestamp = new Date().toISOString();

    switch (mode) {
      case "overwrite":
        result = await session.run(
          `
          MERGE (n:Memory {text: $text})
          SET n.context = $contextString, n.updatedAt = datetime($timestamp)
          ON CREATE SET n.createdAt = datetime($timestamp)
          RETURN id(n) as nodeId
          `,
          { text, contextString, timestamp }
        );
        break;
      case "skip":
        result = await session.run(
          `
          MERGE (n:Memory {text: $text})
          ON CREATE SET n.context = $contextString,
                        n.createdAt = datetime($timestamp)
          WITH n, n.context IS NOT NULL AS existed
          RETURN id(n) as nodeId, existed
          `,
          { text, contextString, timestamp }
        );

        if (result.records.length && result.records[0].get("existed")) {
          return res.json({ status: "skipped", node: text });
        }
        break;

      default:
        result = await session.run(
          `
          CREATE (n:Memory {text: $text, context: $contextString, createdAt: datetime($timestamp)})
          RETURN id(n) as nodeId
          `,
          { text, contextString, timestamp }
        );
        break;
    }

    const nodeId = result.records[0].get("nodeId").toString();

    for (const rel of relationships) {
      const { from, to, type } = rel;
      if (!from || !to || !type) continue;
      await session.run(
        `
        MATCH (a:Memory {text: $from}), (b:Memory {text: $to})
        MERGE (a)-[r:${type}]->(b)
        RETURN id(r)
        `,
        { from, to }
      );
    }

    res.json({ status: "ok", mode, nodeId });
  } catch (error) {
    console.error("Write error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
});

// --- Query memories (enhanced) ---
app.post("/query", async (req, res) => {
  const { cypher, params = {}, format = "records" } = req.body;
  const session = driver.session({ database: db });

  try {
    if (!cypher || typeof cypher !== "string") {
      return res.status(400).json({ error: "Missing or invalid Cypher query string." });
    }

    const result = await session.run(cypher, params);
    const output =
      format === "json"
        ? result.records.map((record) => {
            const obj = record.toObject();
            for (const key in obj) {
              if (obj[key] && obj[key].context && typeof obj[key].context === "string") {
                try {
                  obj[key].context = JSON.parse(obj[key].context);
                } catch {}
              }
            }
            return obj;
          })
        : result.records.map((record) => record.toObject());

    res.json({ status: "ok", records: output.length, format, results: output });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
});

// --- Health checks ---
app.get("/ping", (_req, res) => res.send("pong"));
app.get("/health", async (_req, res) => {
  try {
    await driver.verifyConnectivity();
    res.json({ status: "ok" });
  } catch (error) {
    res.status(500).json({ status: "error", error: error.message });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Neo4j Memory Builder API running on port ${PORT}`));
