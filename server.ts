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
        const isFacebook = url.includes("facebook.com") || url.includes("fb.watch") || url.includes("fb.com");
        const isX = url.includes("x.com") || url.includes("twitter.com");
        
        const output = await youtubeDl(url, {
          format: "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a][acodec^=mp4a]/best[ext=mp4][vcodec^=avc1]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
          noPlaylist: true,
          flatPlaylist: true,
          quiet: true,
          referer: isFacebook ? "https://www.facebook.com/" : (isX ? "https://x.com/" : url),
          addHeader: [
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Accept-Language: en-US,en;q=0.9",
            "Sec-Ch-Ua: \"Not A(Brand\";v=\"99\", \"Google Chrome\";v=\"121\", \"Chromium\";v=\"121\"",
            "Sec-Ch-Ua-Mobile: ?0",
            "Sec-Ch-Ua-Platform: \"Windows\""
          ]
        });
        return res.json(output);
      } catch (ytdlError: any) {
        // Only log if not a standard social media block (which is expected)
        if (
          !ytdlError.message.includes("Instagram") &&
          !ytdlError.message.includes("TikTok") &&
          !ytdlError.message.includes("Facebook")
        ) {
          console.warn("yt-dlp failed, trying robust fallback...");
        }
        
        // Robust fallback for UI preview if yt-dlp fails
        const pageRes = await axios.get(url, {
          headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9"
          },
          timeout: 8000,
          maxRedirects: 5
        });
        
        const html = pageRes.data;
        
        // Extract Title
        const ogTitle = html.match(/<meta property="og:title" content="(.*?)"/i) || html.match(/<meta name="twitter:title" content="(.*?)"/i);
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const title = ogTitle ? ogTitle[1] : (titleMatch ? titleMatch[1] : "Social Video Content");
        
        // Extract Thumbnail
        const ogImage = html.match(/<meta property="og:image" content="(.*?)"/i) || html.match(/<meta name="twitter:image" content="(.*?)"/i);
        const thumbnail = ogImage ? ogImage[1] : `https://picsum.photos/seed/${Math.random().toString(36)}/800/450`;

        // Extract Description
        const ogDesc = html.match(/<meta property="og:description" content="(.*?)"/i) || html.match(/<meta name="description" content="(.*?)"/i);
        const description = ogDesc ? ogDesc[1] : "Video successfully identified. Our AI is preparing the high-quality, watermark-free download link.";

        // Attempt to find actual video URL in meta tags for fallback
        const videoMatches = [
          html.match(/<meta property="og:video" content="(.*?)"/i),
          html.match(/<meta property="og:video:url" content="(.*?)"/i),
          html.match(/<meta property="og:video:secure_url" content="(.*?)"/i),
          html.match(/"video_url":"(.*?)"/),
          html.match(/"download_addr":"(.*?)"/), // TikTok
          html.match(/"play_addr":"(.*?)"/), // TikTok alternative
          html.match(/"display_url":"(.*?)"/), // Instagram photo
        ].filter(Boolean);
        
        let extractedVideoUrl = url;
        if (videoMatches.length > 0) {
          extractedVideoUrl = videoMatches[0]![1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\/g, '');
        }

        // More aggressive Instagram Reel and Video scraping
        if (url.includes("instagram.com")) {
           const instaVideoMatches = html.match(/"video_url":"([^"]+)"/) || 
                                    html.match(/"video_dash_manifest":"([^"]+)"/) ||
                                    html.match(/property="og:video"\s+content="([^"]+)"/);
           if (instaVideoMatches && instaVideoMatches[1]) {
             extractedVideoUrl = instaVideoMatches[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
           }
        }

        // TikTok Specific Extraction
        if (url.includes("tiktok.com")) {
           const tiktokMatches = html.match(/"playAddr":"([^"]+)"/) || html.match(/"downloadAddr":"([^"]+)"/) || html.match(/"play_addr":{"url_list":\["([^"]+)"/);
           if (tiktokMatches && tiktokMatches[1]) {
             extractedVideoUrl = tiktokMatches[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
           }
        }

        // Facebook Specific Extraction
        if (url.includes("facebook.com") || url.includes("fb.watch")) {
           const fbMatches = html.match(/"hd_src":"([^"]+)"/) || html.match(/"sd_src":"([^"]+)"/) || html.match(/video: \[{url: "([^"]+)"/);
           if (fbMatches && fbMatches[1]) {
              extractedVideoUrl = fbMatches[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
           }
        }

        // Identify Media Type - Only treat as photo if explicitly a Pinterest or known photo-only path
        let mediaType: "video" | "photo" | "carousel" = "video";
        const images: string[] = [];
        const lowUrl = url.toLowerCase();

        if (lowUrl.includes("pinterest.com")) {
          mediaType = "photo";
        }

        // Refined fallback check: ensure we really have a media URL
        const isValidMedia = extractedVideoUrl && 
                           extractedVideoUrl.startsWith("http") && 
                           !extractedVideoUrl.includes("instagram.com/p/") && 
                           !extractedVideoUrl.includes("tiktok.com/@") &&
                           !extractedVideoUrl.includes("facebook.com/watch") &&
                           extractedVideoUrl !== url;

        if (!isValidMedia) {
           console.warn("Direct media link not found in metadata for:", url);
           // Fallback to photo only if we really can't find a video and it's a platform known for photos
           if (lowUrl.includes("instagram.com/p/")) {
             mediaType = "photo";
           }
        }

        const fallbackData = {
          title: title.replace(/&amp;/g, '&').replace(/&quot;/g, '"'),
          thumbnail: thumbnail.replace(/&amp;/g, '&'),
          uploader: url.split('/')[2].replace('www.', ''),
          extractor: lowUrl.includes('youtube') ? 'youtube' : (lowUrl.includes('tiktok') ? 'tiktok' : (lowUrl.includes('instagram') ? 'instagram' : (lowUrl.includes('facebook') ? 'facebook' : (lowUrl.includes('twitter.com') || lowUrl.includes('x.com') ? 'twitter' : 'video')))),
          duration: 0,
          description: (description || "").substring(0, 200).replace(/&amp;/g, '&'),
          mediaType,
          images,
          formats: mediaType === "video" && isValidMedia ? [
            { format_id: "direct", url: extractedVideoUrl, ext: "mp4", note: "Mobile Compatible MP4", quality: 10 }
          ] : [],
          webpage_url: url
        };

        return res.json(fallbackData);
      }
    } catch (error: any) {
      console.error("Extraction error:", error);
      res.status(500).json({ 
        error: "Server connection failed", 
        details: "Social media platforms sometimes block data center requests. Please try again or use the official link." 
      });
    }
  });

  // API: Proxy download (to bypass CORS and headers)
  app.get("/api/proxy", async (req, res) => {
    const { url, filename } = req.query;
    if (!url) return res.status(400).send("URL is required");

    // Block local/internal URLs
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
      
      // High-compatibility headers for streaming media platforms
      const headers: any = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,image/*,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
        "Accept-Encoding": "identity", // Force raw stream
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Dest": "video",
      };

      if (isInstagram) {
        headers["Referer"] = "https://www.instagram.com/";
        headers["Origin"] = "https://www.instagram.com";
      } else if (isFacebook) {
        headers["Referer"] = "https://www.facebook.com/";
      } else if (isTikTok) {
        headers["Referer"] = "https://www.tiktok.com/";
        headers["User-Agent"] = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
      } else if (isTwitter) {
        headers["Referer"] = "https://x.com/";
      }

      if (range) {
        headers.Range = range;
      }

      const response = await axios({
        method: "get",
        url: urlStr,
        responseType: "stream",
        timeout: 90000, // Increase to 90s for large files
        maxRedirects: 10,
        headers,
        validateStatus: (status) => status < 400,
      });

      // Verification: Check if it's actually media or an error page
      const contentTypeHeader = String(response.headers["content-type"] || "");
      const contentLengthHeader = parseInt(String(response.headers["content-length"] || "0"), 10);

      if (contentTypeHeader.includes("text/html") && !urlStr.includes(".m3u8")) {
         throw new Error("Target platform returned HTML instead of media stream.");
      }
      
      // If content length is suspiciously small (e.g. < 500 bytes), it's likely an error message
      if (contentLengthHeader > 0 && contentLengthHeader < 500) {
        throw new Error("Media source provided an invalid or empty stream.");
      }

      // Set broad compatibility headers-
      let sanitizedFilename = (filename as string || "file").replace(/[^a-zA-Z0-9.\-_]/g, "_");
      if (!sanitizedFilename.includes('.')) sanitizedFilename += ".mp4"; // Default fallback ext
      
      // Force correct extensions (Audio vs Video vs Image)
      const lowFile = (filename as string || "").toLowerCase();
      const isAudio = lowFile.endsWith(".mp3") || lowFile.endsWith(".m4a");
      const isImage = lowFile.endsWith(".jpg") || lowFile.endsWith(".jpeg") || lowFile.endsWith(".png") || lowFile.endsWith(".webp");
      
      let finalContentType = "application/octet-stream";

      if (isAudio) {
        if (!sanitizedFilename.toLowerCase().endsWith(".mp3") && !sanitizedFilename.toLowerCase().endsWith(".m4a")) {
          sanitizedFilename = sanitizedFilename.replace(/\.[^/.]+$/, "") + ".mp3";
        }
        finalContentType = isTwitter ? "audio/mpeg" : (contentTypeHeader.includes("audio") ? contentTypeHeader : "audio/mpeg");
      } else if (isImage) {
        const ext = lowFile.split('.').pop() || "jpg";
        if (!sanitizedFilename.toLowerCase().endsWith("." + ext)) {
          sanitizedFilename = sanitizedFilename.replace(/\.[^/.]+$/, "") + "." + ext;
        }
        finalContentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      } else {
        if (!sanitizedFilename.toLowerCase().endsWith(".mp4")) {
          sanitizedFilename = sanitizedFilename.replace(/\.[^/.]+$/, "") + ".mp4";
        }
        // Strongly force video/mp4 for these platforms to ensure QuickTime recognizes them
        if (isInstagram || isFacebook || isTikTok || isTwitter || (urlStr as string).includes("youtube.com")) {
          finalContentType = "video/mp4";
        } else {
          finalContentType = contentTypeHeader.includes("video") ? contentTypeHeader : "video/mp4";
        }
      }

      // Hardened Compatibility Headers for Mobile & Desktop Players
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", finalContentType);
      res.setHeader("Content-Transfer-Encoding", "binary");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${sanitizedFilename}"`,
      );

      if (response.headers["content-length"]) {
        res.setHeader("Content-Length", String(response.headers["content-length"]));
      }
      if (response.headers["content-range"]) {
        res.setHeader("Content-Range", String(response.headers["content-range"]));
      }

      if (response.status === 206) {
        res.status(206);
      }

      // Stream piping
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
