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
    // Remove query parameters that break yt-dlp for Instagram or tracking on X
    if (parsed.hostname.includes("instagram.com")) {
      // Keep only the path, remove search and hash
      parsed.search = ""; 
      parsed.hash = "";
      // Re-add trailing slash as it helps yt-dlp identify Reels/Posts correctly
      if (!parsed.pathname.endsWith("/")) {
        parsed.pathname += "/";
      }
    } else if (parsed.hostname.includes("x.com") || parsed.hostname.includes("twitter.com")) {
      // Remove common X tracking parameters
      parsed.searchParams.delete("s");
      parsed.searchParams.delete("t");
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
        const isYoutube = targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
        const isInstagram = targetUrl.includes("instagram.com");
        const isTikTok = targetUrl.includes("tiktok.com");
        const isX = targetUrl.includes("x.com") || targetUrl.includes("twitter.com");
        
        let extractorArgs = undefined;
        if (isYoutube) {
          // Use web_embedded to bypass some bot detections
          extractorArgs = "youtube:player-client=web_embedded,mweb,android;player-skip=webpage";
        } else if (isInstagram) {
          // Instagram often works better with a standard mobile agent
          extractorArgs = 'instagram:user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"';
        } else if (isTikTok) {
          extractorArgs = 'tiktok:user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"';
        } else if (isFacebook) {
          extractorArgs = 'facebook:user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"';
        } else if (isX) {
          extractorArgs = 'twitter:user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"';
        }

        const commonHeaders = [
          "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language: en-US,en;q=0.9",
          "Upgrade-Insecure-Requests: 1",
          "Sec-Fetch-Mode: navigate",
          "Sec-Fetch-Site: same-origin",
          "Sec-Fetch-Dest: document"
        ];

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
          referer: isFacebook ? "https://www.facebook.com/" : (isInstagram ? "https://www.instagram.com/" : (isTikTok ? "https://www.tiktok.com/" : (isX ? "https://x.com/" : "https://www.google.com/"))),
          addHeader: commonHeaders,
          cookies: undefined, // Explicitly undefined to avoid issues if any default is set
        } as any);

        let output: any;
        try {
          output = typeof outputRaw === "string" ? JSON.parse(outputRaw) : outputRaw;
        } catch (e) {
          if (typeof outputRaw === "string" && outputRaw.includes("Rate exceeded")) {
             throw new Error("Platform rate limit exceeded. Please try again in a few minutes.");
          }
          throw new Error("Failed to parse metadata from platform. The content might be private or restricted.");
        }

        if (!output) throw new Error("No metadata returned from platform.");

        // General robust photo detection
        const isPhoto = output.extractor === 'instagram:photo' || 
                        output.extractor?.includes('photo') || 
                        output.extractor?.includes('image') ||
                        (output.formats && output.formats.length > 0 && output.formats.every((f: any) => 
                          (!f.vcodec || f.vcodec === 'none') && 
                          (f.ext === 'jpg' || f.ext === 'png' || f.ext === 'webp' || f.ext === 'jpeg')
                        ));
        
        const mediaType = isPhoto ? "photo" : "video";

        // Map formats to a cleaner structure that the frontend expects
        const mappedFormats = (output.formats || []).map((f: any) => ({
          format_id: f.format_id,
          url: `/api/download?url=${encodeURIComponent(targetUrl)}&format_id=${encodeURIComponent(f.format_id)}&title=${encodeURIComponent(output.title || "video")}`,
          ext: isPhoto ? "png" : "mp4", // If photo, we'll convert to png on download
          height: f.height,
          vcodec: f.vcodec,
          acodec: f.acodec,
          abr: f.abr,
          filesize: f.filesize,
          note: f.format_note || f.note || ""
        })).filter((f: any) => isPhoto || (f.vcodec !== "none" || f.format_id === "best"));

        // Ensure we have at least one "universal" format
        if (mappedFormats.length === 0) {
          mappedFormats.push({
            format_id: "universal",
            url: `/api/download?url=${encodeURIComponent(targetUrl)}&title=${encodeURIComponent(output.title || "video")}`,
            ext: isPhoto ? "png" : "mp4",
            note: isPhoto ? "High Quality Photo" : "Universal Quality (Best Compatible)",
            vcodec: isPhoto ? "none" : "h264",
            acodec: isPhoto ? "none" : "aac"
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
          mediaType: mediaType,
          formats: mappedFormats,
          webpage_url: output.webpage_url || targetUrl
        };

        return res.json(cleanedData);
      } catch (ytdlError: any) {
        console.warn("yt-dlp extraction failed, using fallback:", ytdlError.message);
        
        // If it's a known non-recoverable error like rate limit, don't even try fallback
        if (ytdlError.message.includes("rate limit") || ytdlError.message.includes("Rate exceeded")) {
          return res.status(429).json({ error: ytdlError.message });
        }

        // Robust fallback logic for UI preview if yt-dlp fails
        try {
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
          
          // Better placeholder strategy
          let thumbnail = ogImage ? ogImage[1].replace(/&amp;/g, '&') : "";
          if (!thumbnail) {
            if (targetUrl.includes("instagram.com")) thumbnail = "https://www.instagram.com/static/images/ico/favicon-200.png/ab6dea7bc453.png";
            else if (targetUrl.includes("facebook.com")) thumbnail = "https://www.facebook.com/images/fb_icon_325x325.png";
            else if (targetUrl.includes("tiktok.com")) thumbnail = "https://lf16-tiktok-web.ttwstatic.com/obj/tiktok-web-common-sg/mtact/static/images/logo_144c91a5.png";
            else thumbnail = `https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=800&q=80`; // Generic social media icon
          }

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
      } catch (fallbackError: any) {
        console.error("Fallback extraction also failed:", fallbackError.message);
        return res.status(500).json({ error: "Media extraction failed. The content might be private or restricted." });
      }
    }
  } catch (error: any) {
    console.error("Global extraction error:", error);
    res.status(500).json({ error: error.message || "Extraction failed" });
  }
});

  // API: Universal Download & Merge
  app.get("/api/download", async (req, res) => {
    const { url, format_id, title, mode } = req.query;
    if (!url) return res.status(400).send("URL is required");

    const targetUrl = getCleanUrl(url as string);
    const jobId = crypto.randomBytes(8).toString("hex");
    
    // We'll decide the filename extension later
    let outputFilename = `${jobId}`;
    let outputPath = path.join(TEMP_DIR, outputFilename);

    try {
      console.log(`[Job ${jobId}] Starting download for:`, targetUrl);

      const isYoutube = targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
      const isInstagram = targetUrl.includes("instagram.com");
      const isTikTok = targetUrl.includes("tiktok.com");
      const isFacebook = targetUrl.includes("facebook.com") || targetUrl.includes("fb.watch") || targetUrl.includes("fb.com");
      const isX = targetUrl.includes("x.com") || targetUrl.includes("twitter.com");

      let extractorArgs = undefined;
      if (isYoutube) {
        extractorArgs = "youtube:player-client=web_embedded,mweb,android;player-skip=webpage";
      } else if (isInstagram) {
        extractorArgs = 'instagram:user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"';
      } else if (isTikTok) {
        extractorArgs = 'tiktok:user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"';
      } else if (isFacebook) {
        extractorArgs = 'facebook:user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"';
      } else if (isX) {
        extractorArgs = 'twitter:user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"';
      }

      const metadataRaw = await youtubeDl(targetUrl, {
        dumpSingleJson: true,
        noPlaylist: true,
        noCheckCertificates: true,
        quiet: true,
        extractorArgs,
        referer: isFacebook ? "https://www.facebook.com/" : (isInstagram ? "https://www.instagram.com/" : (isTikTok ? "https://www.tiktok.com/" : (isX ? "https://x.com/" : "https://www.google.com/"))),
        addHeader: [
          "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language: en-US,en;q=0.9",
          "Sec-Fetch-Mode: navigate",
          "Sec-Fetch-Site: same-origin",
          "Sec-Fetch-Dest: document"
        ],
        cookies: undefined,
      } as any);

      let metadata: any;
      try {
        metadata = typeof metadataRaw === "string" ? JSON.parse(metadataRaw) : metadataRaw;
      } catch (e) {
        // If it's not JSON, it might be a rate limit or other error message
        if (typeof metadataRaw === "string" && metadataRaw.includes("Rate exceeded")) {
          throw new Error("Facebook/Platform rate limit exceeded. Please try again in a few minutes.");
        }
        throw new Error("Failed to parse metadata from platform. The content might be private or restricted.");
      }

      if (!metadata) throw new Error("No metadata returned from platform.");

      const isPhoto = metadata.extractor === 'instagram:photo' || 
                      metadata.extractor?.includes('photo') || 
                      metadata.extractor?.includes('image') ||
                      (metadata.formats && metadata.formats.length > 0 && metadata.formats.every((f: any) => 
                        (!f.vcodec || f.vcodec === 'none') && 
                        (f.ext === 'jpg' || f.ext === 'png' || f.ext === 'webp' || f.ext === 'jpeg')
                      ));

      // Preferred format string
      const formatSelection = format_id 
        ? `${format_id}+bestaudio[ext=m4a]/best[ext=mp4]/best`
        : "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a][acodec^=mp4a]/best[ext=mp4][vcodec^=avc1]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";

      if (isPhoto) {
        // Download the photo
        const tempPhotoPath = path.join(TEMP_DIR, `${jobId}_raw`);
        await youtubeDl(targetUrl, {
          format: format_id || "best",
          output: tempPhotoPath,
          noPlaylist: true,
          noCheckCertificates: true,
          extractorArgs,
          referer: isFacebook ? "https://www.facebook.com/" : (isInstagram ? "https://www.instagram.com/" : (isTikTok ? "https://www.tiktok.com/" : (isX ? "https://x.com/" : "https://www.google.com/"))),
          addHeader: [
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Accept: image/avif,image/webp,*/*",
            "Accept-Language: en-US,en;q=0.9",
            "Sec-Fetch-Mode: no-cors",
            "Sec-Fetch-Site: cross-site"
          ]
        } as any);

        // Convert to PNG using ffmpeg
        const finalPngPath = path.join(TEMP_DIR, `${jobId}.png`);
        const { spawnSync } = await import("child_process");
        spawnSync(ffmpeg!, ["-i", tempPhotoPath, finalPngPath], { stdio: "ignore" });
        
        if (fs.existsSync(tempPhotoPath)) fs.removeSync(tempPhotoPath);
        outputPath = finalPngPath;
        outputFilename = `${jobId}.png`;
      } else {
        // Download video
        const finalVideoPath = path.join(TEMP_DIR, `${jobId}.mp4`);
        await youtubeDl(targetUrl, {
          format: formatSelection,
          ffmpegLocation: ffmpeg || undefined,
          output: finalVideoPath,
          mergeOutputFormat: "mp4",
          noPlaylist: true,
          noCheckCertificates: true,
          noWarnings: true,
          quiet: true,
          geoBypass: true,
          extractorArgs,
          referer: isFacebook ? "https://www.facebook.com/" : (isInstagram ? "https://www.instagram.com/" : (isTikTok ? "https://www.tiktok.com/" : (isX ? "https://x.com/" : "https://www.google.com/"))),
          addHeader: [
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language: en-US,en;q=0.9",
            "Sec-Fetch-Mode: navigate",
            "Sec-Fetch-Dest: video",
            "Sec-Fetch-Site: same-origin"
          ]
        } as any);
        outputPath = finalVideoPath;
        outputFilename = `${jobId}.mp4`;
      }

      if (!fs.existsSync(outputPath)) {
        throw new Error("File was not created after download process.");
      }

      const stats = fs.statSync(outputPath);
      const sanitizedTitle = ((title as string) || "video").replace(/[^a-zA-Z0-9\u00C0-\u017F]/g, "_");
      
      // Serve the file
      const contentType = isPhoto ? "image/png" : "video/mp4";
      const fileExt = isPhoto ? "png" : "mp4";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Accept-Ranges", "bytes");
      
      const disposition = mode === "download" ? "attachment" : "inline";
      res.setHeader("Content-Disposition", `${disposition}; filename="${sanitizedTitle}.${fileExt}"`);

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