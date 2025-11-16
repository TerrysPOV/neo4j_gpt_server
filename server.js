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

// --- Write structured entity with dynamic labels and relationships (Neo4j 5+ Safe) ---
app.post("/write", async (req, res) => {
  const {
    text,
    label = "Memory", // Supports: Person, Company, Project, OutreachMessage, Reply, etc.
    context = {},
    relationships = [],
    mode = "create"
  } = req.body;

  const session = driver.session({ database: db });

  try {
    const timestamp = new Date().toISOString();

    // Ensure context is stored as JSON string (Neo4j can't store nested objects)
    const contextString =
      typeof context === "object" ? JSON.stringify(context) : String(context);

    // Build Cypher dynamically based on mode
    let cypher;
    if (mode === "overwrite") {
      cypher = `
        MERGE (n:${label} {text: $text})
        ON CREATE SET n.createdAt = datetime($timestamp)
        SET n.context = $contextString,
            n.updatedAt = datetime($timestamp)
        RETURN id(n) as nodeId
      `;
    } else if (mode === "skip") {
      cypher = `
        MERGE (n:${label} {text: $text})
        ON CREATE SET n.context = $contextString,
                      n.createdAt = datetime($timestamp)
        RETURN id(n) as nodeId
      `;
    } else {
      cypher = `
        CREATE (n:${label} {text: $text, context: $contextString, createdAt: datetime($timestamp)})
        RETURN id(n) as nodeId
      `;
    }

    // Execute write for node
    const result = await session.run(cypher, { text, contextString, timestamp });
    const nodeId = result.records[0].get("nodeId").toString();

    // --- Handle relationships safely ---
    for (const rel of relationships) {
      const { from, to, type } = rel;
      if (!from || !to || !type) continue;

      // Validate relationship type (only allow uppercase letters and underscores)
      const safeType = type.replace(/[^A-Z0-9_]/gi, "_");

      const relCypher = `
        MATCH (a {text: $from}), (b {text: $to})
        MERGE (a)-[r:${safeType}]->(b)
        ON CREATE SET r.createdAt = datetime($timestamp)
        RETURN id(r) as relId
      `;
      await session.run(relCypher, { from, to, timestamp });
    }

    // --- Respond with result ---
    res.json({ status: "ok", label, mode, nodeId });
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
