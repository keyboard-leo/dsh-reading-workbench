/**
 * M0 端到端验收脚本：导入样例书 → 读书架 → 读正文。
 * 用法：node scripts/e2e-check.mjs [port]
 * 前置：DSH 正在运行且插件已加载。
 */
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const port = Number(process.argv[2] ?? 19387);
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.md');
const origin = `http://127.0.0.1:${port}`;

/** 发一次 JSON 请求。 */
function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        setHost: false,
        headers: {
          host: `127.0.0.1:${port}`,
          origin,
          'sec-fetch-site': 'same-origin',
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const imported = await call('POST', '/api/reading-workbench/books', { path: fixture });
check('导入样例书', imported.status === 200 && imported.body.ok === true, `status=${imported.status}`);
const bookId = imported.body?.data?.id;
console.log(`      书名: ${imported.body?.data?.title}  id=${bookId}`);

const list = await call('GET', '/api/reading-workbench/books');
check('书架列表包含新书', Array.isArray(list.body?.data) && list.body.data.some((entry) => entry.book.id === bookId), `共 ${list.body?.data?.length} 本`);

const content = await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(bookId)}`);
check('读取正文', content.status === 200 && content.body?.data?.content?.includes('阅读工作台'), `长度 ${content.body?.data?.content?.length} 字符`);

const progress = await call('PUT', '/api/reading-workbench/progress', { bookId, anchor: 'line:3:0', percent: 12 });
check('保存进度', progress.status === 200 && progress.body?.data?.saved === true, `status=${progress.status}`);

const highlight = await call('POST', '/api/reading-workbench/highlights', { bookId, text: '这是一本用于验证阅读工作台功能的最小样例。', anchor: 'line:3:0:3:20' });
check('创建划线', highlight.status === 200 && typeof highlight.body?.data?.id === 'string', `status=${highlight.status}`);
const highlightId = highlight.body?.data?.id;

const highlights = await call('GET', `/api/reading-workbench/highlights?bookId=${encodeURIComponent(bookId)}`);
check('划线列表', Array.isArray(highlights.body?.data) && highlights.body.data.length >= 1, `共 ${highlights.body?.data?.length} 条`);

const removedHighlight = await call('DELETE', `/api/reading-workbench/highlight?id=${encodeURIComponent(highlightId)}`);
check('删除划线（清理测试数据）', removedHighlight.status === 200 && removedHighlight.body?.data?.removed === true, `status=${removedHighlight.status}`);

// 浏览器文件选择器通道（上传内容建书）
const uploadedBook = await call('POST', '/api/reading-workbench/books/upload', {
  title: '上传验收书',
  format: 'md',
  content: '# 上传验收\n\n这是走浏览器通道导入的内容。\n',
});
check('上传导入（浏览器通道）', uploadedBook.status === 200 && uploadedBook.body?.ok === true, `status=${uploadedBook.status}`);
const uploadedId = uploadedBook.body?.data?.id;
const uploadedContent = await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(uploadedId)}`);
check('上传内容可读', uploadedContent.body?.data?.content?.includes('上传验收') === true, `长度 ${uploadedContent.body?.data?.content?.length}`);
const removedUpload = await call('POST', '/api/reading-workbench/books/remove', { bookId: uploadedId });
check('移除上传书（清理测试数据）', removedUpload.status === 200 && removedUpload.body?.data?.removed === true, `status=${removedUpload.status}`);

console.log(allPass ? '\nM0 端到端全部通过' : '\n存在失败项');
process.exit(allPass ? 0 : 1);
