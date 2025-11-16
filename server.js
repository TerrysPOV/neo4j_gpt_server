import express from "express";
import bodyParser from "body-parser";
import neo4j from "neo4j-driver";
import dotenv from "dotenv";
import cors from "cors";


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


// --- Serve OpenAPI and GPT Plugin Manifest ---
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve ai-plugin.json manually to avoid Express dotfile blocking
app.get("/.well-known/ai-plugin.json", (req, res) => {
  res.sendFile(path.join(__dirname, ".well-known", "ai-plugin.json"));
});

// Serve openapi.yaml manually to ensure proper MIME type
app.get("/openapi.yaml", (req, res) => {
  res.type("text/yaml");
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});


// --- Write structured memory with mode support ---
app.post("/write", async (req, res) => {
  const { text, context = {}, relationships = [], mode = "create" } = req.body;
  const session = driver.session({ database: db });

  try {
    let result;
    let nodeId;

    const contextString = JSON.stringify(context);
    const timestamp = new Date().toISOString();

    switch (mode) {
      case "overwrite":
        // Merge node if exists, update context and timestamp
        result = await session.run(
          `
          MERGE (n:Memory {text: $text})
          SET n.context = $contextString,
              n.updatedAt = datetime($timestamp)
          ON CREATE SET n.createdAt = datetime($timestamp)
          RETURN id(n) as nodeId
          `,
          { text, contextString, timestamp }
        );
        break;

      case "skip":
        // Only create if node does not exist
        result = await session.run(
          `
          MERGE (n:Memory {text: $text})
          ON CREATE SET n.context = $contextString,
                        n.createdAt = datetime($timestamp)
          RETURN id(n) as nodeId, exists(n.context) as existed
          `,
          { text, contextString, timestamp }
        );
        // If existed, skip relationships
        if (result.records.length && result.records[0].get("existed")) {
          return res.json({ status: "skipped", node: text });
        }
        break;

      default:
        // Default = create new node always
        result = await session.run(
          `
          CREATE (n:Memory {text: $text, context: $contextString, createdAt: datetime($timestamp)})
          RETURN id(n) as nodeId
          `,
          { text, contextString, timestamp }
        );
        break;
    }

    nodeId = result.records[0].get("nodeId").toString();

    // Handle relationships
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

    // Execute parameterized Cypher query
    const result = await session.run(cypher, params);

    let output;

    if (format === "json") {
      // Convert records into plain JS objects
      output = result.records.map(record => {
        const obj = record.toObject();

        for (const key in obj) {
          // If node has 'context', attempt to parse JSON
          if (obj[key] && obj[key].context && typeof obj[key].context === "string") {
            try {
              obj[key].context = JSON.parse(obj[key].context);
            } catch {
              // leave as-is if parsing fails
            }
          }

          // Convert Neo4j Integer values to JS numbers where possible
          if (obj[key] && obj[key].low !== undefined && obj[key].high !== undefined) {
            obj[key] = neo4j.integer.inSafeRange(obj[key])
              ? obj[key].toNumber()
              : obj[key].toString();
          }
        }

        return obj;
      });
    } else {
      // Default raw record format
      output = result.records.map(record => record.toObject());
    }

    res.json({
      status: "ok",
      records: output.length,
      format,
      results: output
    });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
});


// --- Lightweight liveness check for Railway ---
app.get("/ping", (_req, res) => {
  res.send("pong");
});


// --- Full Neo4j connectivity healthcheck ---
app.get("/health", async (_req, res) => {
  try {
    await driver.verifyConnectivity();
    res.json({ status: "ok" });
  } catch (error) {
    res.status(500).json({ status: "error", error: error.message });
  }
});


// --- alow CORS) --- 
app.use(cors());

// --- Start server ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Neo4j Memory Builder API running on port ${PORT}`);
});
