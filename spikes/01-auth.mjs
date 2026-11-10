// Spike 01: can we get a sandbox token, and does the app have the scopes Second Key needs?

import { getAccessToken, tokenScopes, BASE_URL } from "./lib/paypal.mjs";

await getAccessToken();
const scopes = tokenScopes();

const want = [
  ["Orders / payments", (s) => s.includes("https://uri.paypal.com/services/payments/payment")],
  ["Vault (saved wallets)", (s) => s.includes("vault")],
  ["Disputes", (s) => s.includes("disputes")],
];

console.log(`Token OK against ${BASE_URL} (${scopes.length} scopes)\n`);
for (const [name, test] of want) {
  const found = scopes.filter(test);
  console.log(`${found.length ? "✔" : "✘"} ${name}${found.length ? "" : "  <- not in token scopes"}`);
  for (const s of found) console.log(`    ${s}`);
}
console.log(
  "\nIf Vault is missing: Developer Dashboard > your sandbox app > Features > enable Vault, then rerun.\n" +
    "Scope names vary; a missing line is a hint to check, not proof the API is unavailable.",
);
