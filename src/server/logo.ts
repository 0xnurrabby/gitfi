import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { uploadDir } from "./db.js";

export interface SavedLogo {
  logoUrl: string;
  metadataImage: string;
  hash: string;
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 24);
}

export async function saveLogoDataUrl(dataUrl: string): Promise<SavedLogo> {
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) throw new Error("Logo must be a PNG, JPG, WebP, GIF or SVG image.");
  const mime = match[1]!.toLowerCase();
  const raw = Buffer.from(match[2]!.replace(/\s/g, ""), "base64");
  if (raw.length > 6 * 1024 * 1024) throw new Error("Logo must be smaller than 6 MB.");
  if (mime === "svg+xml") {
    const text = raw.toString("utf8");
    if (/<script|onload=|onerror=|<iframe|<foreignObject/i.test(text)) {
      throw new Error("SVG logos cannot contain scripts or embedded HTML.");
    }
  }
  const image = sharp(raw, { limitInputPixels: 4096 * 4096, animated: false }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error("That image could not be read.");
  const buffer = await image
    .resize(512, 512, { fit: "cover", position: "centre" })
    .webp({ quality: 86, effort: 4 })
    .toBuffer();
  const hash = hashBuffer(buffer);
  const filename = `${hash}-512.webp`;
  fs.writeFileSync(path.join(uploadDir, filename), buffer);
  const thumb = await sharp(buffer)
    .resize(128, 128, { fit: "cover" })
    .webp({ quality: 80 })
    .toBuffer();
  fs.writeFileSync(path.join(uploadDir, `${hash}-128.webp`), thumb);
  const logoUrl = `data:image/webp;base64,${buffer.toString("base64")}`;
  return {
    logoUrl,
    metadataImage: logoUrl,
    hash,
  };
}

export async function generateLogo(
  ticker: string,
  seedText: string,
  palette?: [string, string],
): Promise<SavedLogo> {
  const palettes: Array<[string, string]> = [
    ["#c8f464", "#161b15"],
    ["#ff7a59", "#1b1410"],
    ["#78dce8", "#0f171b"],
    ["#f5d36b", "#1e1a0f"],
    ["#b8a7ff", "#16121f"],
    ["#8fe3b0", "#0f1a15"],
  ];
  const digest = crypto.createHash("sha256").update(seedText).digest();
  const colors = palette ?? palettes[digest[0]! % palettes.length]!;
  const initials = ticker.slice(0, 2).toUpperCase();
  const rotation = (digest[1]! % 20) - 10;
  const svg = `
    <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <rect width="512" height="512" rx="92" fill="${colors[1]}"/>
      <g opacity=".18" stroke="${colors[0]}" stroke-width="2">
        ${Array.from({ length: 9 })
          .map((_, i) => `<line x1="${i * 64}" y1="0" x2="${i * 64}" y2="512"/>`)
          .join("")}
        ${Array.from({ length: 9 })
          .map((_, i) => `<line x1="0" y1="${i * 64}" x2="512" y2="${i * 64}"/>`)
          .join("")}
      </g>
      <rect x="62" y="62" width="388" height="388" rx="64" fill="none" stroke="${colors[0]}" stroke-width="3" opacity=".55"/>
      <g transform="rotate(${rotation} 256 256)">
        <text x="256" y="252" text-anchor="middle" dominant-baseline="middle"
          font-family="Arial, Helvetica, sans-serif" font-size="148" font-weight="700"
          letter-spacing="-9" fill="${colors[0]}">${initials}</text>
        <text x="256" y="338" text-anchor="middle" font-family="Courier New, monospace"
          font-size="25" letter-spacing="8" fill="${colors[0]}" opacity=".65">GITFI</text>
      </g>
      <circle cx="408" cy="110" r="12" fill="${colors[0]}"/>
      <circle cx="104" cy="404" r="7" fill="${colors[0]}" opacity=".7"/>
    </svg>`;
  const buffer = await sharp(Buffer.from(svg))
    .resize(512, 512)
    .webp({ quality: 88 })
    .toBuffer();
  const hash = hashBuffer(buffer);
  const filename = `${hash}-512.webp`;
  fs.writeFileSync(path.join(uploadDir, filename), buffer);
  const thumb = await sharp(buffer).resize(128, 128).webp({ quality: 80 }).toBuffer();
  fs.writeFileSync(path.join(uploadDir, `${hash}-128.webp`), thumb);
  const logoUrl = `data:image/webp;base64,${buffer.toString("base64")}`;
  return {
    logoUrl,
    metadataImage: logoUrl,
    hash,
  };
}

export function logoPathFromUrl(url: string): string | null {
  const match = url.match(/^\/cdn\/logo\/([a-zA-Z0-9-]+\.webp)$/);
  if (!match) return null;
  return path.join(uploadDir, match[1]!);
}
