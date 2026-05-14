import { mkdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

type Dimensions = {
  height: number;
  width: number;
};

type Wallpaper = {
  aspectRatio: string;
  bytes: number;
  colors: string[];
  fileName: string;
  format: "png";
  height: number;
  imageUrl: string;
  name: string;
  path: string;
  previewBytes: number;
  previewHeight: number;
  previewPath: string;
  previewUrl: string;
  previewWidth: number;
  slug: string;
  width: number;
};

const PREVIEW_HEIGHT = 267;
const PREVIEW_WIDTH = 534;
const README_END = "<!-- /wallpapers -->";
const README_START = "<!-- wallpapers -->";
const REPO_RAW_BASE_URL = "https://raw.githubusercontent.com/beeman/solana-mobile-wallpapers/main";
const ROOT_DIR = join(import.meta.dir, "..");
const README_PATH = join(ROOT_DIR, "README.md");
const WALLPAPERS_JSON_PATH = join(ROOT_DIR, "wallpapers.json");
const WALLPAPERS_DIR = join(ROOT_DIR, "wallpapers");
const PREVIEWS_DIR = join(ROOT_DIR, "previews");

type BunImagePipeline = {
  png: () => BunImagePipeline;
  resize: (width: number, height: number, options: { filter: "mitchell" }) => BunImagePipeline;
  write: (path: string) => Promise<number>;
};

type BunFile = ReturnType<typeof Bun.file>;

function createAspectRatio({ height, width }: Dimensions) {
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function createName(slug: string) {
  return slug
    .replace(/-\d+x\d+$/, "")
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function createImageUrl(path: string) {
  return `${REPO_RAW_BASE_URL}/${path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function createReadmeSection(wallpapers: Wallpaper[]) {
  const rows = wallpapers
    .map((wallpaper) => {
      return `| ${wallpaper.name} | ![${wallpaper.name}](${wallpaper.previewPath}) | [Download](${wallpaper.imageUrl}) | ${wallpaper.width}x${wallpaper.height} | ${wallpaper.colors.join(", ") || "Mixed"} |`;
    })
    .join("\n");

  return [
    README_START,
    "## Wallpapers",
    "",
    `Generated from [wallpapers.json](wallpapers.json).`,
    "",
    "| Name | Preview | Image | Size | Colors |",
    "| --- | --- | --- | --- | --- |",
    rows,
    README_END,
  ].join("\n");
}

function detectColors(slug: string) {
  const colors = [];

  if (slug.includes("green")) {
    colors.push("#14F195");
  }

  if (slug.includes("purple")) {
    colors.push("#9945FF");
  }

  if (slug.includes("gradient")) {
    colors.push("#14F195", "#9945FF");
  }

  return [...new Set(colors)].sort();
}

function getPngDimensions(bytes: Uint8Array): Dimensions {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const hasPngSignature = pngSignature.every((byte, index) => bytes[index] === byte);

  if (!hasPngSignature) {
    throw new Error("Invalid PNG signature");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    height: view.getUint32(20),
    width: view.getUint32(16),
  };
}

function greatestCommonDivisor(left: number, right: number): number {
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }

  return left;
}

async function listWallpapers() {
  const files = [];

  for await (const entry of new Bun.Glob("*.png").scan({
    absolute: true,
    cwd: WALLPAPERS_DIR,
    onlyFiles: true,
  })) {
    files.push(entry);
  }

  return files.sort((left, right) => basename(left).localeCompare(basename(right)));
}

async function readWallpaper(path: string): Promise<Wallpaper> {
  const file = Bun.file(path);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dimensions = getPngDimensions(bytes);
  const fileName = basename(path);
  const previewPath = join(PREVIEWS_DIR, fileName);
  const previewFile = Bun.file(previewPath);
  const slug = fileName.slice(0, -extname(fileName).length);
  const relativePath = relative(ROOT_DIR, path);
  const relativePreviewPath = relative(ROOT_DIR, previewPath);

  if (!(await previewFile.exists())) {
    await writePreview(path, previewPath);
  }

  const previewBytes = (await Bun.file(previewPath).arrayBuffer()).byteLength;

  return {
    aspectRatio: createAspectRatio(dimensions),
    bytes: bytes.byteLength,
    colors: detectColors(slug),
    fileName,
    format: "png",
    height: dimensions.height,
    imageUrl: createImageUrl(relativePath),
    name: createName(slug),
    path: relativePath,
    previewBytes,
    previewHeight: PREVIEW_HEIGHT,
    previewPath: relativePreviewPath,
    previewUrl: createImageUrl(relativePreviewPath),
    previewWidth: PREVIEW_WIDTH,
    slug,
    width: dimensions.width,
  };
}

async function updateReadme(wallpapers: Wallpaper[]) {
  const section = createReadmeSection(wallpapers);
  const readme = await Bun.file(README_PATH).text();
  const startIndex = readme.indexOf(README_START);
  const endIndex = readme.indexOf(README_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    const separator = readme.trimEnd().length > 0 ? "\n\n" : "";
    await Bun.write(README_PATH, `${readme.trimEnd()}${separator}${section}\n`);
    return;
  }

  const beforeSection = readme.slice(0, startIndex).trimEnd();
  const afterSection = readme.slice(endIndex + README_END.length).trimStart();
  const nextReadme = [beforeSection, section, afterSection].filter(Boolean).join("\n\n");

  await Bun.write(README_PATH, `${nextReadme}\n`);
}

async function updateWallpapersJson(wallpapers: Wallpaper[]) {
  await Bun.write(
    WALLPAPERS_JSON_PATH,
    `${JSON.stringify(
      {
        rawBaseUrl: REPO_RAW_BASE_URL,
        wallpapers,
      },
      null,
      2,
    )}\n`,
  );
}

async function writePreview(sourcePath: string, previewPath: string) {
  const bunFileWithImage = Bun.file(sourcePath) as BunFile & {
    image?: () => BunImagePipeline;
  };

  if (typeof bunFileWithImage.image === "function") {
    await bunFileWithImage
      .image()
      .resize(PREVIEW_WIDTH, PREVIEW_HEIGHT, { filter: "mitchell" })
      .png()
      .write(previewPath);
    return;
  }

  const BunWithImage = Bun as typeof Bun & {
    Image?: new (input: string | BunFile) => BunImagePipeline;
  };

  if (BunWithImage.Image) {
    await new BunWithImage.Image(Bun.file(sourcePath))
      .resize(PREVIEW_WIDTH, PREVIEW_HEIGHT, { filter: "mitchell" })
      .png()
      .write(previewPath);
    return;
  }

  const process = Bun.spawn(["magick", sourcePath, "-resize", `${PREVIEW_WIDTH}x${PREVIEW_HEIGHT}!`, previewPath], {
    stderr: "pipe",
  });
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`Preview resize failed for ${sourcePath}: ${await new Response(process.stderr).text()}`);
  }
}

const wallpaperPaths = await listWallpapers();
await mkdir(PREVIEWS_DIR, { recursive: true });
const wallpapers = await Promise.all(wallpaperPaths.map((path) => readWallpaper(path)));

await updateWallpapersJson(wallpapers);
await updateReadme(wallpapers);

console.log(`Updated ${wallpapers.length} wallpapers.`);
