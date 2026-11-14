export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="brand-mark-svg"
    >
      <rect x="1" y="1" width="62" height="62" rx="15" className="brand-mark-bg" />
      <path d="M21 14v36" className="brand-mark-line" strokeWidth="3.4" strokeLinecap="round" />
      <circle cx="21" cy="14" r="4.7" className="brand-mark-node" />
      <circle cx="21" cy="50" r="4.7" className="brand-mark-node" />
      <path
        d="M21 31h10c5.2 0 9-4 9-9v-3.3"
        className="brand-mark-line"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <circle cx="40" cy="14" r="4.7" className="brand-mark-bg" />
      <circle cx="40" cy="14" r="4.7" className="brand-mark-line" strokeWidth="3" />
      <path d="M27 42h6" className="brand-mark-line" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M33 39l4 3-4 3"
        className="brand-mark-line"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandWord() {
  return (
    <span className="brand-word">
      GitFi<span className="brand-dot">.</span>fun
    </span>
  );
}
