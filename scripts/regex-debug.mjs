const TABULAR_LABEL = new RegExp(
  "^\\s*(" +
    "app(?:lication)?[ _-]?password|password|passwd|pwd|pass" +
    "|passphrase|private[ _-]?key" +
    "|host(?:[ _-]?name)?|server(?:[ _-]?address)?|address|ip(?:[ _-]?address)?" +
    "|port(?:[ _-]?number)?|protocol" +
    "|user(?:[ _-]?name)?|username|account" +
    "|admin(?:[ _-]?(?:url|login|email))?|e-?mail|email|login" +
    "|site(?:[ _-]?url)?|website|domain|url" +
    ")\\s{2,}|\\t+",
  "i",
);

const lines = [
  "Host\t\tsftp.example.com",
  "Username\tdeploy",
  "Password\tFak3-Placeholder-Sftp-02",
];

for (const line of lines) {
  const m = line.match(TABULAR_LABEL);
  console.log(JSON.stringify(line), "=>", m ? { 0: m[0], 1: m[1], rest: line.slice(m[0].length) } : null);
}
