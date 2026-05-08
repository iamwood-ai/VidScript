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

// ─────────────────────────────────────────────────────────────────────────────
// Instagram GraphQL extractor (replaces broken yt-dlp Instagram path)
// Uses Instagram's internal /api/graphql endpoint – no login required for
// public posts (Reels, posts, carousels, photos).
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the shortcode from any Instagram URL */
function getInstagramShortcode(url: string): string | null {
  // Matches /p/, /reel/, /reels/, /tv/ shortcodes
  const match = url.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

interface InstagramMedia {
  title: string;
  thumbnail: string;
  uploader: string;
  duration: number;
  mediaType: "video" | "photo" | "carousel";
  formats: Array<{
    format_id: string;
    url: string;
    previewUrl: string;
    ext: string;
    height?: number;
    width?: number;
    vcodec: string;
    acodec: string;
    note: string;
    filesize?: number;
  }>;
  webpage_url: string;
  extractor: string;
  id: string;
  description: string;
}

async function extractInstagramMedia(rawUrl: string): Promise<InstagramMedia> {
  const shortcode = getInstagramShortcode(rawUrl);
  if (!shortcode) throw new Error("Could not parse Instagram shortcode from URL.");

  const IG_APP_ID = "936619743392459"; // Public Instagram web app ID (stable)
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // Build the GraphQL request
  const graphqlUrl = new URL("https://www.instagram.com/api/graphql");
  const body = new URLSearchParams({
    variables: JSON.stringify({ shortcode }),
    doc_id: "10015901848480474",
    lsd: "AVqbxe3J_YA",
  });

  const response = await axios.post(graphqlUrl.toString(), body.toString(), {
    headers: {
      "User-Agent": userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-IG-App-ID": IG_APP_ID,
      "X-FB-LSD": "AVqbxe3J_YA",
      "X-ASBD-ID": "129477",
      "Referer": "https://www.instagram.com/",
      "Origin": "https://www.instagram.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 15000,
  });

  const json = response.data;
  const media = json?.data?.xdt_shortcode_media;

  if (!media) {
    throw new Error(
      "Instagram returned no media data. The post may be private, deleted, or age-restricted."
    );
  }

  const typename: string = media.__typename || "";
  const isVideo = typename === "XDTGraphVideo" || !!media.video_url;
  const isCarousel = typename === "XDTGraphSidecar" || !!media.edge_sidecar_to_children;
  const isPhoto = !isVideo && !isCarousel;

  const uploader =
    media.owner?.username || media.owner?.full_name || "instagram";
  const caption: string =
    media.edge_media_to_caption?.edges?.[0]?.node?.text || "";
  const title = caption
    ? caption.substring(0, 80).replace(/\n/g, " ")
    : `Instagram ${isVideo ? "Reel" : isCarousel ? "Carousel" : "Photo"} by @${uploader}`;
  const thumbnail: string =
    media.thumbnail_src ||
    media.display_url ||
    media.display_resources?.[media.display_resources.length - 1]?.src ||
    "";

  const formats: InstagramMedia["formats"] = [];

  if (isCarousel) {
    // Carousel: multiple images/videos
    const edges = media.edge_sidecar_to_children?.edges || [];
    edges.forEach((edge: any, idx: number) => {
      const node = edge.node;
      const isNodeVideo = !!node.video_url;
      if (isNodeVideo) {
        formats.push({
          format_id: `carousel_${idx}_video`,
          url: `/api/ig-download?url=${encodeURIComponent(rawUrl)}&index=${idx}&type=video`,
          previewUrl: `/api/ig-proxy?url=${encodeURIComponent(node.video_url)}`,
          ext: "mp4",
          height: node.dimensions?.height,
          width: node.dimensions?.width,
          vcodec: "h264",
          acodec: "aac",
          note: `Slide ${idx + 1} – Video`,
        });
      } else {
        const imgUrl =
          node.display_resources?.[node.display_resources.length - 1]?.src ||
          node.display_url;
        formats.push({
          format_id: `carousel_${idx}_photo`,
          url: `/api/ig-download?url=${encodeURIComponent(rawUrl)}&index=${idx}&type=photo`,
          previewUrl: `/api/ig-proxy?url=${encodeURIComponent(imgUrl)}`,
          ext: "jpg",
          height: node.dimensions?.height,
          width: node.dimensions?.width,
          vcodec: "none",
          acodec: "none",
          note: `Slide ${idx + 1} – Photo`,
        });
      }
    });
  } else if (isVideo) {
    formats.push({
      format_id: "video_hd",
      url: `/api/ig-download?url=${encodeURIComponent(rawUrl)}&index=0&type=video`,
      previewUrl: `/api/ig-proxy?url=${encodeURIComponent(media.video_url)}`,
      ext: "mp4",
      height: media.dimensions?.height,
      width: media.dimensions?.width,
      vcodec: "h264",
      acodec: "aac",
      note: "HD Video",
    });
  } else {
    // Photo
    const imgUrl =
      media.display_resources?.[media.display_resources.length - 1]?.src ||
      media.display_url;
    formats.push({
      format_id: "photo_hd",
      url: `/api/ig-download?url=${encodeURIComponent(rawUrl)}&index=0&type=photo`,
      previewUrl: `/api/ig-proxy?url=${encodeURIComponent(imgUrl)}`,
      ext: "jpg",
      height: media.dimensions?.height,
      width: media.dimensions?.width,
      vcodec: "none",
      acodec: "none",
      note: "HD Photo",
    });
  }

  return {
    id: shortcode,
    title,
    thumbnail,
    uploader,
    duration: media.video_duration || 0,
    description: caption.substring(0, 200),
    mediaType: isCarousel ? "carousel" : isVideo ? "video" : "photo",
    formats,
    webpage_url: rawUrl,
    extractor: "instagram",
  };
}

/** Fetch raw Instagram media data for the download endpoint */
async function fetchInstagramRawMedia(
  rawUrl: string,
  index: number,
  type: "video" | "photo"
): Promise<string> {
  const shortcode = getInstagramShortcode(rawUrl);
  if (!shortcode) throw new Error("Invalid Instagram URL.");

  const IG_APP_ID = "936619743392459";
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const body = new URLSearchParams({
    variables: JSON.stringify({ shortcode }),
    doc_id: "10015901848480474",
    lsd: "AVqbxe3J_YA",
  });

  const response = await axios.post(
    "https://www.instagram.com/api/graphql",
    body.toString(),
    {
      headers: {
        "User-Agent": userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-IG-App-ID": IG_APP_ID,
        "X-FB-LSD": "AVqbxe3J_YA",
        "X-ASBD-ID": "129477",
        "Referer": "https://www.instagram.com/",
        "Origin": "https://www.instagram.com",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    }
  );

  const media = response.data?.data?.xdt_shortcode_media;
  if (!media) throw new Error("No media data from Instagram.");

  const isCarousel = !!media.edge_sidecar_to_children;

  if (isCarousel) {
    const edges = media.edge_sidecar_to_children?.edges || [];
    const node = edges[index]?.node;
    if (!node) throw new Error(`Carousel item ${index} not found.`);
    if (type === "video") return node.video_url;
    const imgUrl =
      node.display_resources?.[node.display_resources.length - 1]?.src ||
      node.display_url;
    return imgUrl;
  }

  if (type === "video") return media.video_url;
  const imgUrl =
    media.display_resources?.[media.display_resources.length - 1]?.src ||
    media.display_url;
  return imgUrl;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL cleaner
// ─────────────────────────────────────────────────────────────────────────────

function getCleanUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.includes("instagram.com")) {
      parsed.search = "";
      parsed.hash = "";
      if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    } else if (
      parsed.hostname.includes("facebook.com") ||
      parsed.hostname.includes("fb.watch")
    ) {
      parsed.searchParams.delete("extid");
      parsed.searchParams.delete("ref");
      parsed.searchParams.delete("mibextid");
    } else if (
      parsed.hostname.includes("x.com") ||
      parsed.hostname.includes("twitter.com")
    ) {
      parsed.searchParams.delete("s");
      parsed.searchParams.delete("t");
    }
    if (
      parsed.hostname.includes("youtube.com") &&
      parsed.searchParams.has("v")
    ) {
      const v = parsed.searchParams.get("v");
      parsed.search = `?v=${v}`;
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────

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

  // ── /api/extract ────────────────────────────────────────────────────────────
  app.post("/api/extract", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    const targetUrl = getCleanUrl(url);
    const isInstagram = targetUrl.includes("instagram.com");

    // ── Instagram: use our own GraphQL extractor ──────────────────────────────
    if (isInstagram) {
      try {
        const data = await extractInstagramMedia(targetUrl);
        return res.json(data);
      } catch (igErr: any) {
        console.error("[Instagram] Extraction failed:", igErr.message);
        return res.status(500).json({
          error:
            igErr.message ||
            "Instagram extraction failed. The post may be private or deleted.",
        });
      }
    }

    // ── All other platforms: use yt-dlp ───────────────────────────────────────
    try {
      try {
        const isFacebook =
          targetUrl.includes("facebook.com") ||
          targetUrl.includes("fb.watch") ||
          targetUrl.includes("fb.com");
        const isYoutube =
          targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
        const isTikTok = targetUrl.includes("tiktok.com");
        const isX =
          targetUrl.includes("x.com") || targetUrl.includes("twitter.com");

        let extractorArgs: string | undefined = undefined;
        const mobileUA =
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
        const desktopUA =
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

        if (isYoutube) {
          extractorArgs =
            "youtube:player-client=web_embedded,mweb,android;player-skip=webpage";
        } else if (isTikTok) {
          extractorArgs = `tiktok:user_agent="${mobileUA}"`;
        } else if (isFacebook) {
          extractorArgs = `facebook:user_agent="${mobileUA}"`;
        } else if (isX) {
          extractorArgs = `twitter:user_agent="${desktopUA}"`;
        }

        const commonHeaders = [
          `User-Agent: ${isTikTok ? mobileUA : desktopUA}`,
          "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language: en-US,en;q=0.9",
          "Upgrade-Insecure-Requests: 1",
          "Sec-Fetch-Mode: navigate",
          "Sec-Fetch-Dest: document",
        ];

        const outputRaw = await youtubeDl(targetUrl, {
          format:
            "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a][acodec^=mp4a]/best[ext=mp4][vcodec^=avc1]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
          noPlaylist: true,
          flatPlaylist: true,
          quiet: true,
          geoBypass: true,
          extractorArgs,
          referer: isFacebook
            ? "https://www.facebook.com/"
            : isTikTok
            ? "https://www.tiktok.com/"
            : isX
            ? "https://x.com/"
            : "https://www.google.com/",
          addHeader: commonHeaders,
          cookies: undefined,
        } as any);

        let output: any;
        try {
          output =
            typeof outputRaw === "string" ? JSON.parse(outputRaw) : outputRaw;
        } catch (e) {
          if (
            typeof outputRaw === "string" &&
            outputRaw.includes("Rate exceeded")
          ) {
            throw new Error(
              "Platform rate limit exceeded. Please try again in a few minutes."
            );
          }
          throw new Error(
            "Failed to parse metadata from platform. The content might be private or restricted."
          );
        }

        if (!output) throw new Error("No metadata returned from platform.");

        const isPhoto =
          output.extractor === "instagram:photo" ||
          output.extractor?.includes("photo") ||
          output.extractor?.includes("image") ||
          (output.extractor?.includes("facebook") &&
            !output.formats?.some(
              (f: any) => f.vcodec !== "none" && f.vcodec
            )) ||
          (output.formats &&
            output.formats.length > 0 &&
            output.formats.every(
              (f: any) =>
                (!f.vcodec || f.vcodec === "none") &&
                (f.ext === "jpg" ||
                  f.ext === "png" ||
                  f.ext === "webp" ||
                  f.ext === "jpeg")
            ));

        const mediaType = isPhoto ? "photo" : "video";

        const mappedFormats = (output.formats || [])
          .map((f: any) => {
            const isDirect = f.url && !isYoutube;
            const downloadUrl = `/api/download?url=${encodeURIComponent(
              targetUrl
            )}&format_id=${encodeURIComponent(
              f.format_id
            )}&title=${encodeURIComponent(output.title || "video")}`;
            const proxyUrl = isDirect
              ? `/api/proxy?url=${encodeURIComponent(
                  f.url
                )}&filename=${encodeURIComponent(
                  output.title || "video"
                )}.mp4`
              : null;

            return {
              format_id: f.format_id,
              url: downloadUrl,
              previewUrl: proxyUrl || downloadUrl,
              ext: isPhoto ? "png" : "mp4",
              height: f.height,
              vcodec: f.vcodec,
              acodec: f.acodec,
              abr: f.abr,
              filesize: f.filesize,
              note: f.format_note || f.note || "",
            };
          })
          .filter(
            (f: any) =>
              isPhoto ||
              f.vcodec !== "none" ||
              f.format_id === "best" ||
              f.format_id === "universal" ||
              f.format_id === "direct" ||
              (f.url && !f.url.includes("googlevideo.com"))
          );

        if (mappedFormats.length === 0) {
          const downloadUrl = `/api/download?url=${encodeURIComponent(
            targetUrl
          )}&title=${encodeURIComponent(output.title || "video")}`;
          mappedFormats.push({
            format_id: "universal",
            url: downloadUrl,
            previewUrl: downloadUrl,
            ext: isPhoto ? "png" : "mp4",
            note: isPhoto
              ? "High Quality Photo"
              : "Universal Quality (Best Compatible)",
            vcodec: isPhoto ? "none" : "h264",
            acodec: isPhoto ? "none" : "aac",
          });
        }

        const cleanedData = {
          id: output.id,
          title: output.title,
          thumbnail: output.thumbnail,
          uploader:
            output.uploader ||
            output.uploader_id ||
            targetUrl.split("/")[2].replace("www.", ""),
          extractor: output.extractor_key?.toLowerCase() || "",
          duration: output.duration || 0,
          description: (output.description || "").substring(0, 200),
          mediaType: mediaType,
          formats: mappedFormats,
          webpage_url: output.webpage_url || targetUrl,
        };

        return res.json(cleanedData);
      } catch (ytdlError: any) {
        console.warn(
          "yt-dlp extraction failed, using fallback:",
          ytdlError.message
        );

        if (
          ytdlError.message.includes("rate limit") ||
          ytdlError.message.includes("Rate exceeded")
        ) {
          return res.status(429).json({ error: ytdlError.message });
        }

        // HTML fallback
        try {
          const pageRes = await axios.get(targetUrl, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
            },
            timeout: 10000,
          });

          const html = pageRes.data;
          const ogTitle =
            html.match(/<meta property="og:title" content="(.*?)"/i) ||
            html.match(/<title>(.*?)<\/title>/i);
          const title = ogTitle
            ? ogTitle[1].replace(/&amp;/g, "&")
            : "Social Media Video";
          const ogImage = html.match(
            /<meta property="og:image" content="(.*?)"/i
          );

          let thumbnail = ogImage ? ogImage[1].replace(/&amp;/g, "&") : "";
          if (!thumbnail) {
            if (targetUrl.includes("facebook.com"))
              thumbnail =
                "https://www.facebook.com/images/fb_icon_325x325.png";
            else if (targetUrl.includes("tiktok.com"))
              thumbnail =
                "https://lf16-tiktok-web.ttwstatic.com/obj/tiktok-web-common-sg/mtact/static/images/logo_144c91a5.png";
            else
              thumbnail =
                "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=800&q=80";
          }

          let directUrl = "";
          const patterns = [
            /"video_url":"([^"]+)"/,
            /property="og:video:secure_url" content="([^"]+)"/,
            /property="og:video" content="([^"]+)"/,
            /"playAddr":"([^"]+)"/,
            /"downloadAddr":"([^"]+)"/,
          ];

          for (const p of patterns) {
            const m = html.match(p);
            if (m && m[1]) {
              const found = m[1].replace(/\\u0026/g, "&").replace(/\\/g, "");
              if (found.startsWith("http")) {
                directUrl = found;
                break;
              }
            }
          }

          const universalDownloadUrl = `/api/download?url=${encodeURIComponent(
            targetUrl
          )}&title=${encodeURIComponent(title)}`;
          const formats: any[] = [
            {
              format_id: "universal",
              url: universalDownloadUrl,
              previewUrl: universalDownloadUrl,
              ext: "mp4",
              note: "Universal Quality",
              vcodec: "h264",
              acodec: "aac",
            },
          ];

          if (directUrl) {
            const directProxyUrl = `/api/proxy?url=${encodeURIComponent(
              directUrl
            )}&filename=video.mp4&mode=inline`;
            formats.unshift({
              format_id: "direct",
              url: directProxyUrl,
              previewUrl: directProxyUrl,
              ext: "mp4",
              note: "Direct Feed (Backup)",
              vcodec: "h264",
              acodec: "aac",
            });
          }

          return res.json({
            title,
            thumbnail,
            uploader: targetUrl.split("/")[2].replace("www.", ""),
            extractor: "video",
            duration: 0,
            description: "Video identified via backup scanner.",
            mediaType: "video",
            formats,
            webpage_url: targetUrl,
          });
        } catch (fallbackError: any) {
          console.error(
            "Fallback extraction also failed:",
            fallbackError.message
          );
          return res.status(500).json({
            error:
              "Media extraction failed. The content might be private or restricted.",
          });
        }
      }
    } catch (error: any) {
      console.error("Global extraction error:", error);
      res.status(500).json({ error: error.message || "Extraction failed" });
    }
  });

  // ── /api/ig-proxy  (proxy Instagram CDN URLs to avoid CORS / hotlink blocks)
  app.get("/api/ig-proxy", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send("URL is required");

    const urlStr = url as string;
    if (urlStr.includes("localhost") || urlStr.includes("127.0.0.1")) {
      return res.status(403).send("Forbidden");
    }

    try {
      const response = await axios({
        method: "get",
        url: urlStr,
        responseType: "stream",
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Referer: "https://www.instagram.com/",
          Origin: "https://www.instagram.com",
          Accept: "*/*",
        },
        validateStatus: (s) => s < 400,
      });

      const ct = String(response.headers["content-type"] || "video/mp4");
      res.setHeader("Content-Type", ct);
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (response.headers["content-length"])
        res.setHeader(
          "Content-Length",
          String(response.headers["content-length"])
        );
      res.setHeader("Cache-Control", "public, max-age=3600");
      response.data.pipe(res);
    } catch (err: any) {
      console.error("[ig-proxy] error:", err.message);
      if (!res.headersSent) res.status(500).send("Failed to proxy Instagram media.");
    }
  });

  // ── /api/ig-download  (download Instagram media directly to temp file & serve)
  app.get("/api/ig-download", async (req, res) => {
    const { url, index, type, title, mode } = req.query;
    if (!url) return res.status(400).send("URL is required");

    const jobId = crypto.randomBytes(8).toString("hex");
    const mediaIndex = parseInt((index as string) || "0", 10);
    const mediaType = (type as string) === "photo" ? "photo" : "video";

    try {
      const cdnUrl = await fetchInstagramRawMedia(
        url as string,
        mediaIndex,
        mediaType
      );
      if (!cdnUrl) throw new Error("Could not resolve Instagram media URL.");

      const ext = mediaType === "photo" ? "jpg" : "mp4";
      const outputPath = path.join(TEMP_DIR, `${jobId}.${ext}`);

      // Stream CDN → temp file
      const dlResponse = await axios({
        method: "get",
        url: cdnUrl,
        responseType: "stream",
        timeout: 90000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Referer: "https://www.instagram.com/",
          Origin: "https://www.instagram.com",
          Accept: "*/*",
        },
        validateStatus: (s) => s < 400,
      });

      const writer = fs.createWriteStream(outputPath);
      dlResponse.data.pipe(writer);
      await new Promise<void>((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      if (!fs.existsSync(outputPath))
        throw new Error("File not created after Instagram download.");

      const stats = fs.statSync(outputPath);
      const sanitizedTitle = ((title as string) || "instagram_media").replace(
        /[^a-zA-Z0-9\u00C0-\u017F]/g,
        "_"
      );
      const contentType =
        mediaType === "photo" ? "image/jpeg" : "video/mp4";
      const disposition =
        mode === "download" ? "attachment" : "inline";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${sanitizedTitle}.${ext}"`
      );

      const readStream = fs.createReadStream(outputPath);
      readStream.pipe(res);
      res.on("finish", () => {
        try {
          fs.removeSync(outputPath);
        } catch (_) {}
      });
      readStream.on("error", (err) => {
        console.error("[ig-download] stream error:", err);
        if (!res.headersSent) res.status(500).end();
      });
    } catch (err: any) {
      console.error("[ig-download] failed:", err.message);
      if (!res.headersSent)
        res
          .status(500)
          .send(
            "Instagram download failed. The post may be private or the link expired."
          );
    }
  });

  // ── /api/download  (yt-dlp based download for non-Instagram platforms) ──────
  app.get("/api/download", async (req, res) => {
    const { url, format_id, title, mode } = req.query;
    if (!url) return res.status(400).send("URL is required");

    const targetUrl = getCleanUrl(url as string);
    const jobId = crypto.randomBytes(8).toString("hex");

    let outputFilename = `${jobId}`;
    let outputPath = path.join(TEMP_DIR, outputFilename);

    try {
      console.log(`[Job ${jobId}] Starting download for:`, targetUrl);

      const isYoutube =
        targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
      const isInstagram = targetUrl.includes("instagram.com");
      const isTikTok = targetUrl.includes("tiktok.com");
      const isFacebook =
        targetUrl.includes("facebook.com") ||
        targetUrl.includes("fb.watch") ||
        targetUrl.includes("fb.com");
      const isX =
        targetUrl.includes("x.com") || targetUrl.includes("twitter.com");

      // Instagram downloads are handled by /api/ig-download — redirect there
      if (isInstagram) {
        const redirectUrl = `/api/ig-download?url=${encodeURIComponent(
          targetUrl
        )}&index=0&type=video&title=${encodeURIComponent(
          (title as string) || "instagram_video"
        )}&mode=${mode || "inline"}`;
        return res.redirect(redirectUrl);
      }

      const mobileUA =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
      const desktopUA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

      let extractorArgs: string | undefined = undefined;
      if (isYoutube) {
        extractorArgs =
          "youtube:player-client=web_embedded,mweb,android;player-skip=webpage";
      } else if (isTikTok) {
        extractorArgs = `tiktok:user_agent="${mobileUA}"`;
      } else if (isFacebook) {
        extractorArgs = `facebook:user_agent="${mobileUA}"`;
      } else if (isX) {
        extractorArgs = `twitter:user_agent="${desktopUA}"`;
      }

      const metadataRaw = await youtubeDl(targetUrl, {
        dumpSingleJson: true,
        noPlaylist: true,
        noCheckCertificates: true,
        quiet: true,
        extractorArgs,
        referer: isFacebook
          ? "https://www.facebook.com/"
          : isTikTok
          ? "https://www.tiktok.com/"
          : isX
          ? "https://x.com/"
          : "https://www.google.com/",
        addHeader: [
          `User-Agent: ${isTikTok ? mobileUA : desktopUA}`,
          "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language: en-US,en;q=0.9",
          "Sec-Fetch-Mode: navigate",
          "Sec-Fetch-Dest: document",
        ],
        cookies: undefined,
      } as any);

      let metadata: any;
      try {
        metadata =
          typeof metadataRaw === "string"
            ? JSON.parse(metadataRaw)
            : metadataRaw;
      } catch (e) {
        if (
          typeof metadataRaw === "string" &&
          metadataRaw.includes("Rate exceeded")
        ) {
          throw new Error(
            "Platform rate limit exceeded. Please try again in a few minutes."
          );
        }
        throw new Error(
          "Failed to parse metadata from platform. The content might be private or restricted."
        );
      }

      if (!metadata) throw new Error("No metadata returned from platform.");

      const isPhoto =
        metadata.extractor === "instagram:photo" ||
        metadata.extractor?.includes("photo") ||
        metadata.extractor?.includes("image") ||
        (metadata.extractor?.includes("facebook") &&
          !metadata.formats?.some(
            (f: any) => f.vcodec !== "none" && f.vcodec
          )) ||
        (metadata.formats &&
          metadata.formats.length > 0 &&
          metadata.formats.every(
            (f: any) =>
              (!f.vcodec || f.vcodec === "none") &&
              (f.ext === "jpg" ||
                f.ext === "png" ||
                f.ext === "webp" ||
                f.ext === "jpeg")
          ));

      const formatSelection = format_id
        ? `${format_id}+bestaudio[ext=m4a]/best[ext=mp4]/best`
        : "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a][acodec^=mp4a]/best[ext=mp4][vcodec^=avc1]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";

      if (isPhoto) {
        let photoUrl = metadata.url || metadata.thumbnail;
        if (format_id && metadata.formats) {
          const requestedFormat = metadata.formats.find(
            (f: any) => f.format_id === format_id
          );
          if (requestedFormat?.url) photoUrl = requestedFormat.url;
        }
        if (!photoUrl) throw new Error("Could not find photo URL in metadata.");

        const tempPhotoPath = path.join(TEMP_DIR, `${jobId}_raw`);
        const response = await axios({
          url: photoUrl,
          method: "GET",
          responseType: "stream",
          headers: {
            "User-Agent": isTikTok ? mobileUA : desktopUA,
            Referer: isFacebook
              ? "https://www.facebook.com/"
              : isTikTok
              ? "https://www.tiktok.com/"
              : isX
              ? "https://x.com/"
              : "https://www.google.com/",
          },
        });

        const writer = fs.createWriteStream(tempPhotoPath);
        response.data.pipe(writer);
        await new Promise<void>((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });

        const finalPngPath = path.join(TEMP_DIR, `${jobId}.png`);
        const { spawnSync } = await import("child_process");
        spawnSync(ffmpeg!, ["-i", tempPhotoPath, "-frames:v", "1", finalPngPath], {
          stdio: "ignore",
        });

        if (!fs.existsSync(finalPngPath)) {
          const rawStats = fs.existsSync(tempPhotoPath)
            ? fs.statSync(tempPhotoPath)
            : null;
          if (rawStats && rawStats.size > 0) {
            outputPath = tempPhotoPath;
            outputFilename = `${jobId}.png`;
          } else {
            if (fs.existsSync(tempPhotoPath)) fs.removeSync(tempPhotoPath);
            throw new Error("Photo processing failed.");
          }
        } else {
          if (fs.existsSync(tempPhotoPath)) fs.removeSync(tempPhotoPath);
          outputPath = finalPngPath;
          outputFilename = `${jobId}.png`;
        }
      } else {
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
          referer: isFacebook
            ? "https://www.facebook.com/"
            : isTikTok
            ? "https://www.tiktok.com/"
            : isX
            ? "https://x.com/"
            : "https://www.google.com/",
          addHeader: [
            `User-Agent: ${isTikTok ? mobileUA : desktopUA}`,
            "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language: en-US,en;q=0.9",
            "Sec-Fetch-Mode: navigate",
            "Sec-Fetch-Dest: video",
          ],
        } as any);
        outputPath = finalVideoPath;
        outputFilename = `${jobId}.mp4`;
      }

      if (!fs.existsSync(outputPath))
        throw new Error("File was not created after download process.");

      const stats = fs.statSync(outputPath);
      const sanitizedTitle = ((title as string) || "video").replace(
        /[^a-zA-Z0-9\u00C0-\u017F]/g,
        "_"
      );

      const contentType = isPhoto ? "image/png" : "video/mp4";
      const fileExt = isPhoto ? "png" : "mp4";
      const disposition = mode === "download" ? "attachment" : "inline";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${sanitizedTitle}.${fileExt}"`
      );

      const readStream = fs.createReadStream(outputPath);
      readStream.pipe(res);

      res.on("finish", () => {
        try {
          fs.removeSync(outputPath);
          console.log(
            `[Job ${jobId}] Cleanup: Deleted temp file ${outputFilename}`
          );
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
        res
          .status(500)
          .send(
            "Video processing failed. This platform might be blocking the request."
          );
      }
    }
  });

  // ── /api/proxy  (generic CDN proxy for non-Instagram platforms) ─────────────
  app.get("/api/proxy", async (req, res) => {
    const { url, filename, mode } = req.query;
    if (!url) return res.status(400).send("URL is required");

    if (
      (url as string).includes("localhost") ||
      (url as string).includes("127.0.0.1")
    ) {
      return res.status(403).send("Forbidden");
    }

    try {
      const range = req.headers.range;
      const urlStr = url as string;
      const isFacebook =
        urlStr.includes("facebook.com") || urlStr.includes("fbcdn.net");
      const isTikTok =
        urlStr.includes("tiktok.com") || urlStr.includes("tiktokv.com");
      const isTwitter =
        urlStr.includes("twitter.com") ||
        urlStr.includes("x.com") ||
        urlStr.includes("twimg.com");
      const isYoutube =
        urlStr.includes("youtube.com") || urlStr.includes("googlevideo.com");

      const headers: any = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Connection: "keep-alive",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Dest": "video",
      };

      if (isTikTok || isFacebook) {
        headers["User-Agent"] =
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
      }

      if (isFacebook) headers["Referer"] = "https://www.facebook.com/";
      else if (isTikTok) headers["Referer"] = "https://www.tiktok.com/";
      else if (isTwitter) headers["Referer"] = "https://x.com/";
      else if (isYoutube) {
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

      const contentTypeHeader = String(
        response.headers["content-type"] || "video/mp4"
      );
      const finalContentType =
        contentTypeHeader.startsWith("video/") ||
        contentTypeHeader.startsWith("audio/")
          ? contentTypeHeader
          : "video/mp4";

      let sanitizedFilename = (
        (filename as string) || "file"
      ).replace(/[^a-zA-Z0-9.\-_]/g, "_");
      if (!sanitizedFilename.toLowerCase().endsWith(".mp4")) {
        sanitizedFilename =
          sanitizedFilename.replace(/\.[^/.]+$/, "") + ".mp4";
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
        `${disposition}; filename="${sanitizedFilename}"`
      );

      if (response.headers["content-length"])
        res.setHeader(
          "Content-Length",
          String(response.headers["content-length"])
        );
      if (response.headers["content-range"])
        res.setHeader(
          "Content-Range",
          String(response.headers["content-range"])
        );

      res.status(response.status === 206 ? 206 : response.status);
      response.data.pipe(res);

      response.data.on("error", (err: any) => {
        console.error("Stream error in proxy pipe:", err);
        if (!res.headersSent) res.status(500).end();
      });
    } catch (error: any) {
      console.error("Proxy error details:", error.message);
      if (!res.headersSent) {
        res
          .status(error.response?.status || 500)
          .send("Failed to stream media from source platform.");
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
