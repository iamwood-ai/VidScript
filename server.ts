import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import youtubeDl from "youtube-dl-exec";
import cors from "cors";
import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API: Extract metadata
  app.post("/api/extract", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    try {
      const output = await youtubeDl(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
        // Some sites like TikTok require specific user agents or cookies sometimes,
        // but yt-dlp handles most of that.
      });

      res.json(output);
    } catch (error: any) {
      console.error("Extraction error:", error);
      res.status(500).json({ error: "Failed to extract video info", details: error.message });
    }
  });

  // API: Proxy download (to bypass CORS and headers)
  app.get("/api/proxy", async (req, res) => {
    const { url, filename } = req.query;
    if (!url) return res.status(400).send("URL is required");

    try {
      const response = await axios({
        method: "get",
        url: url as string,
        responseType: "stream",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      res.setHeader("Content-Disposition", `attachment; filename="${filename || "video.mp4"}"`);

      const contentType = response.headers["content-type"];
      if (typeof contentType === "string") {
        res.setHeader("Content-Type", contentType);
      }
      
      response.data.pipe(res);
    } catch (error: any) {
      console.error("Proxy error:", error);
      res.status(500).send("Failed to proxy video");
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Server startup error:", err);
});
