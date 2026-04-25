/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Download,
  Link as LinkIcon,
  Youtube,
  Instagram,
  Facebook,
  Music,
  Video,
  Trash2,
  AlertCircle,
  Loader2,
  CheckCircle2,
  ExternalLink,
  Play,
  FileText,
  Sparkles,
  Smartphone,
  ChevronRight,
  History,
  Clock,
  Copy,
  FileDown,
  User,
  Shield,
  Scale,
  Sun,
  Moon,
  Upload as UploadIcon,
  Layers,
  FileUp,
  X,
  ArrowRight,
  Twitter,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { GoogleGenAI } from "@google/genai";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Typing for yt-dlp response (simplified)
interface Format {
  format_id: string;
  ext: string;
  resolution?: string;
  quality?: number;
  url: string;
  filesize?: number;
  vcodec?: string;
  acodec?: string;
  note?: string;
  abr?: number;
  width?: number;
  height?: number;
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
  selectedQuality?: string;
  transcriptNormal?: string;
  transcriptTimeline?: string;
  transcriptActiveType?: "normal" | "timeline";
  isTranscribing?: boolean;
}

export default function App() {
  const [inputText, setInputText] = useState("");
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [legalTab, setLegalTab] = useState<"terms" | "privacy" | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("theme") as "dark" | "light") || "light";
    }
    return "light";
  });
  const [activeTab, setActiveTab] = useState<"single" | "batch" | "upload">(
    "single",
  );
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  const aiInstance = useRef<GoogleGenAI | null>(null);

  const getAi = () => {
    if (aiInstance.current) return aiInstance.current;
    if (process.env.GEMINI_API_KEY) {
      aiInstance.current = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
      });
      return aiInstance.current;
    }
    return null;
  };

  const detectPlatform = (url: string) => {
    const u = url.toLowerCase();
    if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
    if (u.includes("tiktok.com")) return "tiktok";
    if (u.includes("facebook.com") || u.includes("fb.watch") || u.includes("fb.com")) return "facebook";
    if (u.includes("instagram.com")) return "instagram";
    if (u.includes("twitter.com") || u.includes("x.com")) return "twitter";
    return "generic";
  };

  const getPlatformIcon = (platform: string, size = "w-5 h-5") => {
    switch (platform) {
      case "twitter":
        return (
          <div className={cn("bg-black rounded-lg p-1.5 flex items-center justify-center border border-white/20", size)}>
            <Twitter className="text-white w-full h-full" />
          </div>
        );
      case "youtube":
        return (
          <div className={cn("bg-red-600 rounded-lg p-1.5 flex items-center justify-center", size)}>
            <Youtube className="text-white w-full h-full" />
          </div>
        );
      case "instagram":
        return (
          <div className={cn("bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600 rounded-lg p-1.5 flex items-center justify-center", size)}>
            <Instagram className="text-white w-full h-full" />
          </div>
        );
      case "facebook":
        return (
          <div className={cn("bg-[#1877F2] rounded-lg p-1.5 flex items-center justify-center", size)}>
            <Facebook className="text-white w-full h-full" />
          </div>
        );
      case "tiktok":
        return (
          <div className={cn("bg-black rounded-lg p-1.5 flex items-center justify-center border border-white/20", size)}>
            <svg viewBox="0 0 24 24" className="w-full h-full fill-white" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.17-2.89-.6-4.13-1.47-.23-.15-.44-.31-.65-.47.01 2.21.01 4.41.01 6.62 0 1.34-.14 2.7-.68 3.93-.65 1.52-1.9 2.78-3.41 3.44-1.43.62-3.08.73-4.59.42-1.45-.31-2.81-1.12-3.79-2.22C4.1 18.91 3.5 17.22 3.5 15.5c0-1.63.53-3.23 1.5-4.52.92-1.22 2.24-2.14 3.73-2.5 1.1-.28 2.26-.26 3.36.03V12.7c-.8-.22-1.68-.22-2.45.1-.9.37-1.59 1.15-1.9 2.07-.33.99-.21 2.12.33 3.03.49.82 1.35 1.41 2.28 1.6 1.05.21 2.24-.04 3.08-.74.65-.54.99-1.37.99-2.21V.02z" />
            </svg>
          </div>
        );
      default:
        return <LinkIcon className={cn("text-gray-400", size)} />;
    }
  };

  const handleAddUrls = useCallback((urlOverride?: string | string[]) => {
    const sourceText = typeof urlOverride === "string" 
      ? urlOverride 
      : Array.isArray(urlOverride) 
        ? urlOverride.join("\n") 
        : inputText;
        
    if (!sourceText.trim() && activeTab !== "upload") return;

    let urls: string[] = [];

    if (activeTab === "single") {
      const match = sourceText.match(/https?:\/\/[^\s,]+/);
      if (match) urls = [match[0]];
    } else if (activeTab === "batch") {
      urls = sourceText
        .split(/\n|,| /)
        .map((url) => url.trim())
        .filter((url) => url.startsWith("http"))
        .slice(0, 10);
    } else if (activeTab === "upload" && uploadFile) {
      // Handle file upload pseudo-item
      const newItem: DownloadItem = {
        id: "vid_" + Math.random().toString(36).substring(2, 11),
        url: "local-file",
        status: "ready",
        metadata: {
          id: "upload",
          title: uploadFile.name,
          extractor: "upload",
          thumbnail: URL.createObjectURL(uploadFile), // Might not work for all files but okay for thumb
          formats: [],
          webpage_url: "#",
        },
      };
      setItems((prev) => [newItem, ...prev]);
      setUploadFile(null);
      return;
    }

    const newItems: DownloadItem[] = urls.map((url) => ({
      id: "vid_" + Math.random().toString(36).substring(2, 11),
      url,
      status: "idle",
    }));

    setItems((prev) => [...newItems, ...prev]);
    setInputText("");
  }, [inputText, activeTab, uploadFile]);

  const handlePaste = async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error("Clipboard API not available");
      }
      const text = await navigator.clipboard.readText();
      if (text) {
        if (text.trim().startsWith("http")) {
          handleAddUrls(text.trim());
        } else {
          setInputText((prev) => (prev ? `${prev}\n${text}` : text));
        }
      }
    } catch (err) {
      console.warn("Clipboard access denied or unavailable. Please paste manually.");
    }
  };

  const extractInfo = async (id: string) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, status: "loading" } : item,
      ),
    );

    const item = items.find((i) => i.id === id);
    if (!item) return;
    const urlToUse = item.url;

    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlToUse }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.details || data.error || "Failed to extract video info",
        );
      }

      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "ready",
                metadata: data,
                selectedQuality: (() => {
                  const formats = data.formats || [];
                  // Best combined MP4 with both video and audio
                  const combined = formats.filter((f: any) => 
                    f.vcodec !== "none" && f.acodec !== "none" && (f.ext === "mp4" || f.vcodec?.includes("avc"))
                  );
                  if (combined.length > 0) {
                    return combined.sort((a: any, b: any) => (b.height || 0) - (a.height || 0))[0].format_id;
                  }
                  
                  // Fallback: direct format or just the very best video available
                  const direct = formats.find((f: any) => f.format_id === "direct");
                  if (direct) return "direct";
                  
                  const bestAny = [...formats].sort((a: any, b: any) => (b.height || 0) - (a.height || 0))[0];
                  return bestAny?.format_id || "direct";
                })(),
              }
            : item,
        ),
      );
    } catch (err: any) {
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, status: "error", error: err.message }
            : item,
        ),
      );
    }
  };

  const generateTranscript = async (
    id: string,
    type: "normal" | "timeline" | "both",
  ) => {
    const item = items.find((i) => i.id === id);
    const ai = getAi();
    if (!item || !item.metadata || !ai) return;

    const typesToGen: ("normal" | "timeline")[] = [];
    if (type === "both") {
      if (!item.transcriptNormal) typesToGen.push("normal");
      if (!item.transcriptTimeline) typesToGen.push("timeline");
      if (typesToGen.length === 0) {
        setItems((current) =>
          current.map((it) =>
            it.id === id ? { ...it, transcriptActiveType: "normal" } : it,
          ),
        );
        return;
      }
    } else {
      if (type === "normal" && item.transcriptNormal) {
        setItems((current) =>
          current.map((it) =>
            it.id === id ? { ...it, transcriptActiveType: "normal" } : it,
          ),
        );
        return;
      }
      if (type === "timeline" && item.transcriptTimeline) {
        setItems((current) =>
          current.map((it) =>
            it.id === id ? { ...it, transcriptActiveType: "timeline" } : it,
          ),
        );
        return;
      }
      typesToGen.push(type);
    }

    setItems((current) =>
      current.map((it) =>
        it.id === id
          ? {
              ...it,
              isTranscribing: true,
              transcriptActiveType:
                it.transcriptActiveType || (type === "both" ? "normal" : type),
            }
          : it,
      ),
    );

    const gen = async (t: "normal" | "timeline") => {
      const promptType =
        t === "timeline"
          ? "Generate a detailed TIMELINE/CHAPTER based transcript. Include timestamps (e.g. 00:00 - Intro) and describe what happens in each segment."
          : "Generate a professional, well-structured transcript and summary.";

      const contents = `Analysing video metadata to provide the transcript content ONLY.
        Type: Word-for-word transcript
        Title: ${item.metadata?.title}
        Description: ${item.metadata?.description || "No description available"}
        
        LANGUAGES SUPPORTED: English, Spanish, French, German, Russian, Italian, Japanese, Chinese, Korean.
        
        CRITICAL RULES:
        1. LANGUAGE DETECTION: Listen to the audio and detect the primary language SPOKEN. You MUST output the transcript in that EXACT same language. If English is spoken, output English. If Spanish is spoken, output Spanish.
        2. NO COMMENTARY: Do not add titles, intros, or "Here is the transcript". Start immediately with the first spoken word.
        3. WORD-FOR-WORD: Transcribe exactly what is heard. No summaries, no paraphrasing.
        4. NO HALLUCINATION: If the video is short, the transcript must be short. Do not invent text. 
        5. NO SPEECH CASE: If no human speech is detected, output ONLY: "You can't transcript this video because it contains no human speech or is inaccessible."
        
        Output the spoken content ONLY. Use Markdown for paragraphs.`;

      try {
        const result = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents,
        });
        return result.text;
      } catch (e) {
        console.error(`AI Error for ${t}:`, e);
        return null;
      }
    };

    try {
      const results = await Promise.all(
        typesToGen.map((t) => gen(t).then((res) => ({ type: t, res }))),
      );

      setItems((current) =>
        current.map((it) => {
          if (it.id !== id) return it;
          const updates: any = { isTranscribing: false };
          results.forEach((r) => {
            if (r.res) {
              if (r.type === "normal") updates.transcriptNormal = r.res;
              if (r.type === "timeline") updates.transcriptTimeline = r.res;
            }
          });
          if (type === "both" && updates.transcriptNormal)
            updates.transcriptActiveType = "normal";
          return { ...it, ...updates };
        }),
      );
    } catch (err) {
      console.error("Magic Generation Error:", err);
      setItems((current) =>
        current.map((it) =>
          it.id === id ? { ...it, isTranscribing: false } : it,
        ),
      );
    }
  };

  const removeItem = (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  };

  const setQuality = (id: string, qualityId: string) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, selectedQuality: qualityId } : item,
      ),
    );
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Could add a toast here
  };

  const exportTranscript = (id: string, ext: "srt" | "vtt") => {
    const item = items.find((i) => i.id === id);
    if (!item) return;

    const transcriptStr =
      item.transcriptActiveType === "timeline"
        ? item.transcriptTimeline
        : item.transcriptNormal;
    if (!transcriptStr) return;

    const content =
      ext === "vtt" ? `WEBVTT\n\n${transcriptStr}` : transcriptStr;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${item.metadata?.title || "transcript"}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const startDownload = async (item: DownloadItem) => {
    if (!item.metadata) return;

    const safeTitle = (item.metadata.title || "video")
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase();

    let format = item.metadata.formats.find(
      (f) => f.format_id === item.selectedQuality,
    );

    if (!format) {
      format = item.metadata.formats
        .filter((f) => f.vcodec !== "none")
        .sort((a, b) => (b.quality || 0) - (a.quality || 0))[0];
    }

    if (!format && item.metadata.formats.length > 0) {
       format = item.metadata.formats[0];
    }

    if (!format) return;

    // The format.url already points to /api/download?url=...
    const downloadUrl = `${format.url}&mode=download`;
    
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = safeTitle.substring(0, 50) + ".mp4";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Auto-extract idle items
  useEffect(() => {
    const idleItem = items.find((item) => item.status === "idle");
    if (idleItem) {
      extractInfo(idleItem.id);
    }
  }, [items]);

  return (
    <div
      className={cn(
        "min-h-screen font-sans overflow-x-hidden transition-colors duration-200",
        theme === "dark"
          ? "bg-[#050505] text-white"
          : "bg-[#F8F9FB] text-gray-900",
      )}
    >
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none -z-10">
        <div
          className={cn(
            "absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full blur-[140px]",
            theme === "dark" ? "bg-indigo-900/10" : "bg-indigo-500/5",
          )}
        />
        <div
          className={cn(
            "absolute bottom-[10%] right-[-10%] w-[40%] h-[40%] rounded-full blur-[140px]",
            theme === "dark" ? "bg-purple-900/10" : "bg-purple-500/5",
          )}
        />
      </div>

      <nav
        className={cn(
          "sticky top-0 z-50 backdrop-blur-xl border-b px-6 py-4 transition-colors duration-200",
          theme === "dark"
            ? "bg-[#050505] border-white/5"
            : "bg-white/95 border-gray-100 shadow-sm",
        )}
      >
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "w-10 h-10 rounded-xl flex items-center justify-center shadow-lg transition-transform hover:scale-105",
                theme === "dark"
                  ? "bg-indigo-600 shadow-indigo-500/20"
                  : "bg-indigo-500 shadow-indigo-500/10",
              )}
            >
              <Download className="text-white w-5 h-5" />
            </div>
            <h1
              className={cn(
                "text-xl font-bold tracking-tight",
                theme === "dark" ? "text-white" : "text-gray-900",
              )}
            >
              VidScript
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className={cn(
                "p-2 rounded-xl border transition-all active:scale-95",
                theme === "dark"
                  ? "border-white/10 bg-white/5 hover:bg-white/10"
                  : "border-gray-200 bg-gray-50 hover:bg-gray-100",
              )}
            >
              {theme === "dark" ? (
                <Sun className="w-5 h-5 text-amber-400" />
              ) : (
                <Moon className="w-5 h-5 text-indigo-600" />
              )}
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-6 pt-6 pb-0 lg:pt-12 lg:pb-0">
        {/* Compact Top Ad - Hidden for now */}
        {/* <div className="w-full h-16 bg-white/5 border border-white/10 rounded-2xl mb-8 flex items-center justify-center text-gray-700 text-[10px] font-bold tracking-widest uppercase">
          Advertisement
        </div> */}

        <section className="text-center mb-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <h3
              className={cn(
                "text-[22px] sm:text-3xl md:text-5xl font-black mb-1 tracking-tight leading-[1.2] px-4 sm:px-0",
                theme === "dark" ? "text-white" : "text-black",
              )}
            >
              Free video downloads <br className="sm:hidden" />
              and AI transcripts.
            </h3>
            <h4 className="text-[10px] sm:text-lg md:text-2xl font-black mb-8 tracking-tight leading-tight text-indigo-600 uppercase sm:tracking-[6px] tracking-[2px]">
              Paste, Save, and Analyze.
            </h4>
          </motion.div>
        </section>

        {/* Search / Input Box - Mode Tapped */}
        <section className="mb-0">
          <div
            className={cn(
              "max-w-2xl mx-auto rounded-[32px] border transition-all duration-200 overflow-hidden",
              theme === "dark"
                ? "bg-[#111] border-white/5"
                : "bg-white border-gray-100 shadow-xl",
            )}
          >
            {/* Tabs */}
            <div
              className={cn(
                "flex border-b p-2 gap-1",
                theme === "dark"
                  ? "border-white/5"
                  : "border-gray-100 bg-gray-50/50",
              )}
            >
              <button
                onClick={() => setActiveTab("single")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all",
                  activeTab === "single"
                    ? theme === "dark"
                      ? "bg-white/10 text-white"
                      : "bg-white text-indigo-600 shadow-sm"
                    : "text-gray-500 hover:text-gray-400",
                )}
              >
                <LinkIcon className="w-3 h-3" />
                URL
              </button>
              <button
                onClick={() => setActiveTab("batch")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all",
                  activeTab === "batch"
                    ? theme === "dark"
                      ? "bg-white/10 text-white"
                      : "bg-white text-indigo-600 shadow-sm"
                    : "text-gray-500 hover:text-gray-400",
                )}
              >
                <Layers className="w-3 h-3" />
                BATCH
              </button>
              <button
                onClick={() => setActiveTab("upload")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all",
                  activeTab === "upload"
                    ? theme === "dark"
                      ? "bg-white/10 text-white"
                      : "bg-white text-indigo-600 shadow-sm"
                    : "text-gray-500 hover:text-gray-400",
                )}
              >
                <FileUp className="w-3 h-3" />
                UPLOAD
              </button>
            </div>

            <div className="p-4 sm:p-6 flex flex-col items-stretch gap-4">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
                {activeTab === "upload" ? (
                  <label className="w-full sm:flex-1 flex flex-col items-center justify-center border-2 border-dashed border-white/10 rounded-2xl p-6 cursor-pointer hover:bg-white/5 transition-colors group">
                    <UploadIcon className="w-8 h-8 text-indigo-500 mb-2 group-hover:scale-110 transition-transform" />
                    <span className="text-sm font-bold text-gray-500 text-center">
                      {uploadFile ? uploadFile.name : "Select Video File"}
                    </span>
                    <input
                      type="file"
                      className="hidden"
                      accept="video/mp4,video/x-m4v,video/*"
                      onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                    />
                  </label>
                ) : (
                  <div
                    className={cn(
                      "w-full sm:flex-1 flex items-center px-6 rounded-2xl border transition-all",
                      activeTab === "batch" ? "min-h-[120px] py-4" : "h-[64px]",
                      theme === "dark"
                        ? "bg-black border-white/10 focus-within:border-indigo-500/50"
                        : "bg-gray-50 border-gray-100 focus-within:border-indigo-500/30",
                    )}
                  >
                    <textarea
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder={activeTab === "batch" ? "Paste multiple video URLs (one per line)..." : "Paste a video URL..."}
                      className={cn(
                        "flex-1 bg-transparent border-none focus:ring-0 text-base placeholder-gray-700 resize-none p-0",
                        activeTab === "batch" ? "min-h-[80px]" : "h-[24px] overflow-hidden whitespace-nowrap leading-[24px]"
                      )}
                      onKeyDown={(e) =>
                        !e.shiftKey &&
                        e.key === "Enter" &&
                        (e.preventDefault(), handleAddUrls())
                      }
                    />
                    {inputText.trim() && (
                      <button
                        onClick={() => setInputText("")}
                        className="p-1 text-gray-500 hover:text-red-500 transition-colors shrink-0"
                        title="Clear Input"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    )}
                  </div>
                )}

                <div className="w-full sm:w-auto flex flex-col gap-3 shrink-0">
                  <button
                    onClick={
                      !inputText.trim() && activeTab !== "upload"
                        ? handlePaste
                        : handleAddUrls
                    }
                    disabled={activeTab === "upload" && !uploadFile}
                    className={cn(
                      "w-full px-10 h-[64px] rounded-2xl font-black text-[10px] sm:text-xs tracking-widest transition-all flex items-center justify-center gap-2 active:scale-95 shadow-lg",
                      "bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-600/20",
                      activeTab === "upload" && !uploadFile && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    {activeTab === "upload"
                      ? "ANALYZE"
                      : inputText.trim()
                        ? activeTab === "batch" ? "START BATCH" : "START"
                        : "PASTE URL"}
                  </button>
                </div>
              </div>
            </div>

            {/* Platform Indicators - Modern Style */}
            <div className="px-6 pb-6 pt-2 border-t border-white/5 flex flex-wrap justify-center gap-x-6 gap-y-2">
              <span className="text-[9px] font-bold text-gray-600 uppercase tracking-widest">
                Supports Platforms:
              </span>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                  <span className="text-[9px] font-bold text-gray-500">
                    YouTube
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className={cn("w-1.5 h-1.5 rounded-full", theme === "dark" ? "bg-white" : "bg-black")} />
                  <span className="text-[9px] font-bold text-gray-500">
                    TikTok
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-pink-500" />
                  <span className="text-[9px] font-bold text-gray-500">
                    Instagram
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                  <span className="text-[9px] font-bold text-gray-500">
                    Facebook
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                  <span className="text-[9px] font-bold text-gray-500">
                    X
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* <div className="max-w-2xl mx-auto h-24 bg-white/5 border border-white/10 rounded-3xl mt-6 mb-12 flex items-center justify-center text-gray-700 text-[10px] font-bold tracking-[6px] uppercase">
            Ad Space
          </div> */}
        </section>

        {/* Results */}
        <section className="space-y-12 mt-12 pb-24">
          <AnimatePresence mode="popLayout">
            {items.map((item) => (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-[#111] border border-white/5 shadow-xl rounded-[32px] overflow-hidden group relative"
              >
                {/* Remove Button - Absolute */}
                <button
                  onClick={() => removeItem(item.id)}
                  className="absolute top-4 right-4 z-10 p-2 bg-red-500/20 text-red-600 hover:bg-red-500/30 rounded-xl backdrop-blur transition-all active:scale-90 border border-red-500/40"
                  title="Remove Item"
                >
                  <Trash2 className="w-4 h-4" />
                </button>

                <div className="flex flex-col sm:flex-row">
                  {/* Compact Thumbnail Container */}
                  <div className="sm:w-64 aspect-video sm:aspect-square relative flex-shrink-0 bg-black/40 overflow-hidden group/carousel">
                    {previewId === item.id ? (
                      <video
                        src={(() => {
                          const formats = item.metadata?.formats || [];
                          const selected = formats.find(f => f.format_id === item.selectedQuality) || formats[0];
                          return selected?.url || item.url;
                        })()}
                        className="w-full h-full object-contain"
                        controls
                        autoPlay
                        playsInline
                      />
                    ) : (
                      <>
                        <img
                          src={
                            item.metadata?.thumbnail ||
                            "https://picsum.photos/seed/vid/800/450"
                          }
                          className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110 opacity-70"
                          referrerPolicy="no-referrer"
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => setPreviewId(item.id)}
                            className="w-12 h-12 bg-indigo-600 rounded-full flex items-center justify-center text-white shadow-2xl transform scale-90 group-hover:scale-100 transition-transform hover:scale-110 active:scale-95"
                          >
                            <Play className="w-6 h-6 fill-current ml-1" />
                          </button>
                        </div>
                      </>
                    )}
                    
                    {/* Compact Platform Badge */}
                    <div className="absolute top-4 left-4">
                      <div className="bg-black/60 backdrop-blur px-2 py-1 rounded-lg flex items-center gap-1.5 border border-white/10">
                        {getPlatformIcon(
                          detectPlatform(item.url),
                          "w-3 h-3",
                        )}
                        <span className="text-[8px] font-black tracking-widest uppercase text-white">
                          {detectPlatform(item.url)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Settings & Info Section */}
                  <div
                    className={cn(
                      "flex-1 p-6 sm:p-8 flex flex-col justify-between min-w-0 transition-colors duration-200",
                      theme === "dark" ? "bg-[#111]" : "bg-white",
                    )}
                  >
                    <div>
                      {/* Top Info */}
                      <div className="flex items-center gap-2 mb-4">
                        <div
                          className={cn(
                            "w-2 h-2 rounded-full",
                            item.status === "ready"
                              ? "bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]"
                              : "bg-amber-500 animate-pulse",
                          )}
                        />
                        <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                          {item.status === "loading" ? "SCANNING DATA..." : item.status}
                        </span>
                      </div>

                      <div className="mb-4">
                        {item.status === "error" && item.error && (
                          <div className="group/error flex flex-col gap-2">
                            <div className="text-[10px] text-red-400 font-mono bg-red-400/5 p-3 rounded-xl border border-red-400/10 max-h-20 overflow-auto scrollbar-hide">
                              {item.error}
                            </div>
                            <button
                              onClick={() => extractInfo(item.id)}
                              className="w-fit text-[10px] font-black text-indigo-400 hover:text-indigo-300 uppercase tracking-widest flex items-center gap-2 transition-colors"
                            >
                              <History className="w-3 h-3" /> RETRY
                            </button>
                          </div>
                        )}
                                                {item.status === "ready" && (
                          <div className={cn(
                            "grid gap-3",
                            detectPlatform(item.url) === "youtube" ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"
                          )}>
                            {/* Quality Select - Support YouTube with HD preference */}
                            {detectPlatform(item.url) === "youtube" && (
                              <div className={cn(
                                "rounded-xl p-3 border",
                                theme === "dark" ? "bg-white/5 border-white/5" : "bg-gray-50 border-gray-100"
                              )}>
                                <span className="text-[8px] font-black text-gray-600 uppercase block mb-1">QUALITY</span>
                                <select
                                  className="w-full bg-transparent text-[10px] font-black text-indigo-400 focus:outline-none appearance-none cursor-pointer uppercase tracking-widest"
                                  value={item.selectedQuality}
                                  onChange={(e) => setQuality(item.id, e.target.value)}
                                >
                                  {(() => {
                                    const allFormats = (item.metadata?.formats || []).filter((f: any) => f.vcodec !== "none" || f.ext === "mp4");
                                    const isShorts = item.url.includes("/shorts/");
                                    
                                    // If shorts, just show best quality
                                    if (isShorts) return <option value="direct">Best Quality (Shorts)</option>;
                                    
                                    // Filter for 720p, 1080p, 4K
                                    const hdFormats = allFormats.filter((f: any) => 
                                      f.height === 720 || f.height === 1080 || f.height === 1440 || f.height === 2160
                                    ).sort((a: any, b: any) => b.height - a.height);
                                    
                                    if (hdFormats.length > 0) {
                                      return hdFormats.map((f: any) => (
                                        <option key={f.format_id} value={f.format_id} className="bg-neutral-900 text-white">
                                          {f.resolution || `${f.height}p`} ({f.ext?.toUpperCase()})
                                        </option>
                                      ));
                                    }
                                    
                                    // Fallback to absolute best if no HD found
                                    return <option value="direct">Best Available Quality</option>;
                                  })()}
                                </select>
                              </div>
                            )}

                            {/* Media Type Display */}
                            {detectPlatform(item.url) !== "youtube" && (
                              <div className={cn(
                                "rounded-xl p-3 border flex flex-col justify-center",
                                theme === "dark" ? "bg-white/5 border-white/5" : "bg-gray-50 border-gray-100"
                              )}>
                                <span className="text-[8px] font-black text-gray-600 uppercase block mb-1">MEDIA TYPE</span>
                                <span className="text-xs font-black uppercase tracking-widest text-[#FF1493]">
                                  {(() => {
                                    const platform = detectPlatform(item.url);
                                    if (platform === "instagram") return "REELS";
                                    return "VIDEO";
                                  })()}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Bottom Action Section */}
                    <div className="flex items-center gap-2 mt-auto">
                      <button
                        onClick={() => window.open(item.url, "_blank")}
                        className="flex-1 h-12 border border-indigo-500/10 bg-indigo-500/5 hover:bg-indigo-500/10 text-indigo-500 rounded-xl flex items-center justify-center transition-all active:scale-95"
                        title="Open Original Link"
                      >
                        {getPlatformIcon(detectPlatform(item.url), "w-6 h-6")}
                      </button>
                      <button
                        onClick={() => generateTranscript(item.id, "both")}
                        disabled={item.status !== "ready" || item.isTranscribing}
                        className={cn(
                          "flex-1 h-12 border rounded-xl flex items-center justify-center transition-all",
                          theme === "dark"
                            ? "bg-[#FF1493]/10 border-[#FF1493]/20 text-[#FF1493] hover:bg-[#FF1493]/20"
                            : "bg-[#FF1493]/5 border-[#FF1493]/20 text-[#FF1493] hover:bg-[#FF1493]/10",
                          (item.status !== "ready" || item.isTranscribing) && "opacity-50 cursor-not-allowed"
                        )}
                        title="AI Magic Transcript"
                      >
                        {item.isTranscribing ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Sparkles className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => startDownload(item)}
                        disabled={item.status !== "ready"}
                        className="flex-1 h-12 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-xl font-black text-xs transition-all active:scale-95 shadow-lg shadow-indigo-600/10 flex items-center justify-center gap-2"
                      >
                        SAVE
                      </button>
                    </div>
                  </div>
                </div>

                <AnimatePresence>
                  {(item.transcriptNormal || item.transcriptTimeline) && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="border-t border-white/5 bg-white/[0.02] p-8"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "w-10 h-10 rounded-xl flex items-center justify-center",
                              item.transcriptActiveType === "timeline"
                                ? "bg-amber-500/20"
                                : "bg-indigo-500/20",
                            )}
                          >
                            {item.transcriptActiveType === "timeline" ? (
                              <Clock className="w-5 h-5 text-amber-500" />
                            ) : (
                              <Sparkles className="w-5 h-5 text-indigo-500" />
                            )}
                          </div>
                          <div>
                            <div className="flex bg-white/5 p-1 rounded-lg border border-white/5 gap-1">
                              <button
                                onClick={() =>
                                  generateTranscript(item.id, "normal")
                                }
                                className={cn(
                                  "px-3 py-1 rounded-md text-[10px] font-black uppercase transition-all",
                                  item.transcriptActiveType === "normal"
                                    ? "bg-indigo-600 text-white"
                                    : "text-gray-500 hover:text-gray-300",
                                )}
                              >
                                Text
                              </button>
                              <button
                                onClick={() =>
                                  generateTranscript(item.id, "timeline")
                                }
                                className={cn(
                                  "px-3 py-1 rounded-md text-[10px] font-black uppercase transition-all",
                                  item.transcriptActiveType === "timeline"
                                    ? "bg-amber-500 text-white"
                                    : "text-gray-500 hover:text-gray-300",
                                )}
                              >
                                Timestamps
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() =>
                              copyToClipboard(
                                item.transcriptActiveType === "timeline"
                                  ? item.transcriptTimeline || ""
                                  : item.transcriptNormal || "",
                              )
                            }
                            className="px-4 py-2 bg-indigo-600 text-white hover:bg-indigo-700 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
                          >
                            <Copy className="w-3.5 h-3.5" /> COPY
                          </button>
                          <button
                            onClick={() => exportTranscript(item.id, "srt")}
                            className="px-4 py-2 bg-indigo-600 text-white hover:bg-indigo-700 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
                          >
                            <FileDown className="w-3.5 h-3.5" /> SRT
                          </button>
                          <button
                            onClick={() => exportTranscript(item.id, "vtt")}
                            className="px-4 py-2 bg-indigo-600 text-white hover:bg-indigo-700 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
                          >
                            <FileDown className="w-3.5 h-3.5" /> VTT
                          </button>
                        </div>
                      </div>

                      <div className="p-6 bg-black/40 border border-white/5 rounded-2xl relative">
                        <div className="prose prose-invert prose-sm max-w-none">
                          {item.isTranscribing ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-4">
                              <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest animate-pulse">
                                Switching Mode...
                              </p>
                            </div>
                          ) : (
                            <pre className="whitespace-pre-wrap font-sans text-gray-300 text-sm leading-relaxed max-h-[400px] overflow-y-auto custom-scrollbar">
                              {(item.transcriptActiveType === "timeline"
                                ? item.transcriptTimeline
                                : item.transcriptNormal) || "Processing..."}
                            </pre>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* {items.length > 0 && (
            <div className="w-full h-32 bg-white/5 border border-white/10 rounded-3xl mt-12 flex items-center justify-center text-gray-600 text-[10px] font-bold tracking-[4px] uppercase">
              Ad Slot
            </div>
          )} */}
        </section>
      </main>

      <footer
        className={cn(
          "mt-4 border-t pt-16 pb-12 px-6 transition-colors duration-200",
          theme === "dark"
            ? "bg-black border-white/5"
            : "bg-white border-gray-100",
        )}
      >
        <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12 sm:gap-20">
          <div className="space-y-6 text-center sm:text-left">
            <div className="flex items-center gap-3 justify-center sm:justify-start">
              <h1
                className={cn(
                  "text-lg font-bold tracking-tighter",
                  theme === "dark" ? "text-white" : "text-gray-900",
                )}
              >
                VidScript
              </h1>
            </div>
            <p className="text-gray-500 text-sm leading-relaxed font-medium">
              The ultimate tool for fast video downloads and high-quality AI
              transcriptions. 100% free, no software required.
            </p>
          </div>

          <div className="text-center sm:text-left">
            <h4 className="text-[10px] font-black tracking-widest text-gray-600 uppercase mb-6">
              Service
            </h4>
            <ul className="space-y-4 text-sm font-bold text-gray-400">
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Free Video Downloader
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white transition-colors">
                  Free AI Transcript Online
                </a>
              </li>
            </ul>
          </div>

          <div className="text-center sm:text-left">
            <h4 className="text-[10px] font-black tracking-widest text-gray-600 uppercase mb-6">
              Legal
            </h4>
            <ul className="space-y-4 text-sm font-bold text-gray-400">
              <li>
                <button
                  onClick={() =>
                    setLegalTab(legalTab === "terms" ? null : "terms")
                  }
                  className="hover:text-white transition-colors"
                >
                  Terms of Use
                </button>
              </li>
              <li>
                <button
                  onClick={() =>
                    setLegalTab(legalTab === "privacy" ? null : "privacy")
                  }
                  className="hover:text-white transition-colors"
                >
                  Privacy Policy
                </button>
              </li>
            </ul>
          </div>
        </div>

        <AnimatePresence>
          {legalTab && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className={cn(
                "max-w-6xl mx-auto mt-12 p-8 rounded-3xl border",
                theme === "dark"
                  ? "bg-white/5 border-white/10"
                  : "bg-white border-gray-100 shadow-xl",
              )}
            >
              {legalTab === "terms" ? (
                <div
                  className={cn(
                    "prose prose-sm max-w-none",
                    theme === "dark" && "prose-invert",
                  )}
                >
                  <h3 className="flex items-center gap-2 font-black uppercase text-[10px] tracking-widest leading-none mb-6">
                    <Scale className="w-5 h-5 text-indigo-400" /> Terms of
                    Service
                  </h3>
                  <div className="space-y-4">
                    <p>
                      Welcome to VidScript. By using our service, you agree to
                      the following terms:
                    </p>
                    <ul className="space-y-2">
                      <li>
                        <strong>Service Description:</strong> VidScript provides
                        video download and AI-powered transcription services.
                      </li>
                      <li>
                        <strong>Fair Use:</strong> Our service is intended for
                        personal, non-commercial use only. Respect the copyright
                        of content owners.
                      </li>
                      <li>
                        <strong>Abuse:</strong> We reserve the right to block
                        users who abuse our system or use it for illegal
                        purposes.
                      </li>
                      <li>
                        <strong>Disclaimer:</strong> Transcripts are
                        AI-generated and may contain inaccuracies. We are not
                        responsible for errors.
                      </li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div
                  className={cn(
                    "prose prose-sm max-w-none",
                    theme === "dark" && "prose-invert",
                  )}
                >
                  <h3 className="flex items-center gap-2 font-black uppercase text-[10px] tracking-widest leading-none mb-6">
                    <Shield className="w-5 h-5 text-green-400" /> Privacy Policy
                  </h3>
                  <div className="space-y-4">
                    <p>
                      Your privacy is important to us. Here is how we handle
                      your data:
                    </p>
                    <ul className="space-y-2">
                      <li>
                        <strong>Data Collection:</strong> we do not store your
                        videos. We only temporarily process URLs to provide
                        download links and transcripts.
                      </li>
                      <li>
                        <strong>Cookies:</strong> We use Google AdSense which
                        may use cookies to serve personalized ads. By using this
                        site, you consent to this.
                      </li>
                      <li>
                        <strong>Third-Parties:</strong> We use the Gemini API
                        for transcription. Your video metadata is processed
                        according to Google's privacy policies.
                      </li>
                      <li>
                        <strong>Security:</strong> We implement standard
                        security measures to protect the interaction with our
                        API.
                      </li>
                    </ul>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <div
          className={cn(
            "max-w-6xl mx-auto mt-12 pt-8 border-t flex flex-col sm:flex-row items-center justify-between gap-6 opacity-40",
            theme === "dark" ? "border-white/5" : "border-gray-100",
          )}
        >
          <p className="text-[9px] font-bold tracking-[3px] uppercase">
            VIDSCRIPT © 2026
          </p>
        </div>
      </footer>
    </div>
  );
}
