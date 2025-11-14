# Neo4j Memory Builder API

A lightweight Node.js + Express API for writing and querying structured memory data in Neo4j.

## 🚀 Overview

This service provides two main endpoints:

### `POST /write`
Create a new memory node in Neo4j.

**Request Body:**
```json
{
  "text": "example memory text",
  "context": {"source": "manual test"},
  "relationships": []
}

Response:

{
  "status": "ok",
  "nodeId": "123"
}

POST /query

Execute a Cypher query against your Neo4j database.

Request Body:

{
  "cypher": "MATCH (n:Memory) RETURN n ORDER BY n.createdAt DESC LIMIT 5"
}


Response:

{
  "results": [
    {
      "n": {
        "text": "example memory text",
        "context": {"source": "manual test"},
        "createdAt": "2025-11-14T..."
      }
    }
  ]
}

GET /health

Verifies database connectivity.

⚙️ Setup

Clone the repository

Install dependencies:

npm install


Create a .env file:

NEO4J_URI=bolt://<your-neo4j-host>:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=<your-password>
NEO4J_DATABASE=neo4j
PORT=8089


Start the server:

npm start


The API will be available at http://localhost:8089.

☁️ Deploying to Railway

Connect your GitHub repo on Railway.app

Add the same .env variables in your Railway project settings

Deploy — Railway will automatically build and host your service

🧠 Notes

The /write endpoint automatically stringifies the context field for Neo4j compatibility.

The /query endpoint automatically parses it back into an object.

Built for easy GPT action integration and graph memory storage.

📜 License

MIT License