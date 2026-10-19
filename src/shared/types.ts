/**
 * Host / Client 共享类型与常量。
 * 纯类型与字面量，无 Node 或浏览器依赖，两侧构建共享此文件。
 */

/** 数据 schema 版本（未来迁移用）。 */
export const SCHEMA_VERSION = 1 as const;

/**
 * 书籍格式。
 * - md/txt/html 走「单文件 + 虚拟单元 / 重排」模型；
 * - epub/mobi/web 走**章节模型**（`library/<id>/manifest.json` + 按章加载）；
 * - pdf 走页码模型（客户端 pdf.js 渲染）。
 *
 * `web` 是「网页书源」：抓取后把正文快照成本地章节书（不保留原站任何标签）。
 */
export type BookFormat = 'md' | 'txt' | 'html' | 'epub' | 'mobi' | 'pdf' | 'web';

/**
 * 是否为「章节书」格式（有 manifest.json、按 `?chapter=n` 逐章加载）。
 *
 * 收敛这个判定的原因：宿主/客户端原本在 5 处各自硬编码 `epub || mobi`，
 * 新增第三种章节格式（web）时漏改任何一处都会让阅读链路走进文本分支，
 * 表现为「书能打开但正文为空 / 报 ENOENT」这类难查的问题。
 * @param format - 书籍格式。
 * @returns 是否是章节书。
 */
export function isChapteredFormat(format: BookFormat): boolean {
  return format === 'epub' || format === 'mobi' || format === 'web';
}

/** 书目条目。 */
export interface Book {
  /** 稳定 id（UUID）。 */
  id: string;
  title: string;
  author?: string;
  /** 导入来源的绝对路径（原文件保留，不移动不删除）。 */
  sourcePath: string;
  format: BookFormat;
  addedAt: number;
  /**
   * 是否有可提取的真实封面（导入时探测；仅 epub/mobi 可能为 true）。
   * 无封面时客户端渲染生成式封面（按书名取色的渐变卡）。
   */
  hasCover?: boolean;
  /**
   * 来源类型。缺省（undefined）= `'file'`，与历史数据语义一致 —— 因此老 `data.json` 零迁移。
   * `'web'` 表示由「网页书源」抓取生成（正文是本地快照，不是原站实时内容）。
   */
  source?: 'file' | 'web';
  /** 抓取入口 URL（`source === 'web'` 时存在）。 */
  sourceUrl?: string;
  /** 最近一次抓取完成时间（毫秒）。用于提示「重新抓取可能让旧划线失配」。 */
  fetchedAt?: number;
  /** 站点标识（如 `alicesw`），由站点适配器给出，便于按站统计与改版排查。 */
  siteId?: string;
}

/** 存储路径（只读视图：store / cover 等模块共用，避免各自重复声明）。 */
export interface StorePathsLike {
  dir: string;
  file: string;
  libraryDir: string;
}

/** 阅读进度。 */
export interface ReadingProgress {
  /**
   * 定位串，按格式分派：
   * - md/txt：`line:起始行:起始列`
   * - epub/mobi：`chapter:章节序`（段落偏移后续细化）
   * - pdf：`page:页码`
   */
  anchor: string;
  /** 0-100 粗略百分比。 */
  percent: number;
  updatedAt: number;
}

/** 划线批注。 */
export interface Highlight {
  id: string;
  bookId: string;
  /** 划线原文（单行截取）。 */
  text: string;
  /** 可选笔记。 */
  note?: string;
  /** 定位串：line:起始行:起始列:结束行:结束列。 */
  anchor: string;
  createdAt: number;
}

/**
 * 阅读版式：一屏一页，或左右两页并排。
 * `auto` 由容器宽度决定（宽屏双页、窄屏单页），手选后固定。
 */
export type ReaderColumns = 1 | 2 | 'auto';

/**
 * TXT 重排模式：
 * - `auto`：自动合并「硬折行」（老 txt 常见每行 35~50 字把一段切成多行），按中文小说段落排版；
 * - `preserve`：保留原样换行，每个非空行都是独立段落（渲染层仍统一给段首缩进）。
 * 只对 `format === 'txt'` 生效；md/html/epub 有自己的结构化排版，不受此设置影响。
 */
export type TxtReflowMode = 'auto' | 'preserve';

/** 阅读器设置。 */
export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  /** follow | light | dark（M1 先跟随主题）。 */
  theme: 'follow' | 'light' | 'dark';
  /** 分页栏数（单页 / 双页 / 自适应）。 */
  columns: ReaderColumns;
  /** TXT 换行重排：自动合并折行 / 保留原样换行。见 `TxtReflowMode`。 */
  txtReflow: TxtReflowMode;
}

/** data.json 顶层结构。 */
export interface WorkbenchData {
  schemaVersion: typeof SCHEMA_VERSION;
  books: Book[];
  progress: Record<string, ReadingProgress>;
  highlights: Highlight[];
  settings: { lastOpenedBookId?: string; reader: ReaderSettings };
}

/** EPUB 章节条目（由 spine 顺序生成）。 */
export interface EpubChapter {
  /** 章节序（0 起，spine 顺序）。 */
  index: number;
  /** 展示标题（toc.ncx / OPF title，缺省用文件名）。 */
  title: string;
  /** 包内 HTML 路径（相对书根，可能与锚点拼接）。 */
  href: string;
}

/** EPUB 元数据（导入时解析并缓存为 library/<id>/manifest.json）。 */
export interface EpubManifest {
  title?: string;
  author?: string;
  chapters: EpubChapter[];
}

/** 统一 REST 响应包络：成功。 */
export interface ApiOk<T> {
  ok: true;
  data: T;
}
/** 统一 REST 响应包络：失败。 */
export interface ApiErr {
  ok: false;
  error: string;
}
/** 统一 REST 响应包络。 */
export type ApiResponse<T> = ApiOk<T> | ApiErr;

/** 本插件全部 REST 路由前缀。 */
export const API_BASE = '/api/reading-workbench';

/**
 * REST 路由字面量（全部 exact 路由 + query/body 传参，
 * 对齐 skill-explorer 实证形态，不使用路径参数）。
 */
export const ROUTES = {
  health: `${API_BASE}/health`,
  /** GET 列表 / POST 导入（按本地路径） */
  books: `${API_BASE}/books`,
  /** POST，body 携带书名/格式/内容（浏览器文件选择器导入，文本类） */
  booksUpload: `${API_BASE}/books/upload`,
  /** POST，原始字节流上传（epub/mobi/pdf 等二进制；query 传 title/format） */
  booksUploadBinary: `${API_BASE}/books/upload-binary`,
  /** GET ?id= EPUB 章节目录 */
  toc: `${API_BASE}/toc`,
  /** GET ?bookId=&path= 书内资源（图片/字体等二进制，路径穿越受防护） */
  asset: `${API_BASE}/asset`,
  /** GET ?id= 书籍封面图（epub/mobi 提取，缺失时 404 由客户端回落生成式封面） */
  cover: `${API_BASE}/cover`,
  /** GET 读设置 / PUT 写设置 */
  settings: `${API_BASE}/settings`,
  /** GET ?id= 原始书籍文件（pdf.js 等需要二进制的阅读器用） */
  file: `${API_BASE}/file`,
  /** POST，body 携带 bookId（移除书目，不删原文件） */
  booksRemove: `${API_BASE}/books/remove`,
  /** GET ?id= 正文 */
  content: `${API_BASE}/content`,
  /** PUT，body 携带 bookId */
  progress: `${API_BASE}/progress`,
  /** GET ?bookId= / POST 创建 */
  highlights: `${API_BASE}/highlights`,
  /** DELETE ?id= */
  highlight: `${API_BASE}/highlight`,
  /** POST，body 携带 { url }：按网页书源建书（抓目录 + 建 manifest + 抓第 1 章） */
  webSource: `${API_BASE}/sources/web`,
  /** POST，body 携带 { bookId, count? }：按章续抓（每请求最多 5 章，避免单请求超时） */
  webSourceFetch: `${API_BASE}/sources/web/fetch`,
  /** GET ?id= 网页书抓取进度（已抓章数 / 待抓 / 错误清单） */
  webSourceStatus: `${API_BASE}/sources/web/status`,
} as const;

/** 导入请求体。 */
export interface ImportBookRequest {
  /** 本地 md/txt 文件的绝对路径。 */
  path: string;
  /** 可选展示标题（缺省取文件名）。 */
  title?: string;
  author?: string;
}

/** 浏览器文件选择器导入请求体（Host 侧不读本地路径，直接存内容）。 */
export interface UploadBookRequest {
  /** 展示标题（浏览器取自文件名，去掉扩展名）。 */
  title: string;
  /** 格式。 */
  format: BookFormat;
  /** 文件正文（UTF-8）。 */
  content: string;
  author?: string;
}

/** 二进制上传的 query 参数（body 是原始字节流）。 */
export interface UploadBinaryQuery {
  /** 展示标题（浏览器取自文件名）。 */
  title: string;
  /** 格式：epub / mobi / pdf。 */
  format: Extract<BookFormat, 'epub' | 'mobi' | 'pdf'>;
  author?: string;
}

/** 划线创建请求体。 */
export interface CreateHighlightRequest {
  bookId: string;
  text: string;
  note?: string;
  anchor: string;
}

/** 进度保存请求体。 */
export interface SaveProgressRequest {
  bookId: string;
  anchor: string;
  percent: number;
}

/** 阅读设置保存请求体（部分字段，未给字段保持不变）。 */
export interface SaveSettingsRequest {
  reader?: Partial<ReaderSettings>;
  lastOpenedBookId?: string;
}

/** 进度响应（书目列表里内嵌）。 */
export interface BookWithState {
  book: Book;
  progress?: ReadingProgress;
  highlightCount: number;
}

// ---------------------------------------------------------------------------
// 网页书源（format === 'web'）
// ---------------------------------------------------------------------------

/** 目录里的一章：序号 + 展示标题 + 该章正文的绝对 URL。 */
export interface WebChapterRef {
  /** 章序（0 起，按目录出现顺序）。 */
  index: number;
  /** 展示标题。 */
  title: string;
  /** 该章正文页的绝对 URL。 */
  url: string;
}

/** 站点适配器抓出来的目录。 */
export interface WebCatalog {
  title: string;
  author?: string;
  /** 站点标识（与 `Book.siteId` 一致）。 */
  siteId: string;
  chapters: WebChapterRef[];
  /** 建目录过程中值得告知用户但不致命的情况（如书籍页标注章数与实抓不符）。 */
  warnings: string[];
}

/** 抓出来的单章正文。 */
export interface WebChapterBody {
  /** 章标题（可能与目录标题不同，以正文页为准）。 */
  title: string;
  /** 正文段落（已剥标签、反转义、去空段）。 */
  paragraphs: string[];
  /**
   * 正文页给出的「下一章」URL（绝对地址；末章为 undefined）。
   *
   * 用途不只是导航：目标站目录页 135,879 字符会超出抓取后端 100,000 字符上限被**截断**，
   * 目录尾部章节只能靠这条链在抓取过程中**逐章补齐**（见 `fetchWebChapters` 的目录懒扩展）。
   */
  nextUrl?: string;
}

/** 单章的抓取错误（进 `web.json`，供 UI 展示与重试）。 */
export interface WebChapterError {
  index: number;
  url: string;
  /** 面向用户的错误说明（已中文化）。 */
  message: string;
}

/** 抓取状态，落盘在 `library/<id>/web.json`（不放 data.json，避免每次进度保存全量重写）。 */
export interface WebBookState {
  sourceUrl: string;
  siteId: string;
  /** 首次建书时间（毫秒）。 */
  createdAt: number;
  /** 最近一次抓取完成时间（毫秒）。 */
  fetchedAt?: number;
  /** 目录总章数。 */
  total: number;
  /** 已抓到的章序（升序、去重）。 */
  fetched: number[];
  errors: WebChapterError[];
  /**
   * 各章的**源 URL**（与 manifest.chapters 一一对应）。
   *
   * 必须单独存：`manifest.json` 是 EPUB 形状（只有本地 href），不含原站 URL；
   * 而目录懒扩展要靠「下一章 URL 是否已在目录中」判重。
   */
  urls: string[];
}

/** `GET /sources/web/status` 的响应。 */
export interface WebSourceStatus {
  bookId: string;
  total: number;
  /** 已抓章数。 */
  fetched: number;
  /** 待抓章数（total - fetched）。 */
  pending: number;
  errors: WebChapterError[];
  /** 最近一次抓取完成时间。 */
  fetchedAt?: number;
  /**
   * 已抓章节的章序（升序）。
   *
   * 必须单独给出：只报「已抓 3 章」回答不了用户真正关心的问题
   * 「**我想读的那一章**抓了没有」。阅读器的章节目录据此逐章标记状态。
   */
  fetchedIndexes: number[];
}

/** `POST /sources/web` 请求体。 */
export interface ImportWebRequest {
  /** 书目入口 URL（目录页或书籍详情页均可，由适配器判定）。 */
  url: string;
}

/** `POST /sources/web/fetch` 请求体。 */
export interface FetchWebChaptersRequest {
  bookId: string;
  /** 本次抓几章（默认 1，上限见 `WEB_FETCH_MAX_PER_REQUEST`）。 */
  count?: number;
}

/** 单次续抓请求最多抓多少章（沙箱没有计时器，抓取节奏靠请求往返；太大易触发工具超时）。 */
export const WEB_FETCH_MAX_PER_REQUEST = 5;
