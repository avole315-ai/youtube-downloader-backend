/**
 * YouTube Video Downloader - Node.js Backend
 * Works on VPS, cloud hosting, and local development
 * Requires: yt-dlp and ffmpeg installed
 * 
 * Installation:
 * 1. npm install
 * 2. Install yt-dlp and ffmpeg on your system
 * 3. Set environment variables (see .env.example)
 * 4. npm start
 */

import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_DURATION = 3600; // Maximum video duration (seconds)
const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*', // Set to your frontend domain in production
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    name: 'YouTube Downloader API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      download: 'GET /download?url=<youtube-url>&mode=video|audio&quality=720p&container=mp4&bitrate=192&start=00:00:00&end=00:05:00',
      info: 'GET /info?url=<youtube-url>',
    },
  });
});

// Get video info without downloading
app.get('/info', async (req, res) => {
  const { url } = req.query;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    const info = await getVideoInfo(url);
    res.json(info);
  } catch (error) {
    console.error('Info error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Main download endpoint
app.get('/download', async (req, res) => {
  const {
    url,
    mode = 'video',
    quality = '720p',
    container = 'mp4',
    bitrate = '192',
    start,
    end,
  } = req.query;

  // Validate URL
  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  // Validate mode
  if (!['video', 'audio'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode. Use "video" or "audio"' });
  }

  try {
    // Get video info
    const info = await getVideoInfo(url);
    const duration = info.duration || 0;

    // Check duration limit
    if (duration > MAX_DURATION) {
      throw new Error(`Video too long (max ${MAX_DURATION / 60} minutes)`);
    }

    // Sanitize title for filename
    const title = sanitizeFilename(info.title || 'video');
    
    // Build format selector
    let format, ext, filename;

    if (mode === 'audio') {
      format = 'bestaudio';
      ext = container === 'mp3' ? 'mp3' : 'webm';
      filename = `${title}_${bitrate}kbps.${ext}`;
    } else {
      const qualityNum = parseInt(quality.replace('p', ''));
      format = `bestvideo[height<=${qualityNum}]+bestaudio/best[height<=${qualityNum}]`;
      ext = container;
      filename = `${title}_${quality}.${ext}`;
    }

    // Generate temp file path
    const tempFile = path.join(os.tmpdir(), `ytdl_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);

    // Download video
    await downloadVideo(url, format, ext, tempFile, mode, bitrate, container);

    // Apply trimming if requested
    let finalFile = tempFile;
    if (start || end) {
      const trimmedFile = path.join(os.tmpdir(), `ytdl_trim_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
      await trimVideo(tempFile, trimmedFile, start, end);
      
      // Clean up original file
      await fs.unlink(tempFile).catch(() => {});
      finalFile = trimmedFile;
      filename = filename.replace(`.${ext}`, `_trimmed.${ext}`);
    }

    // Stream file to client
    const stat = await fs.stat(finalFile);
    
    res.setHeader('Content-Type', mode === 'audio' && ext === 'mp3' ? 'audio/mpeg' : `video/${ext}`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');

    // Stream file in chunks
    const stream = (await import('fs')).createReadStream(finalFile);
    stream.pipe(res);

    // Clean up temp file after streaming
    stream.on('end', async () => {
      try {
        await fs.unlink(finalFile);
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    });

    stream.on('error', async (error) => {
      console.error('Stream error:', error);
      try {
        await fs.unlink(finalFile);
      } catch (e) {}
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error' });
      }
    });

  } catch (error) {
    console.error('Download error:', error);
    
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Helper: Validate YouTube URL
function isValidYouTubeUrl(url) {
  try {
    const urlObj = new URL(url);
    return /youtube\.com|youtu\.be/.test(urlObj.hostname);
  } catch {
    return false;
  }
}

// Helper: Sanitize filename
function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9\-_ ]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

// Helper: Get video info using yt-dlp
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-warnings', url];
    const proc = spawn(YT_DLP_PATH, args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to fetch video info: ${stderr}`));
      } else {
        try {
          const info = JSON.parse(stdout);
          resolve({
            id: info.id,
            title: info.title,
            duration: info.duration,
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            upload_date: info.upload_date,
          });
        } catch (e) {
          reject(new Error('Failed to parse video info'));
        }
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`yt-dlp error: ${error.message}`));
    });
  });
}

// Helper: Download video using yt-dlp
function downloadVideo(url, format, ext, outputPath, mode, bitrate, container) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', format,
      '--merge-output-format', ext,
    ];

    // Add audio conversion for MP3
    if (mode === 'audio' && container === 'mp3') {
      args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', `${bitrate}K`);
    }

    args.push('-o', outputPath, url);

    const proc = spawn(YT_DLP_PATH, args);

    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log progress
      const progress = /\[download\]\s+(\d+\.\d+)%/.exec(data.toString());
      if (progress) {
        console.log(`Download progress: ${progress[1]}%`);
      }
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Download failed: ${stderr}`));
      } else {
        // Verify file exists
        try {
          await fs.access(outputPath);
          resolve();
        } catch {
          reject(new Error('Downloaded file not found'));
        }
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`yt-dlp error: ${error.message}`));
    });
  });
}

// Helper: Trim video using ffmpeg
function trimVideo(inputPath, outputPath, start, end) {
  return new Promise((resolve, reject) => {
    const args = [];

    if (start) {
      args.push('-ss', start);
    }

    args.push('-i', inputPath);

    if (end) {
      args.push('-to', end);
    }

    args.push('-c', 'copy', outputPath);

    const proc = spawn(FFMPEG_PATH, args);

    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Trim failed: ${stderr}`));
      } else {
        try {
          await fs.access(outputPath);
          resolve();
        } catch {
          reject(new Error('Trimmed file not found'));
        }
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`ffmpeg error: ${error.message}`));
    });
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 YouTube Downloader API running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📥 Download endpoint: http://localhost:${PORT}/download`);
  console.log(`ℹ️  Info endpoint: http://localhost:${PORT}/info`);
});
