/**
 * VidScript Server (Optimized)
 * Supports: Instagram (GraphQL w/ Session), Facebook, X/Twitter, YouTube, TikTok
 */

import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import youtubeDl from "youtube-dl-exec";
import cors from "cors";
import axios from "axios";
import ffmpegStatic from "ffmpeg-static";
import fs from "fs-extra";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(process.cwd(), "temp_downloads");
fs.ensureDirSync(TEMP_DIR);

const app = express();
app.use(cors());
app.use(express.json());

// ─── Environment Variables ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const INSTAGRAM_SESSION_ID = process.env.INSTAGRAM_SESSION_ID || "";

// ─── User Agents ─────────────────────────────────────────────────────────────
const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function detectPlatform(url: string) {
  if (/instagram\.com/.test(url)) return "instagram";
  if (/facebook\.com|fb\.watch|fb\.com/.test(url)) return "facebook";
  if (/x\.com|twitter\.com/.test(url)) return "twitter";
  if (/youtube\.com|youtu\.be/.test(url)) return "youtube";
  if (/tiktok\.com/.test(url)) return "tiktok";
  return "unknown";
}

function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const platform = detectPlatform(raw);
    if (platform === "instagram") {
      u.search = "";
      u.hash = "";
      if (!u.pathname.endsWith("/")) u.pathname += "/";
    } else if (platform === "facebook") {
      ["extid", "ref", "mibextid", "__cft__[0]", "__tn__"].forEach((p) => u.searchParams.delete(p));
    } else if (platform === "twitter") {
      ["s", "t", "ref_src", "ref_url"].forEach((p) => u.searchParams.delete(p));
    } else if (platform === "youtube") {
      if (u.searchParams.has("v")) {
        const v = u.searchParams.get("v")!;
        u.search = `?v=${v}`;
      }
    }
    return u.toString();
  } catch {
    return raw;
  }
}

// ─── Instagram Extractor (w/ Session Cookie) ─────────────────────────────────
const IG_APP_ID = "936619743392459";
const IG_LSD = "AVqbxe3J_YA";
const IG_DOC_ID = "10015901848480474";

async function extractInstagram(rawUrl: string) {
  const shortcodeMatch = rawUrl.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  const shortcode = shortcodeMatch ? shortcodeMatch[1] : null;
  if (!shortcode) throw new Error("Could not parse Instagram shortcode.");

  const body = new URLSearchParams({
    variables: JSON.stringify({ shortcode }),
    doc_id: IG_DOC_ID,
    lsd: IG_LSD,
  });

  const headers: any = {
    "User-Agent": UA_DESKTOP,
    "Content-Type": "application/x-www-form-urlencoded",
    "X-IG-App-ID": IG_APP_ID,
    "X-FB-LSD": IG_LSD,
    "X-ASBD-ID": "129477",
    Referer: "https://www.instagram.com/",
    Origin: "https://www.instagram.com",
    Accept: "*/*",
  };

  if (INSTAGRAM_SESSION_ID) {
    headers.Cookie = `sessionid=${INSTAGRAM_SESSION_ID}`;
  }

  const res = await axios.post("https://www.instagram.com/api/graphql", body.toString(), {
    headers,
    timeout: 15000,
  });

  const media = res.data?.data?.xdt_shortcode_media;
  if (!media) {
    throw new Error(
      INSTAGRAM_SESSION_ID
        ? "Instagram returned no data. The post may be private, deleted, or restricted."
        : "Instagram blocked the request. Please add INSTAGRAM_SESSION_ID to your .env file."
    );
  }

  const typename = media.__typename || "";
  const isVideo = typename === "XDTGraphVideo" || !!media.video_url;
  const isCarousel = typename === "XDTGraphSidecar" || !!media.edge_sidecar_to_children;
  const uploader = media.owner?.username || "instagram";
  const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text || "";
  const title = caption ? caption.substring(0, 80).replace(/\n/g, " ") : `Instagram Media by @${uploader}`;
  const thumbnail = media.thumbnail_src || media.display_url || "";

  const formats: any[] = [];
  if (isCarousel) {
    const edges = media.edge_sidecar_to_children?.edges || [];
    edges.forEach((edge: any, idx: number) => {
      const node = edge.node;
      const isNodeVideo = !!node.video_url;
      formats.push({
        format_id: `slide_${idx}_${isNodeVideo ? "video" : "photo"}`,
        url: `/api/ig/download?cdn=${encodeURIComponent(isNodeVideo ? node.video_url : node.display_url)}&ext=${isNodeVideo ? "mp4" : "jpg"}&title=${encodeURIComponent(title)}`,
        previewUrl: `/api/ig/proxy?cdn=${encodeURIComponent(isNodeVideo ? node.video_url : node.display_url)}`,
        ext: isNodeVideo ? "mp4" : "jpg",
        note: `Slide ${idx + 1} — ${isNodeVideo ? "Video" : "Photo"}`,
        vcodec: isNodeVideo ? "h264" : "none",
        acodec: isNodeVideo ? "aac" : "none",
      });
    });
  } else {
    formats.push({
      format_id: isVideo ? "video_hd" : "photo_hd",
      url: `/api/ig/download?cdn=${encodeURIComponent(isVideo ? media.video_url : media.display_url)}&ext=${isVideo ? "mp4" : "jpg"}&title=${encodeURIComponent(title)}`,
      previewUrl: `/api/ig/proxy?cdn=${encodeURIComponent(isVideo ? media.video_url : media.display_url)}`,
      ext: isVideo ? "mp4" : "jpg",
      note: isVideo ? "HD Video" : "HD Photo",
      vcodec: isVideo ? "h264" : "none",
      acodec: isVideo ? "aac" : "none",
    });
  }

  return {
    id: shortcode,
    title,
    thumbnail,
    uploader,
    duration: media.video_duration || 0,
    mediaType: isCarousel ? "carousel" : isVideo ? "video" : "photo",
    formats,
    webpage_url: rawUrl,
    extractor: "instagram",
  };
}

// ─── yt-dlp Extractor (FB, X, YT, TikTok) ────────────────────────────────────
async function extractYtdlp(url: string) {
  const platform = detectPlatform(url);
  const ua = platform === "facebook" || platform === "tiktok" ? UA_MOBILE : UA_DESKTOP;

  const raw = await youtubeDl(url, {
    format: "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    dumpSingleJson: true,
    noWarnings: true,
    noPlaylist: true,
    addHeader: [`User-Agent: ${ua}`, "Accept-Language: en-US,en;q=0.9"],
  } as any);

  const output: any = typeof raw === "string" ? JSON.parse(raw) : raw;
  const formats = (output.formats || [])
    .filter((f: any) => f.vcodec !== "none" || f.acodec !== "none")
    .map((f: any) => ({
      format_id: f.format_id,
      url: `/api/download?url=${encodeURIComponent(url)}&format_id=${encodeURIComponent(f.format_id)}&title=${encodeURIComponent(output.title)}`,
      previewUrl: f.url,
      ext: "mp4",
      height: f.height,
      width: f.width,
      vcodec: f.vcodec,
      acodec: f.acodec,
      note: f.format_note || f.note || "",
    }));

  return {
    id: output.id,
    title: output.title,
    thumbnail: output.thumbnail,
    uploader: output.uploader || output.channel || "",
    duration: output.duration || 0,
    mediaType: "video",
    formats,
    webpage_url: url,
    extractor: platform,
  };
}

// ─── API Routes ──────────────────────────────────────────────────────────────
app.post("/api/extract", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    const cleaned = cleanUrl(url);
    const platform = detectPlatform(cleaned);
    const data = platform === "instagram" ? await extractInstagram(cleaned) : await extractYtdlp(cleaned);
    res.json(data);
  } catch (err: any) {
    console.error("Extract error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Instagram Proxy (handles session cookie for CDN)
app.get("/api/ig/proxy", async (req, res) => {
  const { cdn } = req.query;
  if (!cdn) return res.status(400).send("CDN URL required");

  try {
    const headers: any = { "User-Agent": UA_DESKTOP, Referer: "https://www.instagram.com/" };
    if (INSTAGRAM_SESSION_ID) headers.Cookie = `sessionid=${INSTAGRAM_SESSION_ID}`;

    const response = await axios.get(cdn as string, { headers, responseType: "stream", timeout: 10000 });
    res.setHeader("Content-Type", response.headers["content-type"] || "application/octet-stream");
    response.data.pipe(res);
  } catch (err: any) {
    res.status(500).send("Proxy error: " + err.message);
  }
});

// Instagram Download
app.get("/api/ig/download", async (req, res) => {
  const { cdn, ext, title } = req.query;
  const fileName = `${(title as string || "instagram_media").replace(/[^a-z0-9]/gi, "_")}.${ext || "mp4"}`;

  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  try {
    const headers: any = { "User-Agent": UA_DESKTOP, Referer: "https://www.instagram.com/" };
    if (INSTAGRAM_SESSION_ID) headers.Cookie = `sessionid=${INSTAGRAM_SESSION_ID}`;

    const response = await axios.get(cdn as string, { headers, responseType: "stream" });
    response.data.pipe(res);
  } catch (err: any) {
    res.status(500).send("Download error: " + err.message);
  }
});

// yt-dlp Download (handles merging video/audio)
app.get("/api/download", (req, res) => {
  const { url, format_id, title } = req.query;
  const fileName = `${(title as string || "video").replace(/[^a-z0-9]/gi, "_")}.mp4`;

  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Type", "video/mp4");

  const platform = detectPlatform(url as string);
  const ua = platform === "facebook" || platform === "tiktok" ? UA_MOBILE : UA_DESKTOP;

  const ytdlp = spawn("yt-dlp", [
    url as string,
    "-f", format_id as string,
    "--add-header", `User-Agent: ${ua}`,
    "--ffmpeg-location", ffmpegStatic || "ffmpeg",
    "-o", "-",
  ]);

  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on("data", (data) => console.error(`yt-dlp stderr: ${data}`));
  ytdlp.on("close", (code) => {
    if (code !== 0) console.error(`yt-dlp exited with code ${code}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`✅ VidScript running at http://localhost:${PORT}`));
}

start().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});
