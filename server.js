import express from "express";
import bodyParser from "body-parser";
import neo4j from "neo4j-driver";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import neo4j from "neo4j-driver";

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
console.log("Neo4j URI:", process.env.NEO4J_URI);
const db = process.env.neo4jDatabase || "neo4j";

const limit = neo4j.int(Math.max(0, parseInt(req.body.limit ?? 500, 10)));
const result = await session.run(cypher, { limit });

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

app.set("trust proxy", true);
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
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


// --- Query structured entities or run custom Cypher (Neo4j 5+ Safe) ---
app.post("/query", async (req, res) => {
  const {
    cypher,
    params = {},
    format = "records",
    preset = null,
    limit = 250
  } = req.body;

  const session = driver.session({ database: db });

  try {
    // --- Handle presets (shortcuts for dashboards or analytics) ---
    let finalCypher = cypher;
    if (!finalCypher && preset) {
      switch (preset) {
        case "getAllPersons":
          finalCypher = `MATCH (p:Person) RETURN p LIMIT $limit`;
          break;

        case "getAllCompanies":
          finalCypher = `MATCH (c:Company) RETURN c LIMIT $limit`;
          break;

        case "getGraphSnapshot":
          finalCypher = `
            MATCH (a)-[r]->(b)
            RETURN a, r, b
            LIMIT $limit
          `;
          break;

        case "getInsights":
          finalCypher = `
            MATCH (i:Insight)-[rel]->(n)
            RETURN i, rel, n
            LIMIT $limit
          `;
          break;

        default:
          return res
            .status(400)
            .json({ error: `Unknown preset '${preset}'` });
      }
    }

    if (!finalCypher || typeof finalCypher !== "string") {
      return res
        .status(400)
        .json({ error: "Missing Cypher query or invalid type." });
    }

    // --- Prevent accidental destructive operations ---
    const lowered = finalCypher.toLowerCase();
    if (lowered.includes("delete") || lowered.includes("drop")) {
      return res.status(400).json({
        error: "Dangerous Cypher command detected. DELETE/DROP not allowed via API."
      });
    }

    // --- Run the query ---
    const result = await session.run(finalCypher, { ...params, limit: Number(limit) });

    // --- Format output ---
    let output;
    if (format === "json") {
      output = result.records.map((record) => {
        const obj = record.toObject();

        // parse context if stringified
        for (const key in obj) {
          if (obj[key]?.context && typeof obj[key].context === "string") {
            try {
              obj[key].context = JSON.parse(obj[key].context);
            } catch {
              /* keep as string */
            }
          }
        }
        return obj;
      });
    } else {
      output = result.records.map((record) => record.toObject());
    }

    res.json({
      status: "ok",
      records: output.length,
      format,
      preset: preset || "custom",
      results: output
    });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
});


// --- Return visualization-ready graph snapshot ---
app.post("/graph", async (req, res) => {
  res.type("application/json");
  const rawLimit = req.body.limit ?? 500;

  // Force limit to integer and keep it safe
  const limit = Math.max(0, parseInt(rawLimit, 10) || 0);
  const filterLabel = req.body.filterLabel || null;

  const session = driver.session({ database: db });

  try {
    const labelFilter = filterLabel ? `:${filterLabel}` : "";
    const cypher = `
      MATCH (a${labelFilter})-[r]->(b)
      RETURN a, type(r) AS relType, b
      LIMIT $limit
    `;
    const result = await session.run(cypher, { limit });

    const nodes = new Map();
    const links = [];

    for (const record of result.records) {
      const a = record.get("a").properties;
      const b = record.get("b").properties;
      const relType = record.get("relType");

      const aId = a.text;
      const bId = b.text;

      if (!nodes.has(aId))
        nodes.set(aId, { id: aId, label: a?.label || "Node", text: a.text, context: safeParse(a.context) });
      if (!nodes.has(bId))
        nodes.set(bId, { id: bId, label: b?.label || "Node", text: b.text, context: safeParse(b.context) });

      links.push({ source: aId, target: bId, type: relType });
    }

    res.status(200).json({
      status: "ok",
      nodes: Array.from(nodes.values()),
      links
    });
  } catch (error) {
    console.error("Graph query error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }

  function safeParse(value) {
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return { raw: value };
      }
    }
    return value || {};
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
