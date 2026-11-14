export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="brand-mark-svg"
    >
      <path
        d="M16 3 28 10v12L16 29 4 22V10L16 3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M16 10v12M10 13.5v5M22 13.5v5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
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
