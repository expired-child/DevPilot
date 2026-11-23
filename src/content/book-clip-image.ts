import { webUrl } from '../modules/book-clip/types';

const maxBytes = 8 * 1024 * 1024;
const imageTypes = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
  ['image/avif', 'avif'], ['image/svg+xml', 'svg'], ['image/bmp', 'bmp'], ['image/x-icon', 'ico'],
  ['image/vnd.microsoft.icon', 'ico'], ['image/tiff', 'tif'], ['image/apng', 'png'],
]);

export async function readBookImage(href: string): Promise<{ extension: string; base64: string }> {
  const url = webUrl(href);
  if (!url) throw new Error('不支持此图片地址');
  const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(10_000) });
  try {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    const extension = imageTypes.get(mime);
    if (!extension || !response.body) throw new Error('服务器未返回支持的图片类型');
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('超过单张 8 MiB 限制');
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > maxBytes) throw new Error('超过单张 8 MiB 限制');
        chunks.push(Uint8Array.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (!bytes) throw new Error('图片内容为空');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const file = new FileReader();
      file.onload = () => resolve(String(file.result));
      file.onerror = () => reject(new Error('无法读取图片数据'));
      file.readAsDataURL(new Blob(chunks, { type: mime }));
    });
    return { extension, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  } finally {
    if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
  }
}
