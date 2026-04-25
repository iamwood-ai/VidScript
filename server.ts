import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import youtubeDl from "youtube-dl-exec";
import cors from "cors";
import axios from "axios";
import ffmpeg from "ffmpeg-static";
import fs from "fs-extra";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure temp directory exists
const TEMP_DIR = path.join(process.cwd(), "temp_downloads");
fs.ensureDirSync(TEMP_DIR);

// Helper to clean URLs (Crucial for Instagram)
function getCleanUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    // Remove query parameters that break yt-dlp for Instagram
    if (parsed.hostname.includes("instagram.com")) {
      parsed.search = ""; 
    }
    // For YouTube, ensure we keep the 'v' parameter but drop tracking
    if (parsed.hostname.includes("youtube.com") && parsed.searchParams.has("v")) {
      const v = parsed.searchParams.get("v");
      parsed.search = `?v=${v}`;
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // Periodically clean up orphaned temp files (older than 1 hour)
  setInterval(async () => {
    try {
      const files = await fs.readdir(TEMP_DIR);
      const now = Date.now();
      for (const file of files) {
        const filePath = path.join(TEMP_DIR, file);
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > 3600000) {
          await fs.remove(filePath);
          console.log(`[Cleanup] Removed orphaned file: ${file}`);
        }
      }
    } catch (err) {
      console.error("[Cleanup] Error cleaning temp directory:", err);
    }
  }, 3600000);

  // API: Extract metadata
  app.post("/api/extract", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    const targetUrl = getCleanUrl(url);

    try {
      try {
        const isFacebook = targetUrl.includes("facebook.com") || targetUrl.includes("fb.watch") || targetUrl.includes("fb.com");
        const isX = targetUrl.includes("x.com") || targetUrl.includes("twitter.com");
        const isYoutube = targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
        const isInstagram = targetUrl.includes("instagram.com");
        
        let extractorArgs = undefined;
        if (isYoutube) {
          extractorArgs = "youtube:player-client=android,web;player-skip=webpage";
        } else if (isInstagram) {
          extractorArgs = 'instagram:user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"';
        }

        const outputRaw = await youtubeDl(targetUrl, {
          format: "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a][acodec^=mp4a]/best[ext=mp4][vcodec^=avc1]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
          noPlaylist: true,
          flatPlaylist: true,
          quiet: true,
          geoBypass: true,
          extractorArgs,
          referer: isFacebook ? "https://www.facebook.com/" : (isX ? "https://x.com/" : (isInstagram ? "https://www.instagram.com/" : (targetUrl.includes("tiktok.com") ? "https://www.tiktok.com/" : targetUrl))),
          addHeader: [
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language: en-US,en;q=0.9",
            "Sec-Fetch-Mode: navigate"
          ]
        } as any);

        const output = outputRaw as any;

        // Map formats to a cleaner structure that the frontend expects
        const mappedFormats = (output.formats || []).map((f: any) => ({
          format_id: f.format_id,
          url: `/api/download?url=${encodeURIComponent(targetUrl)}&format_id=${encodeURIComponent(f.format_id)}&title=${encodeURIComponent(output.title || "video")}`,
          ext: "mp4",
          height: f.height,
          vcodec: f.vcodec,
          acodec: f.acodec,
          abr: f.abr,
          filesize: f.filesize,
          note: f.format_note || f.note || ""
        })).filter((f: any) => f.vcodec !== "none" || f.format_id === "best");

        // Ensure we have at least one "universal" format
        if (mappedFormats.length === 0) {
          mappedFormats.push({
            format_id: "universal",
            url: `/api/download?url=${encodeURIComponent(targetUrl)}&title=${encodeURIComponent(output.title || "video")}`,
            ext: "mp4",
            note: "Universal Quality (Best Compatible)",
            vcodec: "h264",
            acodec: "aac"
          });
        }

        const cleanedData = {
          id: output.id,
          title: output.title,
          thumbnail: output.thumbnail,
          uploader: output.uploader || output.uploader_id || targetUrl.split('/')[2].replace('www.', ''),
          extractor: output.extractor_key?.toLowerCase() || "",
          duration: output.duration || 0,
          description: (output.description || "").substring(0, 200),
          mediaType: "video",
          formats: mappedFormats,
          webpage_url: output.webpage_url || targetUrl
        };

        return res.json(cleanedData);
      } catch (ytdlError: any) {
        console.warn("yt-dlp extraction failed, using fallback:", ytdlError.message);
        
        // Robust fallback logic for UI preview if yt-dlp fails
        const pageRes = await axios.get(targetUrl, {
          headers: { 
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9"
          },
          timeout: 10000,
        });
        
        const html = pageRes.data;
        const ogTitle = html.match(/<meta property="og:title" content="(.*?)"/i) || html.match(/<title>(.*?)<\/title>/i);
        const title = ogTitle ? ogTitle[1].replace(/&amp;/g, '&') : "Social Media Video";
        const ogImage = html.match(/<meta property="og:image" content="(.*?)"/i);
        const thumbnail = ogImage ? ogImage[1].replace(/&amp;/g, '&') : `https://picsum.photos/seed/${Math.random()}/800/450`;

        let directUrl = "";
        const patterns = [
          /"video_url":"([^"]+)"/,
          /property="og:video:secure_url" content="([^"]+)"/,
          /property="og:video" content="([^"]+)"/,
          /"playAddr":"([^"]+)"/,
          /"downloadAddr":"([^"]+)"/
        ];
        
        for (const p of patterns) {
          const m = html.match(p);
          if (m && m[1]) {
            const found = m[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
            if (found.startsWith('http')) {
              directUrl = found;
              break;
            }
          }
        }

        const formats = [
          { 
            format_id: "universal", 
            url: `/api/download?url=${encodeURIComponent(targetUrl)}&title=${encodeURIComponent(title)}`, 
            ext: "mp4", 
            note: "Universal Quality", 
            vcodec: "h264", 
            acodec: "aac" 
          }
        ];

        if (directUrl) {
          formats.unshift({
            format_id: "direct",
            url: `/api/proxy?url=${encodeURIComponent(directUrl)}&filename=video.mp4&mode=inline`,
            ext: "mp4",
            note: "Direct Feed (Backup)",
            vcodec: "h264",
            acodec: "aac"
          });
        }

        const fallbackData = {
          title: title,
          thumbnail: thumbnail,
          uploader: targetUrl.split('/')[2].replace('www.', ''),
          extractor: "video",
          duration: 0,
          description: "Video identified via backup scanner.",
          mediaType: "video",
          formats: formats,
          webpage_url: targetUrl
        };

        return res.json(fallbackData);
      }
    } catch (error: any) {
      res.status(500).json({ error: "Extraction failed" });
    }
  });

  // API: Universal Download & Merge
  app.get("/api/download", async (req, res) => {
    const { url, format_id, title, mode } = req.query;
    if (!url) return res.status(400).send("URL is required");

    const targetUrl = getCleanUrl(url as string);
    const jobId = crypto.randomBytes(8).toString("hex");
    const outputFilename = `${jobId}.mp4`;
    const outputPath = path.join(TEMP_DIR, outputFilename);

    try {
      console.log(`[Job ${jobId}] Starting download for:`, targetUrl);

      const isYoutube = targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
      const isInstagram = targetUrl.includes("instagram.com");

      let extractorArgs = undefined;
      if (isYoutube) {
        extractorArgs = "youtube:player-client=android,web;player-skip=webpage";
      } else if (isInstagram) {
        extractorArgs = 'instagram:user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"';
      }

      // Preferred format string
      const formatSelection = format_id 
        ? `${format_id}+bestaudio[ext=m4a]/best[ext=mp4]/best`
        : "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a][acodec^=mp4a]/best[ext=mp4][vcodec^=avc1]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";

      await youtubeDl(targetUrl, {
        format: formatSelection,
        ffmpegLocation: ffmpeg || undefined,
        output: outputPath,
        mergeOutputFormat: "mp4",
        noPlaylist: true,
        noCheckCertificates: true,
        noWarnings: true,
        quiet: true,
        geoBypass: true,
        extractorArgs,
        addHeader: [
          "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        ]
      } as any);

      if (!fs.existsSync(outputPath)) {
        throw new Error("File was not created after download process.");
      }

      const stats = fs.statSync(outputPath);
      const sanitizedTitle = ((title as string) || "video").replace(/[^a-zA-Z0-9\u00C0-\u017F]/g, "_");
      
      // Serve the file
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Accept-Ranges", "bytes");
      
      const disposition = mode === "download" ? "attachment" : "inline";
      res.setHeader("Content-Disposition", `${disposition}; filename="${sanitizedTitle}.mp4"`);

      const readStream = fs.createReadStream(outputPath);
      readStream.pipe(res);

      res.on("finish", () => {
        try {
          fs.removeSync(outputPath);
          console.log(`[Job ${jobId}] Cleanup: Deleted temp file ${outputFilename}`);
        } catch (e) {
          console.error("Cleanup error:", e);
        }
      });

      readStream.on("error", (err) => {
        console.error("ReadStream error:", err);
        if (!res.headersSent) res.status(500).end();
      });

    } catch (error: any) {
      console.error(`[Job ${jobId}] Download failed:`, error.message);
      if (fs.existsSync(outputPath)) fs.removeSync(outputPath);
      if (!res.headersSent) {
        res.status(500).send("Video processing failed. This platform might be blocking the request.");
      }
    }
  });

  // Proxy for non-video assets or direct fallback streams
  app.get("/api/proxy", async (req, res) => {
    const { url, filename, mode } = req.query;
    if (!url) return res.status(400).send("URL is required");

    if ((url as string).includes("localhost") || (url as string).includes("127.0.0.1")) {
      return res.status(403).send("Forbidden");
    }

    try {
      const range = req.headers.range;
      const urlStr = url as string;
      const isInstagram = urlStr.includes("instagram.com") || urlStr.includes("cdninstagram.com");
      const isFacebook = urlStr.includes("facebook.com") || urlStr.includes("fbcdn.net");
      const isTikTok = urlStr.includes("tiktok.com") || urlStr.includes("tiktokv.com");
      const isTwitter = urlStr.includes("twitter.com") || urlStr.includes("x.com") || urlStr.includes("twimg.com");
      const isYoutube = urlStr.includes("youtube.com") || urlStr.includes("googlevideo.com");
      
      const headers: any = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Dest": "video",
      };

      if (isInstagram || isTikTok) {
        headers["User-Agent"] = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
      }

      if (isInstagram) {
        headers["Referer"] = "https://www.instagram.com/";
        headers["Origin"] = "https://www.instagram.com";
      } else if (isFacebook) {
        headers["Referer"] = "https://www.facebook.com/";
      } else if (isTikTok) {
        headers["Referer"] = "https://www.tiktok.com/";
      } else if (isTwitter) {
        headers["Referer"] = "https://x.com/";
      } else if (isYoutube) {
        headers["Referer"] = "https://www.youtube.com/";
        headers["Origin"] = "https://www.youtube.com";
      }

      headers.Range = range || "bytes=0-";

      const response = await axios({
        method: "get",
        url: urlStr,
        responseType: "stream",
        timeout: 90000, 
        maxRedirects: 10,
        headers,
        validateStatus: (status) => status < 400,
      });

      const contentTypeHeader = String(response.headers["content-type"] || "video/mp4");
      const finalContentType = (contentTypeHeader.startsWith("video/") || contentTypeHeader.startsWith("audio/")) 
        ? contentTypeHeader 
        : "video/mp4";

      let sanitizedFilename = (filename as string || "file").replace(/[^a-zA-Z0-9.\-_]/g, "_");
      
      if (!sanitizedFilename.toLowerCase().endsWith(".mp4")) {
        sanitizedFilename = sanitizedFilename.replace(/\.[^/.]+$/, "") + ".mp4";
      }

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", finalContentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      
      const disposition = mode === "download" ? "attachment" : "inline";
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${sanitizedFilename}"`,
      );

      if (response.headers["content-length"]) {
        res.setHeader("Content-Length", String(response.headers["content-length"]));
      }
      if (response.headers["content-range"]) {
        res.setHeader("Content-Range", String(response.headers["content-range"]));
      }

      if (response.status === 206) {
        res.status(206);
      } else {
        res.status(response.status);
      }

      response.data.pipe(res);

      response.data.on("error", (err: any) => {
        console.error("Stream error in proxy pipe:", err);
        if (!res.headersSent) res.status(500).end();
      });

    } catch (error: any) {
      console.error("Proxy error details:", error.message);
      if (!res.headersSent) {
        res.status(error.response?.status || 500).send("Failed to stream media from source platform.");
      }
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