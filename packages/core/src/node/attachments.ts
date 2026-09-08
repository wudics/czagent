import { extname } from 'node:path';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import type { Attachment, MessagePart } from '../provider.js';

export const INLINE_TEXT_LIMIT = 50 * 1024;
const MAX_PARSE_BYTES = 20 * 1024 * 1024;

export function attachmentKind(name: string): string {
  const ext = extname(name).toLowerCase();
  if (['.txt', '.md', '.markdown'].includes(ext)) return 'txt';
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) return 'image';
  return 'other';
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buffer as never });
  return value;
}

async function parseXlsx(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const out: string[] = [];
  wb.eachSheet((sheet) => {
    out.push(`## ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = (row.values as unknown[]).filter((c) => c != null);
      if (cells.length) out.push(cells.join(' | '));
    });
  });
  return out.join('\n');
}

async function parsePptx(buffer: Buffer): Promise<string> {
  const zip = new AdmZip(buffer);
  const slides = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
  const out: string[] = [];
  for (const slide of slides) {
    const xml = slide.getData().toString('utf8');
    const texts = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map((m) => m[1]);
    if (texts.length) out.push(`--- ${slide.entryName} ---\n${texts.join('\n')}`);
  }
  return out.join('\n');
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => (item && 'str' in item && typeof item.str === 'string' ? item.str : ''))
      .join(' ');
    out.push(`--- page ${i} ---\n${text}`);
  }
  return out.join('\n');
}

export async function parseAttachmentToText(attachment: Attachment, buffer: Buffer): Promise<string> {
  if (buffer.byteLength > MAX_PARSE_BYTES) throw new Error('附件过大，无法解析为文本');
  switch (attachment.kind) {
    case 'txt':
      return buffer.toString('utf8');
    case 'docx':
      return parseDocx(buffer);
    case 'xlsx':
      return parseXlsx(buffer);
    case 'pptx':
      return parsePptx(buffer);
    case 'pdf':
      return parsePdf(buffer);
    default:
      throw new Error(`不支持解析为文本: ${attachment.kind}`);
  }
}

/** 图片压缩（最长边 1600 / JPEG 85）并转 data URL */
export async function imageToDataUrl(buffer: Buffer): Promise<string> {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const maxSide = Math.max(meta.width ?? 0, meta.height ?? 0);
  let out = img;
  if (maxSide > 1600) {
    out = img.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true });
  }
  const jpeg = await out.jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

/** 按混合策略把解析结果转成 user 消息 part（决策 12） */
export function textToMessagePart(attachment: Attachment, text: string): MessagePart {
  if (Buffer.byteLength(text, 'utf8') <= INLINE_TEXT_LIMIT) {
    return {
      type: 'text',
      text: `<已上传附件: ${attachment.name}（内容已内联，无需读取文件）>\n<文件内容开始>\n${text}\n<文件内容结束>`,
    };
  }
  return { type: 'file', name: attachment.name, kind: attachment.kind, path: attachment.storedPath };
}
