// Every rejection carries a stable code, so a verifier's answer can be acted on by machines
// (and shown to people) without parsing messages.

export type Ap2ErrorCode =
  | "malformed_token"
  | "kb_jwt_unsupported"
  | "unsupported_alg"
  | "unsupported_sd_alg"
  | "bad_signature"
  | "malformed_disclosure"
  | "disclosure_duplicate"
  | "disclosure_unreferenced"
  | "digest_reused"
  | "claim_collision"
  | "typ_invalid"
  | "binding_missing"
  | "binding_mismatch"
  | "iat_missing"
  | "expired"
  | "not_yet_valid"
  | "aud_mismatch"
  | "nonce_mismatch"
  | "cnf_missing"
  | "cnf_invalid"
  | "cnf_forbidden"
  | "delegate_payload_invalid"
  | "root_key_unavailable";

export class Ap2Error extends Error {
  readonly code: Ap2ErrorCode;
  constructor(code: Ap2ErrorCode, message: string) {
    super(message);
    this.name = "Ap2Error";
    this.code = code;
  }
}

export const fail = (code: Ap2ErrorCode, message: string): never => {
  throw new Ap2Error(code, message);
};
