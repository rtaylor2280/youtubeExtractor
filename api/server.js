// api/server.js - Local Mac server with extraction logic
import express from "express";
import cors from "cors";
import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import os from 'os';

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow file downloads
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// CORS and body parsing
app.use(cors());
app.use(express.json());

// Trust proxy setting for rate limiting behind router
app.set('trust proxy', 1);

// API Key middleware
function apiKeyMiddleware(req, res, next) {
  const key = req.headers["x-api-key"];
  const validKey = process.env.JMT_API_KEY;

  if (!key || key !== validKey) {
    console.log(`Unauthorized access attempt from ${req.ip} at ${new Date().toISOString()}`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Health check endpoint (no auth required)
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    time: new Date().toISOString(),
    platform: os.platform(),
    arch: os.arch()
  });
});

// Audio extraction endpoint (auth required)
app.post("/api/extract-audio", apiKeyMiddleware, async (req, res) => {
  const {
    videoUrl,
    format = 'mp3',
    startTime,
    endTime
  } = req.body;

  console.log(`Extraction request from ${req.ip}: ${videoUrl}`);

  // Input validation
  if (!videoUrl || typeof videoUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid videoUrl parameter' });
  }

  // Validate URL format (support both youtube.com and youtu.be)
  const urlPattern = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[a-zA-Z0-9_-]{11}/;
  if (!urlPattern.test(videoUrl)) {
    return res.status(400).json({ error: 'Invalid YouTube URL format' });
  }

  // Whitelist and validate format
  const allowedFormats = ['mp3', 'wav'];
  const safeFormat = allowedFormats.includes(format) ? format : 'mp3';

  // Validate and convert time inputs
  let startSeconds = null;
  let endSeconds = null;

  if (startTime) {
    startSeconds = parseTimeToSeconds(startTime);
    if (startSeconds === null) {
      return res.status(400).json({ error: 'Invalid start time format. Use mm:ss or hh:mm:ss' });
    }
  }

  if (endTime) {
    endSeconds = parseTimeToSeconds(endTime);
    if (endSeconds === null) {
      return res.status(400).json({ error: 'Invalid end time format. Use mm:ss or hh:mm:ss' });
    }
  }

  if (startSeconds !== null && endSeconds !== null && startSeconds >= endSeconds) {
    return res.status(400).json({ error: 'Start time must be before end time' });
  }

  // Generate secure temp filename in system temp directory
  const tempId = uuidv4();
  const tempFile = `audio_${tempId}.${safeFormat}`;
  const outputPath = path.join(os.tmpdir(), tempFile);

  let ytDlpProcess = null;
  let ffmpegProcess = null;

  try {
    // Set timeout for the entire operation
    const timeoutMs = 10 * 60 * 1000; // 10 minutes
    const timeoutId = setTimeout(() => {
      if (ytDlpProcess) ytDlpProcess.kill('SIGKILL');
      if (ffmpegProcess) ffmpegProcess.kill('SIGKILL');
      cleanup(outputPath);
      if (!res.headersSent) {
        res.status(408).json({ error: 'Request timeout - file too large or slow connection' });
      }
    }, timeoutMs);

    // Start yt-dlp process with best compatibility settings for Mac
    const ytDlpArgs = [
      '-f', 'bestaudio/best',
      '-o', '-',
      '--no-warnings',
      '--extract-flat', 'false',
      '--no-check-certificates', // Sometimes needed on Mac
      videoUrl
    ];

    // Check if yt-dlp is installed
    const ytDlpCommand = await findExecutable('yt-dlp');
    if (!ytDlpCommand) {
      clearTimeout(timeoutId);
      return res.status(500).json({ 
        error: 'yt-dlp not found. Please install with: brew install yt-dlp' 
      });
    }

    ytDlpProcess = spawn(ytDlpCommand, ytDlpArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Build ffmpeg arguments
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0'
    ];

    // Add time parameters if specified
    if (startSeconds !== null) {
      ffmpegArgs.push('-ss', startSeconds.toString());
    }
    if (endSeconds !== null) {
      ffmpegArgs.push('-to', endSeconds.toString());
    }

    // Add format-specific options
    if (safeFormat === 'wav') {
      ffmpegArgs.push(
        '-acodec', 'pcm_s16le',
        '-ar', '44100',
        '-ac', '1', // mono for saber compatibility
        '-f', 'wav'
      );
    } else {
      ffmpegArgs.push(
        '-acodec', 'libmp3lame',
        '-ab', '320k',
        '-f', 'mp3'
      );
    }

    ffmpegArgs.push(outputPath);

    // Check if ffmpeg is installed
    const ffmpegCommand = await findExecutable('ffmpeg');
    if (!ffmpegCommand) {
      clearTimeout(timeoutId);
      if (ytDlpProcess) ytDlpProcess.kill('SIGKILL');
      return res.status(500).json({ 
        error: 'ffmpeg not found. Please install with: brew install ffmpeg' 
      });
    }

    // Start ffmpeg process
    ffmpegProcess = spawn(ffmpegCommand, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Pipe yt-dlp output to ffmpeg input
    ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

    // Handle errors
    let errorOccurred = false;
    const errorHandler = (error, processName) => {
      if (!errorOccurred) {
        errorOccurred = true;
        clearTimeout(timeoutId);
        console.error(`${processName} error:`, error);
        cleanup(outputPath);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: `Audio extraction failed: ${processName} error` 
          });
        }
      }
    };

    ytDlpProcess.on('error', (error) => errorHandler(error, 'yt-dlp'));
    ffmpegProcess.on('error', (error) => errorHandler(error, 'ffmpeg'));

    ytDlpProcess.stderr.on('data', (data) => {
      console.error('yt-dlp stderr:', data.toString());
    });

    ffmpegProcess.stderr.on('data', (data) => {
      console.error('ffmpeg stderr:', data.toString());
    });

    // Handle yt-dlp process exit
    ytDlpProcess.on('close', (code) => {
      if (code !== 0 && !errorOccurred) {
        console.error(`yt-dlp exited with code ${code}`);
      }
      // Don't close ffmpeg stdin here, let it finish processing
    });

    // Handle ffmpeg process completion
    ffmpegProcess.on('close', async (code) => {
      clearTimeout(timeoutId);
      
      if (errorOccurred || code !== 0) {
        if (!errorOccurred) {
          console.error(`ffmpeg exited with code ${code}`);
          cleanup(outputPath);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Audio extraction failed' });
          }
        }
        return;
      }

      try {
        // Verify file exists and has content
        const stats = await fs.stat(outputPath);
        if (stats.size === 0) {
          throw new Error('Output file is empty');
        }

        console.log(`Successfully extracted audio: ${stats.size} bytes`);

        // Set response headers
        const contentType = safeFormat === 'wav' ? 'audio/wav' : 'audio/mpeg';
        const filename = `extracted_audio.${safeFormat}`;
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        // Stream the file
        const stream = createReadStream(outputPath);
        
        stream.on('error', (streamError) => {
          console.error('Stream error:', streamError);
          cleanup(outputPath);
          if (!res.headersSent) {
            res.status(500).json({ error: 'File streaming failed' });
          }
        });

        stream.on('end', () => {
          cleanup(outputPath);
        });

        stream.pipe(res);

      } catch (fileError) {
        console.error('File handling error:', fileError);
        cleanup(outputPath);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to process output file' });
        }
      }
    });

  } catch (error) {
    console.error('Process spawn error:', error);
    cleanup(outputPath);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start extraction process' });
    }
  }
});

// Catch-all 404 for anything else
app.use((req, res) => {
  console.log(`404 request from ${req.ip}: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

// Start listening 
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Local Extraction API running on http://0.0.0.0:${PORT}`);
  console.log(`Platform: ${os.platform()} ${os.arch()}`);
  console.log(`Node version: ${process.version}`);
  console.log(`Started at: ${new Date().toISOString()}`);
});

/**
 * Find executable in PATH (cross-platform)
 */
async function findExecutable(command) {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const proc = spawn(which, [command], { stdio: 'pipe' });
    
    let output = '';
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0 && output.trim()) {
        resolve(output.trim().split('\n')[0]);
      } else {
        resolve(null);
      }
    });
    
    proc.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Parse time string (mm:ss or hh:mm:ss) to seconds
 */
function parseTimeToSeconds(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  
  const parts = timeStr.split(':').map(part => parseInt(part, 10));
  
  if (parts.some(part => isNaN(part) || part < 0)) {
    return null;
  }

  if (parts.length === 2) {
    // mm:ss format
    const [minutes, seconds] = parts;
    if (seconds >= 60) return null;
    return minutes * 60 + seconds;
  } else if (parts.length === 3) {
    // hh:mm:ss format
    const [hours, minutes, seconds] = parts;
    if (minutes >= 60 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  return null;
}

/**
 * Clean up temporary files
 */
async function cleanup(filePath) {
  try {
    await fs.unlink(filePath);
    console.log(`Cleaned up temp file: ${filePath}`);
  } catch (error) {
    // Ignore cleanup errors but log them
    console.warn('Cleanup warning:', error.message);
  }
}