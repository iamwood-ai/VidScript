import { useState, useCallback, useEffect, useRef } from "react";
import {
  Download,
  Link as LinkIcon,
  Youtube,
  Instagram,
  Facebook,
  Music2,
  Trash2,
  AlertCircle,
  Loader2,
  CheckCircle2,
  Play,
  Sparkles,
  History,
  Copy,
  Sun,
  Moon,
  Layers,
  X as XIcon,
  Twitter,
  ImageIcon,
  Video,
  ChevronDown,
  ExternalLink,
  FileText,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { GoogleGenAI } from "@google/genai";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface Format {
  format_id: string;
  ext: string;
  url: string;
  previewUrl?: string;
  filesize?: number;
  vcodec?: string;
  acodec?: string;
  note?: string;
  height?: number;
  width?: number;
  abr?: number;
}

interface VideoMetadata {
  id: string;
  title: string;
  description?: string;
  thumbnail: string;
  webpage_url: string;
  duration?: number;
  uploader?: string;
  mediaType?: "video" | "photo" | "carousel";
  formats: Format[];
  extractor: string;
}

interface DownloadItem {
  id: string;
  url: string;
  status: "idle" | "loading" | "ready" | "error";
  metadata?: VideoMetadata;
  error?: string;
  selectedFormat?: string;
  transcript?: string;
  transcriptTimeline?: string;
  transcriptTab?: "plain" | "timeline";
  isTranscribing?: boolean;
  showTranscript?: boolean;
}

type Platform = "instagram" | "facebook" | "twitter" | "youtube" | "tiktok" | "unknown";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function detectPlatform(url: string): Platform {
  if (/instagram\.com/.test(url)) return "instagram";
  if (/facebook\.com|fb\.watch|fb\.com/.test(url)) return "facebook";
  if (/x\.com|twitter\.com/.test(url)) return "twitter";
  if (/youtube\.com|youtu\.be/.test(url)) return "youtube";
  if (/tiktok\.com/.test(url)) return "tiktok";
  return "unknown";
}

function formatDuration(secs: number): string {
  if (!secs) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
}

// ─── Platform Icons & Colors ──────────────────────────────────────────────────
const PLATFORM_CONFIG: Record<Platform, { color: string; bg: string; label: string }> = {
  instagram: { color: "text-pink-400", bg: "bg-pink-500/10 border-pink-500/20", label: "Instagram" },
  facebook: { color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", label: "Facebook" },
  twitter: { color: "text-sky-400", bg: "bg-sky-500/10 border-sky-500/20", label: "X / Twitter" },
  youtube: { color: "text-red-400", bg: "bg-red-500/10 border-red-500/20", label: "YouTube" },
  tiktok: { color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20", label: "TikTok" },
  unknown: { color: "text-gray-400", bg: "bg-gray-500/10 border-gray-500/20", label: "Video" },
};

function PlatformIcon({ platform, className }: { platform: Platform; className?: string }) {
  const cls = cn(PLATFORM_CONFIG[platform].color, className);
  switch (platform) {
    case "instagram": return <Instagram className={cls} />;
    case "facebook": return <Facebook className={cls} />;
    case "twitter": return <Twitter className={cls} />;
    case "youtube": return <Youtube className={cls} />;
    case "tiktok": return <Music2 className={cls} />;
    default: return <Video className={cls} />;
  }
}

// ─── Gemini AI ────────────────────────────────────────────────────────────────
function getAI(): GoogleGenAI | null {
  const key =
    (import.meta as any).env?.VITE_GEMINI_API_KEY ||
    (typeof process !== "undefined" ? process.env?.VITE_GEMINI_API_KEY : undefined);
  if (!key) return null;
  return new GoogleGenAI({ apiKey: key });
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [input, setInput] = useState("");
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window !== "undefined")
      return (localStorage.getItem("theme") as "dark" | "light") || "dark";
    return "dark";
  });
  const [previewItem, setPreviewItem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Theme persistence
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);

  const updateItem = useCallback(
    (id: string, patch: Partial<DownloadItem>) =>
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i))),
    []
  );

  // ── Extract metadata ─────────────────────────────────────────────────────
  const extract = useCallback(
    async (item: DownloadItem) => {
      updateItem(item.id, { status: "loading", error: undefined });
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: item.url }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || "Extraction failed");
        }
        const data: VideoMetadata = await res.json();
        // Default selected format: first video format or first format
        const defaultFormat =
          data.formats.find((f) => f.vcodec && f.vcodec !== "none")?.format_id ||
          data.formats[0]?.format_id;
        updateItem(item.id, {
          status: "ready",
          metadata: data,
          selectedFormat: defaultFormat,
        });
      } catch (err: any) {
        updateItem(item.id, { status: "error", error: err.message });
      }
    },
    [updateItem]
  );

  // Auto-extract idle items
  useEffect(() => {
    const idle = items.find((i) => i.status === "idle");
    if (idle) extract(idle);
  }, [items, extract]);

  // ── Add URLs ─────────────────────────────────────────────────────────────
  const addUrls = useCallback(() => {
    const lines = input
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(isValidUrl);

    if (lines.length === 0) return;

    const newItems: DownloadItem[] = lines
      .filter((url) => !items.some((i) => i.url === url))
      .map((url) => ({
        id: crypto.randomUUID(),
        url,
        status: "idle" as const,
      }));

    if (newItems.length > 0) {
      setItems((prev) => [...newItems, ...prev]);
      setInput("");
    }
  }, [input, items]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addUrls();
    }
  };

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (previewItem === id) setPreviewItem(null);
  };

  const clearAll = () => {
    setItems([]);
    setPreviewItem(null);
  };

  // ── Download ─────────────────────────────────────────────────────────────
  const download = (item: DownloadItem) => {
    if (!item.metadata) return;

    const fmt =
      item.metadata.formats.find((f) => f.format_id === item.selectedFormat) ||
      item.metadata.formats[0];
    if (!fmt) return;

    const isPhoto = fmt.vcodec === "none" || ["jpg", "jpeg", "png", "webp"].includes(fmt.ext);
    const ext = isPhoto ? fmt.ext || "jpg" : "mp4";
    const safeTitle = (item.metadata.title || "media")
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase()
      .substring(0, 50);

    const sep = fmt.url.includes("?") ? "&" : "?";
    const dlUrl = `${fmt.url}${sep}mode=download&title=${encodeURIComponent(safeTitle)}`;

    const a = document.createElement("a");
    a.href = dlUrl;
    a.download = `${safeTitle}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // ── AI Transcript ─────────────────────────────────────────────────────────
  const generateTranscript = async (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item?.metadata) return;

    const ai = getAI();
    if (!ai) {
      updateItem(id, {
        transcript: "⚠️ No Gemini API key found. Add VITE_GEMINI_API_KEY to your .env file.",
        showTranscript: true,
      });
      return;
    }

    updateItem(id, { isTranscribing: true });

    try {
      const videoUrl = item.metadata.webpage_url;

      // Plain transcript
      const plainRes = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Please provide a clean, readable transcript of the speech in this video.\n\nVideo URL: ${videoUrl}\nTitle: ${item.metadata.title}\nPlatform: ${item.metadata.extractor}\n\nIf you cannot directly access the video, summarize what you can infer from the title and URL.`,
              },
            ],
          },
        ],
      });

      const plainText = plainRes.text ?? "No transcript generated.";

      // Timeline transcript
      const timelineRes = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Provide a timestamped transcript for this video in this format:\n[00:00] Speaker text here\n[00:15] More text\n\nVideo URL: ${videoUrl}\nTitle: ${item.metadata.title}\n\nIf you cannot access the video, provide a note.`,
              },
            ],
          },
        ],
      });

      const timelineText = timelineRes.text ?? "No timeline generated.";

      updateItem(id, {
        transcript: plainText,
        transcriptTimeline: timelineText,
        transcriptTab: "plain",
        showTranscript: true,
        isTranscribing: false,
      });
    } catch (err: any) {
      updateItem(id, {
        transcript: `Transcript error: ${err.message}`,
        showTranscript: true,
        isTranscribing: false,
      });
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  const dark = theme === "dark";

  return (
    <div
      className={cn(
        "min-h-screen font-sans transition-colors duration-300",
        dark ? "bg-gray-950 text-white" : "bg-gray-50 text-gray-900"
      )}
    >
      {/* Header */}
      <header
        className={cn(
          "sticky top-0 z-50 border-b backdrop-blur-xl",
          dark
            ? "bg-gray-950/80 border-white/5"
            : "bg-white/80 border-gray-200"
        )}
      >
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <Download className="w-4 h-4 text-white" />
            </div>
            <span className="font-black text-lg tracking-tight">
              Vid<span className="text-gradient">Script</span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            {items.length > 0 && (
              <button
                onClick={clearAll}
                className={cn(
                  "text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors",
                  dark
                    ? "text-gray-400 hover:text-red-400 hover:bg-red-500/10"
                    : "text-gray-500 hover:text-red-500 hover:bg-red-50"
                )}
              >
                Clear all
              </button>
            )}
            <button
              onClick={() => setTheme(dark ? "light" : "dark")}
              className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center transition-colors",
                dark
                  ? "text-gray-400 hover:text-white hover:bg-white/10"
                  : "text-gray-500 hover:text-gray-900 hover:bg-gray-100"
              )}
            >
              {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-10 space-y-8">
        {/* Hero */}
        <div className="text-center space-y-3">
          <h1 className="text-4xl sm:text-5xl font-black tracking-tight">
            Download{" "}
            <span className="text-gradient">anything</span>
          </h1>
          <p className={cn("text-base", dark ? "text-gray-400" : "text-gray-500")}>
            Videos & images from Instagram, Facebook, X, YouTube and TikTok
          </p>

          {/* Platform badges */}
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            {(["instagram", "facebook", "twitter", "youtube", "tiktok"] as Platform[]).map((p) => (
              <span
                key={p}
                className={cn(
                  "flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full border",
                  PLATFORM_CONFIG[p].bg,
                  PLATFORM_CONFIG[p].color
                )}
              >
                <PlatformIcon platform={p} className="w-3 h-3" />
                {PLATFORM_CONFIG[p].label}
              </span>
            ))}
          </div>
        </div>

        {/* Input */}
        <div
          className={cn(
            "rounded-2xl border p-4 space-y-3",
            dark ? "bg-gray-900 border-white/10" : "bg-white border-gray-200 shadow-sm"
          )}
        >
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <LinkIcon
                className={cn(
                  "absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4",
                  dark ? "text-gray-500" : "text-gray-400"
                )}
              />
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Paste a URL and press Enter…"
                className={cn(
                  "w-full pl-9 pr-3 py-2.5 rounded-xl text-sm font-medium outline-none transition-colors",
                  dark
                    ? "bg-gray-800 text-white placeholder:text-gray-500 focus:bg-gray-750 border border-white/5 focus:border-indigo-500/50"
                    : "bg-gray-50 text-gray-900 placeholder:text-gray-400 border border-gray-200 focus:border-indigo-400"
                )}
              />
            </div>
            <button
              onClick={addUrls}
              disabled={!input.trim()}
              className={cn(
                "px-5 py-2.5 rounded-xl text-sm font-bold transition-all active:scale-95",
                input.trim()
                  ? "bg-indigo-600 hover:bg-indigo-500 text-white"
                  : dark
                  ? "bg-gray-800 text-gray-600 cursor-not-allowed"
                  : "bg-gray-100 text-gray-400 cursor-not-allowed"
              )}
            >
              Add
            </button>
          </div>

          <p className={cn("text-xs", dark ? "text-gray-600" : "text-gray-400")}>
            Supports Instagram Reels, posts & carousels · Facebook videos · X/Twitter videos ·
            YouTube videos & Shorts · TikTok videos
          </p>
        </div>

        {/* Items */}
        <AnimatePresence mode="popLayout">
          {items.map((item) => {
            const platform = detectPlatform(item.url);
            const cfg = PLATFORM_CONFIG[platform];
            const meta = item.metadata;
            const isCarousel = meta?.mediaType === "carousel";
            const isPhoto = meta?.mediaType === "photo";
            const isVideo = meta?.mediaType === "video" || !meta?.mediaType;

            // YouTube quality options
            const ytFormats =
              platform === "youtube" && meta
                ? meta.formats
                    .filter((f) => f.vcodec && f.vcodec !== "none" && f.height)
                    .sort((a, b) => (b.height || 0) - (a.height || 0))
                : [];

            // Carousel slide options
            const carouselFormats = isCarousel && meta ? meta.formats : [];

            const activeTranscript =
              item.transcriptTab === "timeline"
                ? item.transcriptTimeline
                : item.transcript;

            return (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.2 }}
                className={cn(
                  "rounded-2xl border overflow-hidden",
                  dark ? "bg-gray-900 border-white/10" : "bg-white border-gray-200 shadow-sm"
                )}
              >
                {/* Card header */}
                <div
                  className={cn(
                    "flex items-center gap-3 px-4 py-3 border-b",
                    dark ? "border-white/5" : "border-gray-100"
                  )}
                >
                  <PlatformIcon platform={platform} className="w-4 h-4 flex-shrink-0" />
                  <span
                    className={cn(
                      "text-xs font-medium truncate flex-1",
                      dark ? "text-gray-400" : "text-gray-500"
                    )}
                  >
                    {item.url}
                  </span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        "w-7 h-7 rounded-lg flex items-center justify-center transition-colors",
                        dark
                          ? "text-gray-500 hover:text-gray-300 hover:bg-white/5"
                          : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                      )}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                    <button
                      onClick={() => removeItem(item.id)}
                      className={cn(
                        "w-7 h-7 rounded-lg flex items-center justify-center transition-colors",
                        dark
                          ? "text-gray-500 hover:text-red-400 hover:bg-red-500/10"
                          : "text-gray-400 hover:text-red-500 hover:bg-red-50"
                      )}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Loading */}
                {item.status === "loading" && (
                  <div className="flex items-center gap-3 px-4 py-5">
                    <Loader2 className="w-5 h-5 text-indigo-400 animate-spin flex-shrink-0" />
                    <span className={cn("text-sm", dark ? "text-gray-400" : "text-gray-500")}>
                      Fetching media info…
                    </span>
                  </div>
                )}

                {/* Error */}
                {item.status === "error" && (
                  <div className="px-4 py-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                      <p className="text-sm text-red-400">{item.error}</p>
                    </div>
                    <button
                      onClick={() => extract(item)}
                      className="flex items-center gap-1.5 text-xs font-bold text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      <History className="w-3 h-3" /> Retry
                    </button>
                  </div>
                )}

                {/* Ready */}
                {item.status === "ready" && meta && (
                  <div className="p-4 space-y-4">
                    {/* Media info row */}
                    <div className="flex gap-3">
                      {/* Thumbnail */}
                      {meta.thumbnail && (
                        <div className="relative flex-shrink-0 w-24 h-16 rounded-xl overflow-hidden bg-gray-800">
                          <img
                            src={meta.thumbnail}
                            alt={meta.title}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = "none";
                            }}
                          />
                          {isVideo && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="w-7 h-7 rounded-full bg-black/50 flex items-center justify-center">
                                <Play className="w-3 h-3 text-white ml-0.5" />
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Title & meta */}
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="text-sm font-semibold leading-snug line-clamp-2">
                          {meta.title}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          {meta.uploader && (
                            <span className={cn("text-xs", dark ? "text-gray-500" : "text-gray-400")}>
                              @{meta.uploader}
                            </span>
                          )}
                          {meta.duration ? (
                            <span className={cn("text-xs font-mono", dark ? "text-gray-500" : "text-gray-400")}>
                              {formatDuration(meta.duration)}
                            </span>
                          ) : null}
                          {/* Media type badge */}
                          <span
                            className={cn(
                              "text-xs font-bold px-2 py-0.5 rounded-full border flex items-center gap-1",
                              cfg.bg,
                              cfg.color
                            )}
                          >
                            {isCarousel ? (
                              <><Layers className="w-3 h-3" /> Carousel</>
                            ) : isPhoto ? (
                              <><ImageIcon className="w-3 h-3" /> Photo</>
                            ) : (
                              <><Video className="w-3 h-3" /> Video</>
                            )}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Format/Quality selectors */}
                    <div className="flex flex-wrap gap-2">
                      {/* YouTube quality picker */}
                      {platform === "youtube" && ytFormats.length > 0 && (
                        <div className="relative">
                          <select
                            value={item.selectedFormat}
                            onChange={(e) => updateItem(item.id, { selectedFormat: e.target.value })}
                            className={cn(
                              "appearance-none text-xs font-bold pl-3 pr-7 py-1.5 rounded-lg border cursor-pointer outline-none",
                              dark
                                ? "bg-gray-800 border-white/10 text-indigo-400"
                                : "bg-gray-50 border-gray-200 text-indigo-600"
                            )}
                          >
                            {ytFormats.map((f) => (
                              <option key={f.format_id} value={f.format_id}>
                                {f.height}p {f.ext?.toUpperCase()}
                                {f.filesize ? ` · ${formatBytes(f.filesize)}` : ""}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400 pointer-events-none" />
                        </div>
                      )}

                      {/* Instagram carousel slide picker */}
                      {isCarousel && carouselFormats.length > 0 && (
                        <div className="relative">
                          <select
                            value={item.selectedFormat}
                            onChange={(e) => updateItem(item.id, { selectedFormat: e.target.value })}
                            className={cn(
                              "appearance-none text-xs font-bold pl-3 pr-7 py-1.5 rounded-lg border cursor-pointer outline-none",
                              dark
                                ? "bg-gray-800 border-white/10 text-pink-400"
                                : "bg-gray-50 border-gray-200 text-pink-600"
                            )}
                          >
                            {carouselFormats.map((f) => (
                              <option key={f.format_id} value={f.format_id}>
                                {f.note || f.format_id}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400 pointer-events-none" />
                        </div>
                      )}
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-2">
                      {/* Preview */}
                      {isVideo && (
                        <button
                          onClick={() =>
                            setPreviewItem(previewItem === item.id ? null : item.id)
                          }
                          className={cn(
                            "flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl border transition-all active:scale-95",
                            dark
                              ? "bg-white/5 border-white/10 text-gray-300 hover:bg-white/10"
                              : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                          )}
                        >
                          <Play className="w-3.5 h-3.5" />
                          Preview
                        </button>
                      )}

                      {/* Download */}
                      <button
                        onClick={() => download(item)}
                        className="flex-1 flex items-center justify-center gap-2 text-sm font-bold px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-all active:scale-95"
                      >
                        <Download className="w-4 h-4" />
                        Download
                        {isCarousel ? " Slide" : isPhoto ? " Photo" : " Video"}
                      </button>

                      {/* AI Transcript */}
                      <button
                        onClick={() => generateTranscript(item.id)}
                        disabled={
                          item.isTranscribing ||
                          isPhoto ||
                          isCarousel
                        }
                        className={cn(
                          "flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl border transition-all active:scale-95",
                          item.isTranscribing || isPhoto || isCarousel
                            ? dark
                              ? "bg-white/5 border-white/5 text-gray-600 cursor-not-allowed"
                              : "bg-gray-50 border-gray-100 text-gray-300 cursor-not-allowed"
                            : dark
                            ? "bg-pink-500/10 border-pink-500/20 text-pink-400 hover:bg-pink-500/20"
                            : "bg-pink-50 border-pink-200 text-pink-600 hover:bg-pink-100"
                        )}
                        title={
                          isPhoto || isCarousel
                            ? "Transcript only works for single videos"
                            : "Generate AI transcript"
                        }
                      >
                        {item.isTranscribing ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                        {item.isTranscribing ? "…" : "AI"}
                      </button>
                    </div>

                    {/* Video Preview */}
                    <AnimatePresence>
                      {previewItem === item.id && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden"
                        >
                          <div
                            className={cn(
                              "rounded-xl overflow-hidden border",
                              dark ? "border-white/10" : "border-gray-200"
                            )}
                          >
                            <video
                              controls
                              className="w-full max-h-72 bg-black"
                              src={
                                (meta.formats.find(
                                  (f) => f.format_id === item.selectedFormat
                                ) || meta.formats[0])?.previewUrl || ""
                              }
                            />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Transcript Panel */}
                    <AnimatePresence>
                      {item.showTranscript && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden"
                        >
                          <div
                            className={cn(
                              "rounded-xl border p-4 space-y-3",
                              dark
                                ? "bg-gray-800/50 border-white/10"
                                : "bg-gray-50 border-gray-200"
                            )}
                          >
                            {/* Tabs */}
                            <div className="flex items-center justify-between">
                              <div className="flex gap-1">
                                {(["plain", "timeline"] as const).map((tab) => (
                                  <button
                                    key={tab}
                                    onClick={() =>
                                      updateItem(item.id, { transcriptTab: tab })
                                    }
                                    className={cn(
                                      "text-xs font-bold px-3 py-1 rounded-lg transition-colors",
                                      item.transcriptTab === tab
                                        ? "bg-indigo-600 text-white"
                                        : dark
                                        ? "text-gray-400 hover:text-white"
                                        : "text-gray-500 hover:text-gray-900"
                                    )}
                                  >
                                    {tab === "plain" ? (
                                      <span className="flex items-center gap-1">
                                        <FileText className="w-3 h-3" /> Plain
                                      </span>
                                    ) : (
                                      <span className="flex items-center gap-1">
                                        <CheckCircle2 className="w-3 h-3" /> Timeline
                                      </span>
                                    )}
                                  </button>
                                ))}
                              </div>
                              <div className="flex gap-1">
                                {activeTranscript && (
                                  <button
                                    onClick={() => copyText(activeTranscript)}
                                    className={cn(
                                      "w-7 h-7 rounded-lg flex items-center justify-center transition-colors",
                                      dark
                                        ? "text-gray-400 hover:text-white hover:bg-white/10"
                                        : "text-gray-400 hover:text-gray-700 hover:bg-gray-200"
                                    )}
                                    title="Copy"
                                  >
                                    <Copy className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                <button
                                  onClick={() =>
                                    updateItem(item.id, { showTranscript: false })
                                  }
                                  className={cn(
                                    "w-7 h-7 rounded-lg flex items-center justify-center transition-colors",
                                    dark
                                      ? "text-gray-400 hover:text-white hover:bg-white/10"
                                      : "text-gray-400 hover:text-gray-700 hover:bg-gray-200"
                                  )}
                                >
                                  <XIcon className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            <div
                              className={cn(
                                "text-xs leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto font-mono",
                                dark ? "text-gray-300" : "text-gray-700"
                              )}
                            >
                              {activeTranscript || (
                                <span className={dark ? "text-gray-500" : "text-gray-400"}>
                                  No transcript available for this tab.
                                </span>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Empty state */}
        {items.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-16 space-y-4"
          >
            <div
              className={cn(
                "w-16 h-16 rounded-2xl mx-auto flex items-center justify-center",
                dark ? "bg-gray-800" : "bg-gray-100"
              )}
            >
              <Download className={cn("w-7 h-7", dark ? "text-gray-600" : "text-gray-400")} />
            </div>
            <div>
              <p className={cn("font-semibold", dark ? "text-gray-400" : "text-gray-500")}>
                No downloads yet
              </p>
              <p className={cn("text-sm mt-1", dark ? "text-gray-600" : "text-gray-400")}>
                Paste a link above to get started
              </p>
            </div>
          </motion.div>
        )}
      </main>

      {/* Footer */}
      <footer
        className={cn(
          "border-t mt-16 py-8",
          dark ? "border-white/5" : "border-gray-100"
        )}
      >
        <div className="max-w-5xl mx-auto px-4 text-center">
          <p className={cn("text-xs", dark ? "text-gray-600" : "text-gray-400")}>
            VidScript — For personal use only. Respect copyright and platform terms of service.
          </p>
        </div>
      </footer>
    </div>
  );
}
