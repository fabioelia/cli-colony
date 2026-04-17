import { File, FileCode, FileJson, FileText, FileImage, FileVideo, FileAudio, FileArchive, FileTerminal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const EXT_MAP: Record<string, LucideIcon> = {
  ts: FileCode, tsx: FileCode, js: FileCode, jsx: FileCode,
  py: FileCode, go: FileCode, rs: FileCode, rb: FileCode,
  java: FileCode, c: FileCode, cpp: FileCode, h: FileCode,
  vue: FileCode, svelte: FileCode, swift: FileCode, kt: FileCode,
  html: FileCode, css: FileCode, scss: FileCode, less: FileCode,
  json: FileJson,
  yaml: FileText, yml: FileText, toml: FileText, xml: FileText,
  md: FileText, txt: FileText, pdf: FileText, doc: FileText, docx: FileText,
  csv: FileText, env: FileText, ini: FileText, conf: FileText,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage,
  svg: FileImage, webp: FileImage, ico: FileImage, bmp: FileImage,
  mp4: FileVideo, mov: FileVideo, avi: FileVideo, webm: FileVideo,
  mp3: FileAudio, wav: FileAudio, ogg: FileAudio, flac: FileAudio,
  zip: FileArchive, tar: FileArchive, gz: FileArchive, rar: FileArchive,
  sh: FileTerminal, bash: FileTerminal, zsh: FileTerminal, fish: FileTerminal,
}

export function getFileIcon(filename: string): LucideIcon {
  const ext = filename.split('.').pop()?.toLowerCase()
  return (ext && EXT_MAP[ext]) || File
}
