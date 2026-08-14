import { expandInlineLabels } from "../supabase/functions/_shared/credentialText.ts";

const input = [
  "SFTP",
  "Host\t\tsftp.example.com",
  "Username\tdeploy",
  "Password\tFak3-Placeholder-Sftp-02",
].join("\n");

console.log("--- expanded ---");
console.log(expandInlineLabels(input));
console.log("--- end ---");
