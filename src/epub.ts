/**
 * EPUB 解析：fflate 解压 → container.xml 定位 OPF → 解析 manifest/spine → 章节列表。
 * 解析产物（章节 HTML）缓存在 library/<bookId>/，运行时按章懒读取。
 */
import { unzipSync, strFromU8 } from 'fflate';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { EpubChapter, EpubManifest } from './shared/types.ts';

/** 从 zip 内提取 package.opf 路径（META-INF/container.xml）。 */
export function locateOpf(files: Record<string, Uint8Array>): string {
  const container = files['META-INF/container.xml'];
  if (container === undefined) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  const xml = strFromU8(container);
  const match = /full-path\s*=\s*"([^"]+)"/.exec(xml);
  if (match === null || match[1] === undefined || match[1] === '') {
    throw new Error('container.xml 中未找到 rootfile full-path');
  }
  return match[1];
}

/** 简易 XML 标签属性读取（EPUB 的 OPF/NCX 结构简单，不值得引完整 XML 库）。 */
export function readTags(xml: string, name: string): Array<Record<string, string>> {
  const results: Array<Record<string, string>> = [];
  const pattern = new RegExp(`<${name}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${name}>)`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const attrs: Record<string, string> = {};
    const attrPattern = /([a-zA-Z:._-]+)\s*=\s*"([^"]*)"/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrPattern.exec(match[1] ?? '')) !== null) {
      attrs[attr[1]!] = attr[2] ?? '';
    }
    if (match[2] !== undefined) attrs['#text'] = match[2];
    results.push(attrs);
  }
  return results;
}

/** 兼容旧名（内部调用）。 */
const tags = readTags;

/**
 * 把「相对 OPF 的路径」解析为「包内路径（相对书根，用 / 分隔）」。
 * 章节 href、manifest 图片 href、ncx src 全部统一到这套坐标系，
 * 与落盘目录结构和 /asset 的 path 参数一致。
 */
export function resolvePackagePath(opfPath: string, relative: string): string {
  const opfDir = dirname(opfPath);
  return normalize(join(opfDir === '.' ? '' : opfDir, relative)).split(sep).join('/');
}

/** 解析 OPF：元数据 + manifest + spine（线性化后即章节顺序）。 */
export function parseOpf(opfXml: string): EpubManifest {
  // 元数据
  const title = tags(opfXml, 'dc:title')[0]?.['#text']?.trim();
  const author = tags(opfXml, 'dc:creator')[0]?.['#text']?.trim();

  // manifest：id → href
  const manifestItems = tags(opfXml, 'item');
  const byId = new Map<string, { href: string; mediaType: string }>();
  for (const item of manifestItems) {
    const id = item['id'];
    const href = item['href'];
    if (id !== undefined && href !== undefined) {
      byId.set(id, { href: decodeURIComponent(href), mediaType: item['media-type'] ?? '' });
    }
  }

  // spine：itemref 顺序
  const spineRefs = tags(opfXml, 'itemref')
    .map((ref) => ref['idref'])
    .filter((id): id is string => id !== undefined);

  const chapters: EpubChapter[] = [];
  spineRefs.forEach((idref) => {
    const item = byId.get(idref);
    if (item === undefined) return;
    if (!/x?html/i.test(item.mediaType)) return;
    const fileName = item.href.split('/').pop() ?? item.href;
    chapters.push({
      index: chapters.length,
      title: decodeURIComponent(fileName.replace(/\.x?html?$/i, '')),
      href: item.href,
    });
  });

  // spine 为空时回退：把 manifest 里的 html 全部按 href 排序当章节
  if (chapters.length === 0) {
    [...byId.values()]
      .filter((item) => /x?html/i.test(item.mediaType))
      .sort((a, b) => a.href.localeCompare(b.href))
      .forEach((item, index) => {
        const fileName = item.href.split('/').pop() ?? item.href;
        chapters.push({
          index,
          title: decodeURIComponent(fileName.replace(/\.x?html?$/i, '')),
          href: item.href,
        });
      });
  }

  const manifest: EpubManifest = { chapters };
  if (title !== undefined && title !== '') manifest.title = title;
  if (author !== undefined && author !== '') manifest.author = author;
  return manifest;
}

/** 解析 toc.ncx 的 navMap：取 (navLabel text, content src) 列表。
 *  注意：v1 按扁平 navPoint 处理，深层嵌套目录的标题匹配可能取到内层项。 */
export function parseNcxTitles(ncxXml: string): Array<{ title: string; src: string }> {
  const results: Array<{ title: string; src: string }> = [];
  for (const point of tags(ncxXml, 'navPoint')) {
    const inner = point['#text'] ?? '';
    const label = /<text[^>]*>([\s\S]*?)<\/text>/i.exec(inner)?.[1]?.trim();
    const src = /<content[^>]*\ssrc\s*=\s*"([^"]*)"/i.exec(inner)?.[1];
    if (label !== undefined && label !== '' && src !== undefined) {
      results.push({ title: label, src: decodeURIComponent(src.split('#')[0]!) });
    }
  }
  return results;
}

/**
 * 解压 EPUB 到书库目录并生成 manifest。
 * 返回 manifest（含元数据），章节 HTML 文件按包内相对路径落盘到 bookDir。
 */
export async function extractEpub(
  bytes: Uint8Array,
  bookDir: string,
): Promise<EpubManifest> {
  const files = unzipSync(bytes);
  if (files['META-INF/container.xml'] === undefined) {
    throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  }
  const opfPath = locateOpf(files);
  const opfXml = strFromU8(files[opfPath] ?? new Uint8Array());
  if (opfXml === '') throw new Error(`EPUB 缺少 package 文件：${opfPath}`);
  const manifest = parseOpf(opfXml);

  // 统一坐标系：章节 href 从「OPF 相对路径」归一化为「包内路径（相对书根）」，
  // 与 /asset 的 path 参数、落盘文件布局一致。
  const toZipPath = (relative: string): string => resolvePackagePath(opfPath, relative);

  // toc.ncx 标题（ncx 一般与 opf 同目录；src 相对 ncx 所在目录）
  const ncxName = /media-type\s*=\s*"application\/x-dtbncx\+xml"[^>]*?href\s*=\s*"([^"]+)"/i.exec(opfXml)?.[1]
    ?? /href\s*=\s*"([^"]+)"[^>]*?media-type\s*=\s*"application\/x-dtbncx\+xml"/i.exec(opfXml)?.[1];
  const navTitles = new Map<string, string>();
  if (ncxName !== undefined) {
    const ncxPath = toZipPath(decodeURIComponent(ncxName));
    const ncxXml = files[ncxPath] !== undefined ? strFromU8(files[ncxPath]) : '';
    if (ncxXml !== '') {
      const ncxDir = dirname(ncxPath);
      for (const entry of parseNcxTitles(ncxXml)) {
        navTitles.set(normalize(join(ncxDir === '.' ? '' : ncxDir, entry.src)).split(sep).join('/'), entry.title);
      }
    }
  }
  for (const chapter of manifest.chapters) {
    chapter.href = toZipPath(chapter.href);
    const title = navTitles.get(chapter.href);
    if (title !== undefined) chapter.title = title;
  }

  // 章节 HTML 落盘（只写章节需要的文件；资源文件也全量落盘供 /asset 读取）
  await mkdir(bookDir, { recursive: true });
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/')) continue;
    // 防路径穿越：解析后必须仍在 bookDir 内
    const target = normalize(join(bookDir, path));
    if (!target.startsWith(normalize(bookDir) + sep)) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  await writeFile(join(bookDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/** 规范化 zip 内相对路径（供 /asset 与章节读取共用）：拒绝越出书根。 */
export function safeZipPath(bookDir: string, relative: string): string | undefined {
  const target = normalize(join(bookDir, relative));
  if (!target.startsWith(normalize(bookDir) + sep)) return undefined;
  return target;
}
