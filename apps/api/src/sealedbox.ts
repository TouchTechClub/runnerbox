import nacl from "tweetnacl";
import { blake2b } from "@noble/hashes/blake2b.js";

/**
 * libsodium-compatible crypto_box_seal, implemented on tweetnacl + blake2b
 * (libsodium-wrappers' ESM build doesn't bundle under wrangler/esbuild).
 *
 * Algorithm (per libsodium docs):
 *   1. Generate an ephemeral X25519 keypair.
 *   2. nonce = BLAKE2b-192(ephemeral_pk ‖ recipient_pk)
 *   3. box = crypto_box(message, nonce, recipient_pk, ephemeral_sk)
 *   4. sealed = ephemeral_pk ‖ box
 */
export function sealedBox(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  const ephemeral = nacl.box.keyPair();
  const nonce = blake2b(
    concat(ephemeral.publicKey, recipientPublicKey),
    { dkLen: nacl.box.nonceLength },
  );
  const box = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);
  return concat(ephemeral.publicKey, box);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
