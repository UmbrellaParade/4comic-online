const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_VAULT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const VAULT_ROOT = path.resolve(process.argv[2] || process.env.UMBRELLA_PARADE_ROOT || DEFAULT_VAULT_ROOT);
const OUTPUT_PATH = path.join(REPO_ROOT, "seed-idea-stock.json");

const CHARACTER_TAGS = {
  "ヴェル13世": "#UmbrellaParade #ヴェル13世 #未完成のまま進む #まだ息してる #4コマ漫画 #創作漫画",
  "カーラ・マンソン": "#UmbrellaParade #カーラマンソン #カーラの情緒ログ #4コマ漫画 #創作漫画",
  "べるぼ": "#UmbrellaParade #べるぼ #AI創作 #4コマ漫画 #創作漫画",
  "アマモリ": "#UmbrellaParade #アマモリ #記録室 #創作漫画",
  "アマヨミ": "#UmbrellaParade #アマヨミ #雨粒ノート #創作漫画"
};

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function ensureDir(dirPath) {
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

function hashId(value) {
  return crypto.createHash("sha1").update(value, "utf8").digest("hex").slice(0, 16);
}

function relativeVaultPath(filePath) {
  return path.relative(VAULT_ROOT, filePath).replace(/\\/g, "/");
}

function cleanText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function stripQuote(value) {
  return cleanText(value).replace(/^「([\s\S]*)」$/u, "$1");
}

function getMangaDir() {
  const direct = path.join(VAULT_ROOT, "漫画");
  if (ensureDir(direct)) return direct;
  const found = fs.readdirSync(VAULT_ROOT, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.codePointAt(0) === 0x6f2b && entry.name.codePointAt(1) === 0x753b);
  if (!found) throw new Error(`漫画フォルダーが見つかりません: ${VAULT_ROOT}`);
  return path.join(VAULT_ROOT, found.name);
}

function getDirByPrefix(baseDir, prefix) {
  const found = fs.readdirSync(baseDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith(prefix));
  return found ? path.join(baseDir, found.name) : "";
}

function getSection(content, heading) {
  const pattern = new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "mu");
  const match = content.match(pattern);
  return cleanText(match ? match[1] : "");
}

function getBullet(content, label) {
  const pattern = new RegExp(`^-\\s*${label}：\\s*(.*)$`, "mu");
  const match = content.match(pattern);
  return cleanText(match ? match[1] : "");
}

function getPanel(content, panelNumber) {
  const next = panelNumber < 4 ? `###\\s+${panelNumber + 1}コマ目` : "^##\\s+";
  const pattern = new RegExp(`^###\\s+${panelNumber}コマ目\\s*\\n([\\s\\S]*?)(?=${next}|(?![\\s\\S]))`, "mu");
  const match = content.match(pattern);
  return cleanText(match ? match[1] : "");
}

function fileDate(filename) {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_/);
  return match ? match[1] : "";
}

function fileTitle(filename) {
  const withoutExt = filename.replace(/\.md$/i, "");
  const match = withoutExt.match(/^\d{4}-\d{2}-\d{2}_.+?_(.+)$/);
  return cleanText(match ? match[1] : withoutExt);
}

function makeSeedItem({
  sourceKey,
  sourceFile,
  character,
  title,
  subtitle = "",
  theme = "",
  aim = "",
  p1 = "",
  p2 = "",
  p3 = "",
  p4 = "",
  date = "",
  imagePatternName = ""
}) {
  const comparable = [title, subtitle, theme, aim, p1, p2, p3, p4].filter(Boolean).join(" / ");
  const seedId = `old_tool_${hashId([sourceKey, character, title, comparable].join("\n"))}`;
  const createdAt = date ? `${date}T00:00:00.000Z` : "2026-05-15T00:00:00.000Z";
  return {
    id: seedId,
    seedId,
    type: "past",
    productionStatus: "made",
    source: "old_tool_seed",
    createdAt,
    madeAt: createdAt,
    character,
    imagePatternName,
    title: title || "過去ネタ",
    subtitle,
    theme,
    aim,
    pastText: comparable,
    p1,
    p2,
    p3,
    p4,
    fixedHashtags: CHARACTER_TAGS[character] || "#UmbrellaParade #4コマ漫画 #創作漫画",
    ideaHashtags: "",
    createAutoPostText: false,
    includeAutoPostText: false,
    createIdeaHashtags: false,
    includeIdeaHashtags: false,
    platform: "旧ツール",
    date,
    time: "",
    aiProvider: "import",
    aiModel: "old-tool",
    imagePath: "",
    imageFilename: "",
    card: "",
    prompt: "",
    caption: "",
    sourceFile
  };
}

function collectGeneratedStock(mangaDir) {
  const semiAutoDir = getDirByPrefix(mangaDir, "04_");
  const generatedDir = semiAutoDir ? getDirByPrefix(semiAutoDir, "07_") : "";
  const scriptDir = generatedDir ? path.join(generatedDir, "ネタ台本") : "";
  if (!ensureDir(scriptDir)) return [];

  const items = [];
  for (const characterDirent of fs.readdirSync(scriptDir, { withFileTypes: true })) {
    if (!characterDirent.isDirectory()) continue;
    const characterDir = path.join(scriptDir, characterDirent.name);
    for (const filename of fs.readdirSync(characterDir).filter((name) => name.endsWith(".md")).sort()) {
      if (filename.startsWith("README")) continue;
      const filePath = path.join(characterDir, filename);
      const content = readText(filePath);
      const titleFromHeading = cleanText((content.match(/^#\s+(.+)$/m) || [])[1] || "");
      const character = getBullet(content, "キャラクター") || characterDirent.name;
      const title = titleFromHeading || fileTitle(filename);
      items.push(makeSeedItem({
        sourceKey: relativeVaultPath(filePath),
        sourceFile: relativeVaultPath(filePath),
        character,
        title,
        subtitle: getSection(content, "サブコピー"),
        theme: getBullet(content, "テーマ"),
        aim: getSection(content, "狙い"),
        p1: getPanel(content, 1),
        p2: getPanel(content, 2),
        p3: getPanel(content, 3),
        p4: getPanel(content, 4),
        date: fileDate(filename),
        imagePatternName: getBullet(content, "画像パターン").replace(/^-$/, "")
      }));
    }
  }
  return items;
}

function splitNumberedHeadingSections(content, markerRegex) {
  const matches = [...content.matchAll(markerRegex)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : content.length;
    return {
      marker: match[1] || "",
      title: cleanText(match[2] || match[1] || ""),
      body: cleanText(content.slice(start, end))
    };
  });
}

function collectVelSourceIdeas(mangaDir) {
  const velDir = getDirByPrefix(mangaDir, "01_");
  if (!ensureDir(velDir)) return [];
  const filename = fs.readdirSync(velDir).find((name) => /4コマ漫画ネタ_06-15\.md$/u.test(name));
  if (!filename) return [];
  const filePath = path.join(velDir, filename);
  const content = readText(filePath);
  return splitNumberedHeadingSections(content, /^##\s+([⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮])\s+(.+)$/gmu)
    .map((section) => makeSeedItem({
      sourceKey: `${relativeVaultPath(filePath)}#${section.marker}`,
      sourceFile: `${relativeVaultPath(filePath)}#${section.marker}`,
      character: "ヴェル13世",
      title: section.title,
      theme: section.title,
      aim: "読者が自分を責めすぎず、小さな一歩を選べるようにする",
      p1: stripQuote(getPanel(section.body, 1)),
      p2: stripQuote(getPanel(section.body, 2)),
      p3: stripQuote(getPanel(section.body, 3)),
      p4: stripQuote(getPanel(section.body, 4)),
      imagePatternName: "通常衣装"
    }));
}

function collectCarlaSourceIdeas(mangaDir) {
  const carlaDir = getDirByPrefix(mangaDir, "02_");
  if (!ensureDir(carlaDir)) return [];
  const filename = fs.readdirSync(carlaDir).find((name) => /カーラの情緒ログ_4コマ台本10本\.md$/u.test(name));
  if (!filename) return [];
  const filePath = path.join(carlaDir, filename);
  const content = readText(filePath);
  return splitNumberedHeadingSections(content, /^##\s+([①②③④⑤⑥⑦⑧⑨⑩])\s+(.+)$/gmu)
    .map((section) => {
      const lines = {};
      for (const line of section.body.split("\n")) {
        const match = line.match(/^([1-4])\.\s*(.+)$/u);
        if (match) lines[match[1]] = cleanText(match[2]);
      }
      return makeSeedItem({
        sourceKey: `${relativeVaultPath(filePath)}#${section.marker}`,
        sourceFile: `${relativeVaultPath(filePath)}#${section.marker}`,
        character: "カーラ・マンソン",
        title: section.title,
        theme: "感情のブレと本音",
        aim: "強がりと本音の揺れを、共感と笑いで届ける",
        p1: lines[1] || "",
        p2: lines[2] || "",
        p3: lines[3] || "",
        p4: lines[4] || "",
        imagePatternName: "通常衣装"
      });
    });
}

function dedupeItems(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.character}|${item.title}|${item.p1}|${item.p2}|${item.p3}|${item.p4}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => {
    const character = String(a.character).localeCompare(String(b.character), "ja");
    if (character !== 0) return character;
    return String(a.date || "").localeCompare(String(b.date || "")) || String(a.title).localeCompare(String(b.title), "ja");
  });
}

function main() {
  const mangaDir = getMangaDir();
  const items = dedupeItems([
    ...collectGeneratedStock(mangaDir),
    ...collectVelSourceIdeas(mangaDir),
    ...collectCarlaSourceIdeas(mangaDir)
  ]);
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), count: items.length, ideas: items }, null, 2)}\n`, "utf8");
  console.log(`Wrote ${items.length} seed ideas to ${OUTPUT_PATH}`);
}

main();
