import { useEffect, useState } from "react";
import { Download, Share2, Sparkles, X } from "lucide-react";
import type { TokenDetail, TokenSummary } from "../../shared/types.js";
import { formatPercent, formatPrice, formatTokens, formatUsd, shortNumber, truncateAddress } from "../../shared/format.js";
import { Button, Modal } from "./ui.js";

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

async function makePnlCard(
  token: TokenSummary,
  amountMicro: number,
  costMicro: number,
  wallet: string | null,
): Promise<string> {
  await document.fonts.ready.catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable.");
  const value = (amountMicro * token.priceMicro) / 1_000_000;
  const pnl = value - costMicro;
  const roi = costMicro > 0 ? (pnl / costMicro) * 10_000 : 0;
  const positive = pnl >= 0;
  const pnlColor = positive ? "#c9f45d" : "#ff7a59";
  const brandAccent = "#c9f45d";
  const dark = "#0c0e0d";
  const ink = "#f0f4ea";
  const muted = "#8c9588";
  const line = "rgba(238,244,231,0.14)";

  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, 1200, 630);
  ctx.strokeStyle = "rgba(238,244,231,0.055)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= 1200; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 630);
    ctx.stroke();
  }
  for (let y = 0; y <= 630; y += 60) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(1200, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(201,244,93,0.22)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(34.5, 34.5, 1131, 561);
  ctx.fillStyle = brandAccent;
  ctx.fillRect(34, 34, 168, 4);
  ctx.fillRect(34, 591, 1131, 4);
  ctx.beginPath();
  ctx.arc(1078, 80, 94, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(201,244,93,0.12)";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(1078, 80, 64, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = brandAccent;
  ctx.font = '800 26px "Geist Variable", Arial, sans-serif';
  ctx.fillText("GitFi", 64, 86);
  ctx.fillStyle = ink;
  ctx.fillText(".fun", 128, 86);
  ctx.fillStyle = muted;
  ctx.font = '500 12px "Geist Mono Variable", monospace';
  ctx.fillText("REPO POSITION / PUBLIC CODE, PRICED IN PUBLIC", 64, 108);
  ctx.textAlign = "right";
  ctx.fillText(
    new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase(),
    1135,
    86,
  );
  ctx.textAlign = "left";

  const logo = await loadImage(token.logoUrl);
  const logoX = 64;
  const logoY = 154;
  if (logo) {
    ctx.save();
    roundedRect(ctx, logoX, logoY, 104, 104, 20);
    ctx.clip();
    ctx.drawImage(logo, logoX, logoY, 104, 104);
    ctx.restore();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    roundedRect(ctx, logoX + 0.5, logoY + 0.5, 103, 103, 20);
    ctx.stroke();
  } else {
    ctx.fillStyle = "#171b18";
    roundedRect(ctx, logoX, logoY, 104, 104, 20);
    ctx.fill();
    ctx.fillStyle = brandAccent;
    ctx.font = '800 38px "Geist Variable", Arial, sans-serif';
    ctx.fillText(token.ticker.slice(0, 2), logoX + 24, logoY + 66);
  }

  ctx.fillStyle = ink;
  ctx.font = '700 48px "Geist Variable", Arial, sans-serif';
  ctx.fillText(`$${token.ticker}`, 194, 198);
  ctx.fillStyle = muted;
  ctx.font = '500 20px "Geist Variable", Arial, sans-serif';
  ctx.fillText(token.repo.fullName, 196, 228);
  ctx.fillStyle = "rgba(238,244,231,0.1)";
  roundedRect(ctx, 196, 242, 118, 24, 12);
  ctx.fill();
  ctx.fillStyle = brandAccent;
  ctx.font = '600 11px "Geist Mono Variable", monospace';
  ctx.fillText(
    token.verification === "verified" ? "README VERIFIED" : "COMMUNITY INDEXED",
    208,
    258,
  );
  ctx.fillStyle = muted;
  ctx.fillText(`TIER / ${token.tier.toUpperCase()}`, 330, 258);

  ctx.fillStyle = muted;
  ctx.font = '600 12px "Geist Mono Variable", monospace';
  ctx.fillText("UNREALIZED P&L", 64, 338);
  ctx.fillStyle = pnlColor;
  ctx.font = '700 104px "Geist Variable", Arial, sans-serif';
  ctx.fillText(`${positive ? "+" : "−"}${formatUsd(Math.abs(pnl)).replace("$", "$")}`, 60, 440);
  ctx.fillStyle = positive ? pnlColor : "#ff9d86";
  ctx.font = '600 27px "Geist Mono Variable", monospace';
  ctx.fillText(`${positive ? "+" : ""}${formatPercent(roi, { decimals: 1 })}`, 66, 480);

  const metrics: Array<[string, string]> = [
    ["POSITION", `${formatTokens(amountMicro, { compact: true })} ${token.ticker}`],
    ["ENTRY", formatPrice(costMicro > 0 ? (costMicro * 1_000_000) / amountMicro : 0)],
    ["MARK", formatPrice(token.priceMicro)],
    ["STARS", `${shortNumber(token.repo.stars)} ★`],
  ];
  metrics.forEach(([label, val], index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 660 + col * 240;
    const y = 348 + row * 88;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 208, y);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.font = '600 11px "Geist Mono Variable", monospace';
    ctx.fillText(label, x, y + 24);
    ctx.fillStyle = ink;
    ctx.font = '600 20px "Geist Variable", Arial, sans-serif';
    ctx.fillText(val, x, y + 54);
  });

  ctx.strokeStyle = line;
  ctx.beginPath();
  ctx.moveTo(64, 522);
  ctx.lineTo(1135, 522);
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.font = '600 16px "Geist Mono Variable", monospace';
  ctx.fillText(wallet ? truncateAddress(wallet, 12, 8) : "GITFI TRADER", 64, 554);
  ctx.fillStyle = muted;
  ctx.font = '500 12px "Geist Mono Variable", monospace';
  ctx.fillText(
    token.status === "graduated" ? "GRADUATED ON-CHAIN MARKET" : `BONDING CURVE / ${formatPercent(token.progressBps, { decimals: 0 })} TO GRADUATION`,
    64,
    578,
  );
  ctx.textAlign = "right";
  ctx.fillStyle = brandAccent;
  ctx.fillText("GITFI.FUN", 1135, 554);
  ctx.fillStyle = muted;
  ctx.fillText("NOT FINANCIAL ADVICE", 1135, 578);
  ctx.textAlign = "left";
  ctx.save();
  ctx.translate(1052, 138);
  ctx.rotate(-0.08);
  ctx.strokeStyle = "rgba(201,244,93,0.36)";
  ctx.lineWidth = 2;
  ctx.strokeRect(-82, -16, 164, 32);
  ctx.fillStyle = "rgba(201,244,93,0.62)";
  ctx.font = '700 10px "Geist Mono Variable", monospace';
  ctx.textAlign = "center";
  ctx.fillText("SIGNED BY GITFI", 0, 4);
  ctx.restore();

  return canvas.toDataURL("image/png");
}

export function PnlShareButton({
  token,
  amountMicro,
  costMicro,
  wallet,
}: {
  token: TokenSummary;
  amountMicro: number;
  costMicro: number;
  wallet: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    makePnlCard(token, amountMicro, costMicro, wallet)
      .then(setUrl)
      .finally(() => setLoading(false));
  }, [open, token, amountMicro, costMicro, wallet]);

  const value = (amountMicro * token.priceMicro) / 1_000_000;
  const pnl = value - costMicro;

  const share = () => {
    const text = `${pnl >= 0 ? "+" : ""}${formatPercent(costMicro ? (pnl / costMicro) * 10_000 : 0)} on $${token.ticker} · ${token.repo.fullName} on @GitFiFun. Public code, priced in public.`;
    window.open(
      `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(window.location.href)}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const download = () => {
    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `gitfi-${token.ticker.toLowerCase()}-pnl.png`;
    anchor.click();
  };

  return (
    <>
      <Button size="xs" variant="secondary" onClick={() => setOpen(true)} icon={<Sparkles size={12} />}>
        Share PnL
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Position flex card" size="lg">
        <div className="pnl-modal">
          {loading ? (
            <div className="pnl-loading"><Sparkles size={22} className="spin-slow" /><span>Rendering card…</span></div>
          ) : (
            <img src={url} alt={`${token.ticker} PnL card`} className="pnl-preview" />
          )}
          <div className="pnl-actions">
            <Button variant="primary" onClick={download} disabled={!url} icon={<Download size={14} />}>Download PNG</Button>
            <Button variant="secondary" onClick={share} icon={<Share2 size={14} />}>Share on X</Button>
            <span className="mono">1200×630 · WATERMARKED</span>
          </div>
        </div>
      </Modal>
    </>
  );
}
