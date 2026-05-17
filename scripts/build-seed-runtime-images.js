const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const UP_ROOT = path.resolve(REPO_ROOT, "..", "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "seed-runtime-images");
const OUT_JSON = path.join(REPO_ROOT, "seed-runtime-images.json");

function up(...parts) {
  return path.join(UP_ROOT, ...parts);
}

const images = [
  {
    id: "seed_vel13_front",
    character: "ヴェル13世",
    name: "ヴェル13世 正面.png",
    category: "オンライン初期画像/キャラ参考",
    source: up("02_キャラクター資料", "ヴェル13世", "人物画像", "ヴェル13世 正面.png"),
    file: "vel13/vel-front.png"
  },
  {
    id: "seed_vel13_turnaround",
    character: "ヴェル13世",
    name: "ヴェル13世3面図.png",
    category: "オンライン初期画像/3面図",
    source: up("02_キャラクター資料", "ヴェル13世", "人物画像", "ヴェル13世3面図.png"),
    file: "vel13/vel-turnaround.png"
  },
  {
    id: "seed_vel13_right",
    character: "ヴェル13世",
    name: "ヴェル13世 右図.png",
    category: "オンライン初期画像/角度参考",
    source: up("02_キャラクター資料", "ヴェル13世", "人物画像", "ヴェル13世 右図.png"),
    file: "vel13/vel-right.png"
  },
  {
    id: "seed_vel13_left",
    character: "ヴェル13世",
    name: "ヴェル13世左図.png",
    category: "オンライン初期画像/角度参考",
    source: up("02_キャラクター資料", "ヴェル13世", "人物画像", "ヴェル13世左図.png"),
    file: "vel13/vel-left.png"
  },
  {
    id: "seed_vel13_back",
    character: "ヴェル13世",
    name: "ヴェル13世後ろ図.png",
    category: "オンライン初期画像/角度参考",
    source: up("02_キャラクター資料", "ヴェル13世", "人物画像", "ヴェル13世後ろ図.png"),
    file: "vel13/vel-back.png"
  },
  {
    id: "seed_vel13_main_visual",
    character: "ヴェル13世",
    name: "ヴェル13世メインビジュアル.png",
    category: "オンライン初期画像/ビジュアル",
    source: up("02_キャラクター資料", "ヴェル13世", "人物画像", "ヴェル13世メインビジュアル.png"),
    file: "vel13/vel-main-visual.png"
  },
  {
    id: "seed_carla_3d_design",
    character: "カーラ・マンソン",
    name: "カーラ・マンソン デザイン3D.png",
    category: "オンライン初期画像/キャラ参考",
    source: up("02_キャラクター資料", "カーラ・マンソン", "人物画像", "３D", "カーラ・マンソン　デザイン３D.png"),
    file: "carla/carla-3d-design.png"
  },
  {
    id: "seed_carla_chibi_turnaround",
    character: "カーラ・マンソン",
    name: "カーラ ちびキャラ 3面図まとめ.png",
    category: "オンライン初期画像/3面図",
    source: up("02_キャラクター資料", "カーラ・マンソン", "人物画像", "３D", "カーラ、ちびキャラ -3面図まとめ.png"),
    file: "carla/carla-chibi-turnaround.png"
  },
  {
    id: "seed_carla_chibi_front",
    character: "カーラ・マンソン",
    name: "カーラ ちびキャラ 正面.png",
    category: "オンライン初期画像/角度参考",
    source: up("02_キャラクター資料", "カーラ・マンソン", "人物画像", "３D", "カーラ、ちびキャラ -正面.png"),
    file: "carla/carla-chibi-front.png"
  },
  {
    id: "seed_carla_chibi_left",
    character: "カーラ・マンソン",
    name: "カーラ ちびキャラ SIDE 左.png",
    category: "オンライン初期画像/角度参考",
    source: up("02_キャラクター資料", "カーラ・マンソン", "人物画像", "３D", "カーラ、ちびキャラ -SIDE 左.png"),
    file: "carla/carla-chibi-left.png"
  },
  {
    id: "seed_carla_chibi_back",
    character: "カーラ・マンソン",
    name: "カーラ ちびキャラ バック.png",
    category: "オンライン初期画像/角度参考",
    source: up("02_キャラクター資料", "カーラ・マンソン", "人物画像", "３D", "カーラ、ちびキャラ -バック.png"),
    file: "carla/carla-chibi-back.png"
  },
  {
    id: "seed_carla_main_visual",
    character: "カーラ・マンソン",
    name: "カーラメインビジュアル.png",
    category: "オンライン初期画像/ビジュアル",
    source: up("02_キャラクター資料", "カーラ・マンソン", "人物画像", "実写", "カーラメインビジュアル.png"),
    file: "carla/carla-main-visual.png"
  },
  {
    id: "seed_carla_visual",
    character: "カーラ・マンソン",
    name: "カーラビジュアル.png",
    category: "オンライン初期画像/ビジュアル",
    source: up("02_キャラクター資料", "カーラ・マンソン", "人物画像", "実写", "カーラビジュアル.png"),
    file: "carla/carla-visual.png"
  },
  {
    id: "seed_belbo_normal",
    character: "べるぼ",
    name: "べるぼ通常アイコン.png",
    category: "オンライン初期画像/キャラ参考",
    source: up("02_キャラクター資料", "べるぼ", "人物画像", "イラスト作ってもらったもの", "べるぼ通常アイコン.png"),
    file: "belbo/belbo-normal.png"
  },
  {
    id: "seed_belbo_yossha",
    character: "べるぼ",
    name: "べるぼ よっしゃー！アイコン.png",
    category: "オンライン初期画像/表情参考",
    source: up("02_キャラクター資料", "べるぼ", "人物画像", "イラスト作ってもらったもの", "べるぼ よっしゃー！アイコン.png"),
    file: "belbo/belbo-yossha.png"
  },
  {
    id: "seed_belbo_illustration",
    character: "べるぼ",
    name: "べるぼ イラスト.png",
    category: "オンライン初期画像/ビジュアル",
    source: up("02_キャラクター資料", "べるぼ", "人物画像", "イラスト作ってもらったもの", "イラスト.png"),
    file: "belbo/belbo-illustration.png"
  }
];

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside seed folder: ${child}`);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const generatedAt = new Date().toISOString();
const written = [];
const missing = [];

for (const item of images) {
  if (!fs.existsSync(item.source)) {
    missing.push(item.source);
    continue;
  }
  const target = path.resolve(OUT_DIR, item.file);
  assertInside(OUT_DIR, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(item.source, target);
  written.push({
    id: item.id,
    character: item.character,
    name: item.name,
    category: item.category,
    file: item.file.replace(/\\/g, "/"),
    createdAt: generatedAt
  });
}

fs.writeFileSync(OUT_JSON, `${JSON.stringify({ generatedAt, count: written.length, images: written }, null, 2)}\n`, "utf8");

if (missing.length) {
  console.warn(`Missing seed images: ${missing.length}`);
  missing.forEach((file) => console.warn(`- ${file}`));
}

console.log(`Seed runtime images written: ${written.length}`);
