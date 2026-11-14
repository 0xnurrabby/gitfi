import { ArrowRight, ShieldCheck } from "lucide-react";
import { useAuth } from "../contexts/AuthContext.js";
import { BrandMark } from "./Brand.js";
import { Button, Modal } from "./ui.js";

export function AuthModal() {
  const { authOpen, closeAuth, connectNear, connecting, connectError, platform } = useAuth();

  return (
    <Modal open={authOpen} onClose={closeAuth} size="sm" hideClose={false} className="auth-modal-compact" title={null}>
      <div className="auth-compact">
        <BrandMark size={30} />
        <div className="eyebrow">NEAR {platform?.network ?? "testnet"} · NEP-413</div>
        <h2>Connect your wallet</h2>
        <p>Sign in with a NEAR wallet to launch, trade and claim.</p>
        {connectError ? <div className="form-error">{connectError}</div> : null}
        <Button
          size="lg"
          variant="primary"
          onClick={connectNear}
          loading={connecting}
          className="auth-compact-cta"
          iconRight={<ArrowRight size={16} />}
        >
          {connecting ? "Waiting for wallet…" : "Connect NEAR wallet"}
        </Button>
        <div className="auth-compact-note">
          <ShieldCheck size={12} />
          <span>Meteor · Intear · Nightly · Ledger · NEAR CLI</span>
        </div>
      </div>
    </Modal>
  );
}
