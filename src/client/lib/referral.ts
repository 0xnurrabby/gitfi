const REFERRAL_KEY = "gitfi.referral";

try {
  const ref = new URLSearchParams(window.location.search).get("ref");
  if (ref && /^[a-z0-9]{4,16}$/i.test(ref)) {
    localStorage.setItem(REFERRAL_KEY, ref.toUpperCase());
  }
} catch {
}

export function getStoredReferral(): string | null {
  try {
    const value = localStorage.getItem(REFERRAL_KEY);
    return value && /^[A-Z0-9]{4,16}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearStoredReferral(): void {
  try {
    localStorage.removeItem(REFERRAL_KEY);
  } catch {
  }
}
