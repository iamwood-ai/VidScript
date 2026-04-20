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
  X
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
}

interface VideoMetadata {
  id: string;
  title: string;
  description?: string;
  thumbnail: string;
  webpage_url: string;
  duration?: number;
  uploader?: string;
  formats: Format[];
  extractor: string;
}

interface DownloadItem {
  id: string;
  url: string;
  status: "idle" | "loading" | "ready" | "error";
  metadata?: VideoMetadata;
  error?: string;
  audioOnly: boolean;
  selectedQuality?: string;
  transcript?: string;
  transcriptType?: "normal" | "timeline";
  isTranscribing?: boolean;
}

export default function App() {
  const [inputText, setInputText] = useState("");
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [legalTab, setLegalTab] = useState<"terms" | "privacy" | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window !== 'undefined') {
       return (localStorage.getItem("theme") as "dark" | "light") || "light";
    }
    return "light";
  });
  const [activeTab, setActiveTab] = useState<"single" | "batch" | "upload">("single");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  
  const aiInstance = useRef<GoogleGenAI | null>(null);

  const getAi = () => {
    if (aiInstance.current) return aiInstance.current;
    if (process.env.GEMINI_API_KEY) {
      aiInstance.current = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      return aiInstance.current;
    }
    return null;
  };

  const detectPlatform = (url: string) => {
    const u = url.toLowerCase();
    if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
    if (u.includes("tiktok.com")) return "tiktok";
    if (u.includes("facebook.com") || u.includes("fb.watch")) return "facebook";
    if (u.includes("instagram.com")) return "instagram";
    return "generic";
  };

  const getPlatformIcon = (platform: string, size = "w-5 h-5") => {
    switch (platform) {
      case "youtube": return <Youtube className={cn("text-red-500", size)} />;
      case "instagram": return <Instagram className={cn("text-pink-500", size)} />;
      case "facebook": return <Facebook className={cn("text-blue-600", size)} />;
      case "tiktok": return <div className={cn("text-white font-black italic", size)}>TT</div>;
      default: return <LinkIcon className={cn("text-gray-400", size)} />;
    }
  };

  const handleAddUrls = useCallback(() => {
    if (!inputText.trim() && activeTab !== 'upload') return;

    let urls: string[] = [];
    
    if (activeTab === 'single') {
      const match = inputText.match(/https?:\/\/[^\s,]+/);
      if (match) urls = [match[0]];
    } else if (activeTab === 'batch') {
      urls = inputText
        .split(/\n|,| /)
        .map(url => url.trim())
        .filter(url => url.startsWith("http"))
        .slice(0, 10);
    } else if (activeTab === 'upload' && uploadFile) {
       // Handle file upload pseudo-item
       const newItem: DownloadItem = {
          id: Math.random().toString(36).substring(7),
          url: 'local-file',
          status: 'ready',
          audioOnly: false,
          metadata: {
             id: 'upload',
             title: uploadFile.name,
             extractor: 'upload',
             thumbnail: URL.createObjectURL(uploadFile), // Might not work for all files but okay for thumb
             formats: [],
             webpage_url: '#'
          }
       };
       setItems(prev => [newItem, ...prev]);
       setUploadFile(null);
       return;
    }

    const newItems: DownloadItem[] = urls.map(url => ({
      id: Math.random().toString(36).substring(7),
      url,
      status: "idle",
      audioOnly: false,
    }));

    setItems(prev => [...newItems, ...prev]);
    setInputText("");
  }, [inputText, activeTab, uploadFile]);

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setInputText(prev => prev ? `${prev}\n${text}` : text);
      }
    } catch (err) {
      console.error("Failed to read clipboard:", err);
    }
  };

  const extractInfo = async (id: string) => {
    setItems(current => 
      current.map(item => item.id === id ? { ...item, status: "loading" } : item)
    );

    const item = items.find(i => i.id === id); 
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
        throw new Error(data.details || data.error || "Failed to extract video info");
      }

      setItems(current => 
        current.map(item => item.id === id ? { 
          ...item, 
          status: "ready", 
          metadata: data,
          selectedQuality: data.formats
            .filter((f: any) => f.vcodec !== 'none')
            .sort((a: any, b: any) => (b.quality || 0) - (a.quality || 0))[0]?.format_id || "default"
        } : item)
      );
    } catch (err: any) {
      setItems(current => 
        current.map(item => item.id === id ? { ...item, status: "error", error: err.message } : item)
      );
    }
  };

  const generateTranscript = async (id: string, type: "normal" | "timeline") => {
    const item = items.find(i => i.id === id);
    const ai = getAi();
    if (!item || !item.metadata || !ai) return;

    setItems(current => current.map(item => item.id === id ? { ...item, isTranscribing: true, transcriptType: type } : item));

    const promptType = type === "timeline" 
      ? "Generate a detailed TIMELINE/CHAPTER based transcript. Include timestamps (e.g. 00:00 - Intro) and describe what happens in each segment."
      : "Generate a detailed flow-of-text summary and transcript overview. Format it as an informative reading text.";

    try {
      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Analyze this video metadata and generate the requested content.
        Type: ${promptType}
        Title: ${item.metadata.title}
        Description: ${item.metadata.description || "No description available"}
        Duration: ${item.metadata.duration || "Unknown"} seconds
        Platform: ${item.metadata.extractor}
        
        CRITICAL: Detect the language of the video from the title/metadata and generate the response in that natural language. 
        Keep it accurate. Use Markdown.`
      });

      setItems(current => current.map(item => item.id === id ? { ...item, transcript: result.text, isTranscribing: false } : item));
    } catch (err) {
      console.error("AI Error:", err);
      setItems(current => current.map(item => item.id === id ? { ...item, isTranscribing: false, transcript: "Failed to generate AI content." } : item));
    }
  };

  const removeItem = (id: string) => {
    setItems(current => current.filter(item => item.id !== id));
  };

  const toggleAudioOnly = (id: string) => {
    setItems(current => current.map(item => 
      item.id === id ? { ...item, audioOnly: !item.audioOnly } : item
    ));
  };

  const setQuality = (id: string, qualityId: string) => {
    setItems(current => current.map(item => 
      item.id === id ? { ...item, selectedQuality: qualityId } : item
    ));
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Could add a toast here
  };

  const exportTranscript = (id: string, format: 'srt' | 'vtt') => {
    const item = items.find(i => i.id === id);
    if (!item || !item.transcript) return;

    const content = format === 'vtt' ? `WEBVTT\n\n${item.transcript}` : item.transcript;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item.metadata?.title || 'transcript'}.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  const startDownload = (item: DownloadItem) => {
    if (!item.metadata) return;

    let format: Format | undefined;
    
    if (item.audioOnly) {
      format = item.metadata.formats
        .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
        .sort((a,b) => (b.filesize || 0) - (a.filesize || 0))[0];
    } else {
      format = item.metadata.formats.find(f => f.format_id === item.selectedQuality);
    }

    if (!format) {
      format = item.metadata.formats
        .filter(f => f.vcodec !== 'none')
        .sort((a,b) => (b.quality || 0) - (a.quality || 0))[0];
    }

    const safeTitle = (item.metadata.title || "video").replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const extension = item.audioOnly ? "mp3" : "mp4";
    const downloadUrl = `/api/proxy?url=${encodeURIComponent(format.url)}&filename=${encodeURIComponent(safeTitle + "." + extension)}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.target = "_blank";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Auto-extract idle items
  useEffect(() => {
    const idleItem = items.find(item => item.status === "idle");
    if (idleItem) {
      extractInfo(idleItem.id);
    }
  }, [items]);

  return (
    <div className={cn(
      "min-h-screen font-sans overflow-x-hidden transition-colors duration-200",
      theme === "dark" ? "bg-[#050505] text-white" : "bg-[#F8F9FB] text-gray-900"
    )}>
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none -z-10">
        <div className={cn(
          "absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full blur-[140px]",
          theme === "dark" ? "bg-indigo-900/10" : "bg-indigo-500/5"
        )} />
        <div className={cn(
          "absolute bottom-[10%] right-[-10%] w-[40%] h-[40%] rounded-full blur-[140px]",
          theme === "dark" ? "bg-purple-900/10" : "bg-purple-500/5"
        )} />
      </div>

      <nav className={cn(
        "sticky top-0 z-50 backdrop-blur-xl border-b px-6 py-4 transition-colors duration-200",
        theme === "dark" 
          ? "bg-[#050505] border-white/5" 
          : "bg-white/95 border-gray-100 shadow-sm"
      )}>
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={cn(
              "w-10 h-10 rounded-xl flex items-center justify-center shadow-lg transition-transform hover:scale-105",
              theme === "dark" ? "bg-indigo-600 shadow-indigo-500/20" : "bg-indigo-500 shadow-indigo-500/10"
            )}>
              <Download className="text-white w-5 h-5" />
            </div>
            <h1 className={cn("text-xl font-bold tracking-tight", theme === "dark" ? "text-white" : "text-gray-900")}>VidScript</h1>
          </div>
          <div className="flex items-center gap-4">
             <button 
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className={cn(
                  "p-2 rounded-xl border transition-all active:scale-95",
                  theme === "dark" ? "border-white/10 bg-white/5 hover:bg-white/10" : "border-gray-200 bg-gray-50 hover:bg-gray-100"
                )}
             >
                {theme === "dark" ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-indigo-600" />}
             </button>
          </div>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-6 pt-6 pb-0 lg:pt-12 lg:pb-0">
        {/* Compact Top Ad */}
        <div className="w-full h-16 bg-white/5 border border-white/10 rounded-2xl mb-8 flex items-center justify-center text-gray-700 text-[10px] font-bold tracking-widest uppercase">
          Advertisement
        </div>

        <section className="text-center mb-8">
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            <h3 className={cn(
              "text-xl sm:text-4xl font-black mb-1 tracking-tight",
              theme === "dark" ? "text-white" : "text-black"
            )}>
              Free video downloads and AI transcripts.
            </h3>
            <h4 className="text-lg sm:text-2xl font-black mb-8 tracking-tight leading-tight text-indigo-600 uppercase tracking-[6px]">
              Paste, Save, and Analyze.
            </h4>
          </motion.div>
        </section>

        {/* Search / Input Box - Mode Tapped */}
        <section className="mb-0">
          <div className={cn(
            "max-w-2xl mx-auto rounded-[32px] border transition-all duration-200 overflow-hidden",
            theme === "dark" 
              ? "bg-[#111] border-white/5" 
              : "bg-white border-gray-100 shadow-xl"
          )}>
            {/* Tabs */}
            <div className={cn(
              "flex border-b p-2 gap-1",
              theme === "dark" ? "border-white/5" : "border-gray-100 bg-gray-50/50"
            )}>
               <button 
                onClick={() => setActiveTab('single')}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all",
                  activeTab === 'single' 
                    ? (theme === 'dark' ? "bg-white/10 text-white" : "bg-white text-indigo-600 shadow-sm") 
                    : "text-gray-500 hover:text-gray-400"
                )}
               >
                 <LinkIcon className="w-3 h-3" />
                 URL
               </button>
               <button 
                onClick={() => setActiveTab('batch')}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all",
                  activeTab === 'batch' 
                    ? (theme === 'dark' ? "bg-white/10 text-white" : "bg-white text-indigo-600 shadow-sm") 
                    : "text-gray-500 hover:text-gray-400"
                )}
               >
                 <Layers className="w-3 h-3" />
                 BATCH
               </button>
               <button 
                onClick={() => setActiveTab('upload')}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all",
                  activeTab === 'upload' 
                    ? (theme === 'dark' ? "bg-white/10 text-white" : "bg-white text-indigo-600 shadow-sm") 
                    : "text-gray-500 hover:text-gray-400"
                )}
               >
                 <FileUp className="w-3 h-3" />
                 UPLOAD
               </button>
            </div>

            <div className="p-4 sm:p-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
               {activeTab === 'upload' ? (
                 <label className="w-full sm:flex-1 flex flex-col items-center justify-center border-2 border-dashed border-white/10 rounded-2xl p-6 cursor-pointer hover:bg-white/5 transition-colors group">
                    <UploadIcon className="w-8 h-8 text-indigo-500 mb-2 group-hover:scale-110 transition-transform" />
                    <span className="text-sm font-bold text-gray-500 text-center">{uploadFile ? uploadFile.name : "Select Video File"}</span>
                    <input 
                      type="file" 
                      className="hidden" 
                      accept="video/mp4,video/x-m4v,video/*,audio/*"
                      onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                    />
                 </label>
               ) : (
                 <div className={cn(
                   "w-full sm:flex-1 flex items-center px-6 rounded-2xl border transition-all h-[64px]",
                   theme === "dark" 
                     ? "bg-black border-white/10 focus-within:border-indigo-500/50" 
                     : "bg-gray-50 border-gray-100 focus-within:border-indigo-500/30"
                 )}>
                    <textarea
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder="Paste a video URL…"
                      className="flex-1 bg-transparent border-none focus:ring-0 text-sm sm:text-base placeholder-gray-700 resize-none h-[24px] overflow-hidden whitespace-nowrap p-0 leading-[24px]"
                      onKeyDown={(e) => !e.shiftKey && e.key === 'Enter' && (e.preventDefault(), handleAddUrls())}
                    />
                 </div>
               )}
               
               <div className="w-full sm:w-auto flex flex-col gap-3 shrink-0">
                  <button
                    onClick={(!inputText.trim() && activeTab !== 'upload') ? handlePaste : handleAddUrls}
                    disabled={activeTab === 'upload' && !uploadFile}
                    className={cn(
                      "w-full px-10 h-[64px] rounded-2xl font-black text-[10px] sm:text-xs tracking-widest transition-all flex items-center justify-center gap-2 active:scale-95 shadow-lg",
                      (!inputText.trim() && activeTab !== 'upload')
                        ? "bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-600/20"
                        : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-600/20"
                    )}
                  >
                    {activeTab === 'upload' 
                      ? 'ANALYZE' 
                      : (inputText.trim() ? 'START' : 'PASTE URL')}
                    {inputText.trim() ? <ChevronRight className="w-4 h-4" /> : <LinkIcon className="w-4 h-4" />}
                  </button>

                  {(inputText.trim() && activeTab !== 'upload') && (
                    <button 
                      onClick={() => setInputText("")}
                      className="w-full h-12 rounded-2xl bg-red-600/10 hover:bg-red-600 text-red-500 hover:text-white transition-all font-black text-[9px] uppercase tracking-[3px] border border-red-600/20 active:scale-95 animate-in slide-in-from-top-2 duration-200"
                    >
                      Remove URL
                    </button>
                  )}
               </div>
            </div>

            {/* Platform Indicators - Modern Style */}
            <div className="px-6 pb-6 pt-2 border-t border-white/5 flex flex-wrap justify-center gap-x-6 gap-y-2">
               <span className="text-[9px] font-bold text-gray-600 uppercase tracking-widest">Supports Platforms:</span>
               <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                    <span className="text-[9px] font-bold text-gray-500">YouTube</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    <span className="text-[9px] font-bold text-gray-500">TikTok</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-pink-500" />
                    <span className="text-[9px] font-bold text-gray-500">Instagram</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                    <span className="text-[9px] font-bold text-gray-500">Facebook</span>
                  </div>
               </div>
            </div>
          </div>

          <div className="max-w-2xl mx-auto h-24 bg-white/5 border border-white/10 rounded-3xl mt-6 mb-12 flex items-center justify-center text-gray-700 text-[10px] font-bold tracking-[6px] uppercase">
            Ad Space
          </div>
        </section>

        {/* Results */}
        <section className="space-y-12 mt-12">
          <AnimatePresence mode="popLayout">
            {items.map((item) => (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-[#111] border border-white/5 shadow-xl rounded-[32px] overflow-hidden group"
              >
                <div className="flex flex-col lg:flex-row">
                  {/* Thumbnail/Player Section */}
                  <div className="lg:w-[45%] aspect-[3/4] relative bg-black/40 overflow-hidden">
                    {previewId === item.id ? (
                      <video 
                        src={`/api/proxy?url=${encodeURIComponent(item.metadata?.formats.filter(f => f.vcodec !== 'none')[0]?.url || item.url)}`}
                        className="w-full h-full object-contain"
                        controls
                        autoPlay
                      />
                    ) : (
                      <>
                        <img 
                          src={item.metadata?.thumbnail || "https://picsum.photos/seed/vid/800/450"} 
                          className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110 opacity-70"
                          referrerPolicy="no-referrer"
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button 
                              onClick={() => setPreviewId(item.id)}
                              className="w-16 h-16 bg-indigo-600 rounded-full flex items-center justify-center text-white shadow-2xl transform scale-90 group-hover:scale-100 transition-transform hover:scale-110"
                            >
                              <Play className="w-8 h-8 fill-current ml-1" />
                            </button>
                        </div>
                      </>
                    )}
                    <div className="absolute top-4 left-4">
                       <div className="bg-black/60 backdrop-blur px-2 py-1 rounded-lg flex items-center gap-1.5 border border-white/10">
                          {getPlatformIcon(detectPlatform(item.url), "w-3.5 h-3.5")}
                          <span className="text-[9px] font-bold tracking-widest uppercase text-white">{detectPlatform(item.url)}</span>
                       </div>
                    </div>
                  </div>

                  <div className={cn(
                    "flex-1 p-8 flex flex-col justify-between min-w-0 transition-colors duration-200",
                    theme === "dark" ? "bg-[#111]" : "bg-white"
                  )}>
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                           <div className={cn("w-2 h-2 rounded-full", item.status === 'ready' ? "bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]" : "bg-amber-500 animate-pulse")} />
                           <span className={cn("text-[10px] font-black uppercase tracking-widest", theme === "dark" ? "text-gray-500" : "text-gray-400")}>{item.status}</span>
                        </div>
                        <button 
                          onClick={() => removeItem(item.id)}
                          className="text-gray-600 hover:text-red-500 transition-colors p-2 hover:bg-red-500/10 rounded-lg"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>

                      <div className="mb-6">
                        {item.status === 'error' && item.error && (
                          <div className="group/error mb-4">
                            <div className="text-[10px] text-red-400 font-mono bg-red-400/5 p-3 rounded-xl border border-red-400/10 max-h-24 overflow-auto scrollbar-hide mb-2">
                               {item.error}
                            </div>
                            <button 
                              onClick={() => extractInfo(item.id)}
                              className="text-[10px] font-black text-indigo-400 hover:text-indigo-300 uppercase tracking-widest flex items-center gap-2 transition-colors"
                            >
                              <History className="w-3 h-3" /> Try Again
                            </button>
                          </div>
                        )}
                        {item.status === 'loading' && (
                          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest animate-pulse">Processing metadata...</p>
                        )}
                        {item.status === 'ready' && (
                           <div className="flex items-center gap-2 mb-2">
                              <CheckCircle2 className="w-3 h-3 text-green-500" />
                              <span className="text-[9px] font-black text-gray-400 uppercase tracking-[2px]">Verified High-Quality Source</span>
                           </div>
                        )}
                      </div>

                    {item.status === 'ready' && (
                        <div className={cn(
                          "grid gap-4 mb-8",
                          (detectPlatform(item.url) === 'youtube' && !item.url.includes('/shorts/')) ? "grid-cols-2" : "grid-cols-1"
                        )}>
                           {(detectPlatform(item.url) === 'youtube' && !item.url.includes('/shorts/')) && (
                             <div className={cn(
                               "rounded-2xl p-4 border transition-colors hover:border-indigo-500/30",
                               theme === "dark" ? "bg-white/5 border-white/5" : "bg-gray-50 border-gray-100"
                             )}>
                                <span className="text-[9px] font-bold text-gray-600 uppercase block mb-2">Quality</span>
                                <select 
                                  className="w-full bg-transparent text-sm font-bold focus:outline-none appearance-none cursor-pointer"
                                  value={item.selectedQuality}
                                  onChange={(e) => setQuality(item.id, e.target.value)}
                                >
                                  {item.metadata?.formats
                                    .filter(f => f.vcodec !== 'none')
                                    .sort((a,b) => (b.quality || 0) - (a.quality || 0))
                                    .map(f => <option key={f.format_id} value={f.format_id} className="bg-neutral-900 text-white">{f.resolution || "Auto"}</option>)}
                                </select>
                             </div>
                           )}
                           <div className={cn(
                             "rounded-2xl p-4 border flex flex-col justify-between transition-colors",
                             theme === "dark" ? "bg-white/5 border-white/5" : "bg-gray-50 border-gray-100"
                           )}>
                              <span className="text-[9px] font-bold text-gray-600 uppercase block mb-1">Mode</span>
                              <div className="flex items-center justify-between gap-2">
                                 <button onClick={() => toggleAudioOnly(item.id)} className={cn("flex-1 py-1 rounded text-[10px] font-bold transition-all", !item.audioOnly ? "bg-indigo-600 text-white" : "bg-white/10 text-gray-500")}>VIDEO</button>
                                 <button onClick={() => toggleAudioOnly(item.id)} className={cn("flex-1 py-1 rounded text-[10px] font-bold transition-all", item.audioOnly ? "bg-indigo-600 text-white" : "bg-white/10 text-gray-500")}>MP3</button>
                              </div>
                           </div>
                        </div>
                      )}
                    </div>

                    <div className="flex items-stretch gap-3">
                       <button
                        onClick={() => startDownload(item)}
                        disabled={item.status !== "ready"}
                        className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-500 text-white py-4 rounded-2xl font-bold flex items-center justify-center transition-all active:scale-95 shadow-lg shadow-indigo-500/20"
                      >
                        SAVE
                      </button>
                      <div className="relative group/menu">
                        <button
                          disabled={item.status !== "ready" || item.isTranscribing}
                          className={cn(
                            "px-6 h-full border rounded-2xl flex items-center justify-center gap-2 group transition-all",
                            theme === "dark" ? "bg-white/5 border-white/10 hover:bg-white/10" : "bg-gray-50 border-gray-200 hover:bg-gray-100"
                          )}
                        >
                          {item.isTranscribing ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileText className="w-5 h-5 group-hover:text-indigo-400" />}
                          <span className="hidden sm:inline font-bold text-sm tracking-tight uppercase">AI Magic</span>
                        </button>
                        
                        <div className="absolute right-0 bottom-full mb-2 bg-[#111] border border-white/10 p-2 rounded-2xl shadow-2xl opacity-0 group-hover/menu:opacity-100 pointer-events-none group-hover/menu:pointer-events-auto transition-all scale-95 group-hover/menu:scale-100 z-50">
                           <button onClick={() => generateTranscript(item.id, 'normal')} className="w-full px-4 py-3 rounded-xl hover:bg-white/5 flex items-center gap-3 transition-colors text-left">
                              <FileText className="w-4 h-4 text-gray-400" />
                              <div className="leading-none">
                                <p className="text-xs font-bold text-gray-200">Normal Script</p>
                                <p className="text-[9px] text-gray-500">Flowing text summary</p>
                              </div>
                           </button>
                           <button onClick={() => generateTranscript(item.id, 'timeline')} className="w-full px-4 py-3 rounded-xl hover:bg-white/5 flex items-center gap-3 transition-colors mt-1 text-left">
                              <History className="w-4 h-4 text-gray-400" />
                              <div className="leading-none">
                                <p className="text-xs font-bold text-gray-200">Timeline Mode</p>
                                <p className="text-[9px] text-gray-500">Chaptered transcript</p>
                              </div>
                           </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <AnimatePresence>
                   {item.transcript && (
                     <motion.div 
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      className="border-t border-white/5 bg-white/[0.02] p-8"
                     >
                       <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                          <div className="flex items-center gap-3">
                             <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center", item.transcriptType === 'timeline' ? "bg-amber-500/20" : "bg-indigo-500/20")}>
                                {item.transcriptType === 'timeline' ? <Clock className="w-5 h-5 text-amber-500" /> : <Sparkles className="w-5 h-5 text-indigo-500" />}
                             </div>
                             <div>
                                <span className="text-[10px] font-black text-gray-500 uppercase tracking-[2px] block">
                                  AI Generation: {item.transcriptType?.toUpperCase()}
                                </span>
                                <p className="text-sm font-bold text-gray-200">Video Transcript</p>
                             </div>
                          </div>
                          
                          <div className="flex items-center gap-2">
                             <button 
                               onClick={() => copyToClipboard(item.transcript || "")}
                               className="px-4 py-2 bg-indigo-600 text-white hover:bg-indigo-700 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
                             >
                               <Copy className="w-3.5 h-3.5" /> COPY
                             </button>
                             <button 
                               onClick={() => exportTranscript(item.id, 'srt')}
                               className="px-4 py-2 bg-indigo-600 text-white hover:bg-indigo-700 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
                             >
                               <FileDown className="w-3.5 h-3.5" /> SRT
                             </button>
                             <button 
                               onClick={() => exportTranscript(item.id, 'vtt')}
                               className="px-4 py-2 bg-indigo-600 text-white hover:bg-indigo-700 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
                             >
                               <FileDown className="w-3.5 h-3.5" /> VTT
                             </button>
                          </div>
                       </div>
                       
                       <div className="p-6 bg-black/40 border border-white/5 rounded-2xl relative">
                          <div className="prose prose-invert prose-sm max-w-none">
                             <pre className="whitespace-pre-wrap font-sans text-gray-300 text-sm leading-relaxed max-h-[400px] overflow-y-auto custom-scrollbar">
                               {item.transcript}
                             </pre>
                          </div>
                       </div>
                     </motion.div>
                   )}
                </AnimatePresence>
              </motion.div>
            ))}
          </AnimatePresence>
           
          {items.length > 0 && (
             <div className="w-full h-32 bg-white/5 border border-white/10 rounded-3xl mt-12 flex items-center justify-center text-gray-600 text-[10px] font-bold tracking-[4px] uppercase">
                Ad Slot
             </div>
          )}
        </section>
      </main>

      <footer className={cn(
        "mt-4 border-t pt-16 pb-12 px-6 transition-colors duration-200",
        theme === "dark" ? "bg-black border-white/5" : "bg-white border-gray-100"
      )}>
        <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12 sm:gap-20">
           <div className="space-y-6 text-center sm:text-left">
              <div className="flex items-center gap-3 justify-center sm:justify-start">
                  <h1 className={cn("text-lg font-bold tracking-tighter", theme === "dark" ? "text-white" : "text-gray-900")}>VidScript</h1>
              </div>
              <p className="text-gray-500 text-sm leading-relaxed font-medium">
                The ultimate tool for fast video downloads and high-quality AI transcriptions. 100% free, no software required.
              </p>
           </div>
           
           <div className="text-center sm:text-left">
              <h4 className="text-[10px] font-black tracking-widest text-gray-600 uppercase mb-6">Service</h4>
              <ul className="space-y-4 text-sm font-bold text-gray-400">
                 <li><a href="#" className="hover:text-white transition-colors">Free Video Downloader</a></li>
                 <li><a href="#" className="hover:text-white transition-colors">Free AI Transcript Online</a></li>
              </ul>
           </div>

           <div className="text-center sm:text-left">
              <h4 className="text-[10px] font-black tracking-widest text-gray-600 uppercase mb-6">Legal</h4>
              <ul className="space-y-4 text-sm font-bold text-gray-400">
                 <li><button onClick={() => setLegalTab(legalTab === 'terms' ? null : 'terms')} className="hover:text-white transition-colors">Terms of Use</button></li>
                 <li><button onClick={() => setLegalTab(legalTab === 'privacy' ? null : 'privacy')} className="hover:text-white transition-colors">Privacy Policy</button></li>
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
                  : "bg-white border-gray-100 shadow-xl"
              )}
            >
              {legalTab === 'terms' ? (
                <div className={cn("prose prose-sm max-w-none", theme === 'dark' && "prose-invert")}>
                  <h3 className="flex items-center gap-2 font-black uppercase text-[10px] tracking-widest leading-none mb-6">
                    <Scale className="w-5 h-5 text-indigo-400" /> Terms of Service
                  </h3>
                  <div className="space-y-4">
                    <p>Welcome to VidScript. By using our service, you agree to the following terms:</p>
                    <ul className="space-y-2">
                      <li><strong>Service Description:</strong> VidScript provides video download and AI-powered transcription services.</li>
                      <li><strong>Fair Use:</strong> Our service is intended for personal, non-commercial use only. Respect the copyright of content owners.</li>
                      <li><strong>Abuse:</strong> We reserve the right to block users who abuse our system or use it for illegal purposes.</li>
                      <li><strong>Disclaimer:</strong> Transcripts are AI-generated and may contain inaccuracies. We are not responsible for errors.</li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div className={cn("prose prose-sm max-w-none", theme === 'dark' && "prose-invert")}>
                   <h3 className="flex items-center gap-2 font-black uppercase text-[10px] tracking-widest leading-none mb-6">
                     <Shield className="w-5 h-5 text-green-400" /> Privacy Policy
                   </h3>
                   <div className="space-y-4">
                    <p>Your privacy is important to us. Here is how we handle your data:</p>
                    <ul className="space-y-2">
                      <li><strong>Data Collection:</strong> we do not store your videos. We only temporarily process URLs to provide download links and transcripts.</li>
                      <li><strong>Cookies:</strong> We use Google AdSense which may use cookies to serve personalized ads. By using this site, you consent to this.</li>
                      <li><strong>Third-Parties:</strong> We use the Gemini API for transcription. Your video metadata is processed according to Google's privacy policies.</li>
                      <li><strong>Security:</strong> We implement standard security measures to protect the interaction with our API.</li>
                    </ul>
                   </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <div className={cn(
          "max-w-6xl mx-auto mt-12 pt-8 border-t flex flex-col sm:flex-row items-center justify-between gap-6 opacity-40",
          theme === "dark" ? "border-white/5" : "border-gray-100"
        )}>
           <p className="text-[9px] font-bold tracking-[3px] uppercase">VIDSCRIPT © 2026</p>
        </div>
      </footer>
    </div>
  );
}
