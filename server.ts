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
      try {
        const output = await youtubeDl(url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
          preferFreeFormats: true,
        });
        return res.json(output);
      } catch (ytdlError: any) {
        console.warn("yt-dlp failed, trying basic fallback...", ytdlError.message);
        
        // Basic fallback for UI preview if yt-dlp fails
        const pageRes = await axios.get(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          timeout: 5000
        });
        
        const html = pageRes.data;
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1] : "Social Video";
        
        // Attempt to find a thumbnail in meta tags
        const thumbMatch = html.match(/meta property="og:image" content="(.*?)"/i);
        const thumbnail = thumbMatch ? thumbMatch[1] : `https://picsum.photos/seed/${Math.random()}/800/450`;

        const fallbackData = {
          title,
          thumbnail,
          uploader: url.split('/')[2],
          extractor: url.includes('youtube') ? 'youtube' : (url.includes('tiktok') ? 'tiktok' : 'video'),
          description: "Video identified. Note: High-res formats may require server-side yt-dlp configuration.",
          formats: [
            { format_id: "default", url: url, ext: "mp4", note: "Source Link" }
          ],
          webpage_url: url
        };

        return res.json(fallbackData);
      }
    } catch (error: any) {
      console.error("Extraction error:", error);
      res.status(500).json({ error: "Failed to extract video info", details: error.message });
    }
  });

  // API: Proxy download (to bypass CORS and headers)
  app.get("/api/proxy", async (req, res) => {
    const { url, filename } = req.query;
    if (!url) return res.status(400).send("URL is required");

    // Block local/internal URLs
    if ((url as string).includes('localhost') || (url as string).includes('127.0.0.1')) {
      return res.status(403).send("Forbidden");
    }

    try {
      const response = await axios({
        method: "get",
        url: url as string,
        responseType: "stream",
        timeout: 15000,
        maxRedirects: 5,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Referer": "https://www.google.com/",
        },
      });

      res.setHeader("Content-Disposition", `attachment; filename="${filename || "video.mp4"}"`);

      // Forward some original headers if available
      const contentType = response.headers["content-type"];
      const contentLength = response.headers["content-length"];
      
      if (typeof contentType === "string") res.setHeader("Content-Type", contentType);
      if (typeof contentLength === "string" || typeof contentLength === "number") {
        res.setHeader("Content-Length", String(contentLength));
      }
      
      response.data.pipe(res);
    } catch (error: any) {
      console.error("Proxy error:", error);
      res.status(500).send("Failed to proxy video. This format might be protected or transient.");
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
